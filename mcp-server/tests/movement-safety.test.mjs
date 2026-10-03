// 拆墙回归：真实 mineflayer-pathfinder（AStar + Movements + 执行循环）、真实 1.21.1 方块数据、内存假世界
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatWorld, createFakeBot, attachTeleportKinematics, legacyMovements, pathTo, goals, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, callsOf, sleep } from './helpers/harness.mjs';
import { protectFromPathfinder } from '../dist/protected-blocks.js';
import { createSafeMovements, prepareBot, ActionDenied } from '../dist/action-policy.js';
import { safeGoto, NoPathError } from '../dist/movement.js';

const WALLS = ['oak_planks', 'oak_log', 'cobblestone', 'stone', 'dirt', 'terracotta'];
const INVENTORY = [['dirt', 32], ['cobblestone', 32], ['stone_pickaxe', 1]];
const GOAL = () => new goals.GoalBlock(6, 64, 0);
const BOT_SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bot-scripts');

// x=3 处一堵两格高的墙，横跨整个已加载区域；墙外是未加载区块，没有绕路
function wallWorld(material, gapZ = null) {
  const w = flatWorld();
  w.fill(3, 64, -16, 3, 65, 15, material);
  if (gapZ !== null) w.fill(3, 64, gapZ, 3, 65, gapZ, 'air');
  return w;
}

function edits(result) {
  return {
    breaks: result.path.flatMap((n) => n.toBreak.map((p) => `${p.x},${p.y},${p.z}`)),
    places: result.path.flatMap((n) => n.toPlace.map((p) => `${p.x},${p.y},${p.z}`)),
  };
}

test('基线：修复前的默认寻路会拆墙或垫方块翻墙（证明测试能发现问题）', () => {
  const planned = {};
  for (const mat of WALLS) {
    const bot = createFakeBot(wallWorld(mat), { inventory: INVENTORY });
    const r = pathTo(bot, legacyMovements(bot, protectFromPathfinder), GOAL());
    const e = edits(r);
    planned[mat] = r.status === 'success' && (e.breaks.length > 0 || e.places.length > 0);
  }
  // 石头/泥土/陶瓦：直接挖开；木板/原木/圆石：不挖但拿背包里的泥土垫脚翻过去
  assert.deepEqual(planned, Object.fromEntries(WALLS.map((m) => [m, true])));
});

test('安全寻路：六种墙挡路且无出口时没有路，计划里没有任何挖/放', () => {
  for (const mat of WALLS) {
    const bot = createFakeBot(wallWorld(mat), { inventory: INVENTORY });
    const r = pathTo(bot, createSafeMovements(bot), GOAL());
    const e = edits(r);
    assert.equal(r.status, 'noPath', `${mat} 不应有路`);
    assert.deepEqual(e, { breaks: [], places: [] }, `${mat} 计划不应含挖/放`);
  }
});

test('执行层：真实 pathfinder 执行循环撞墙后停下，没有底层挖/放调用，墙不变', async () => {
  for (const mat of WALLS) {
    const w = wallWorld(mat);
    const before = w.snapshot(2, 63, -16, 4, 66, 15);
    const bot = createFakeBot(w, { inventory: INVENTORY });
    prepareBot(bot);
    const stop = attachTeleportKinematics(bot);
    try {
      await assert.rejects(safeGoto(bot, GOAL(), { timeoutMs: 3000 }), NoPathError, mat);
      await sleep(100); // 再跑几个 tick，确认失败后不会继续尝试
    } finally {
      stop();
    }
    assert.equal(callsOf(bot, 'dig').length, 0, `${mat} 不应挖`);
    assert.equal(callsOf(bot, 'place').length, 0, `${mat} 不应放`);
    assert.equal(bot.pathfinder.goal, null, `${mat} 失败后应清掉目标`);
    assert.deepEqual(w.snapshot(2, 63, -16, 4, 66, 15), before, `${mat} 墙体方块应完全不变`);
  }
});

test('有绕行通道时能绕过去，墙完全不变', async () => {
  for (const mat of ['oak_planks', 'stone']) {
    const w = wallWorld(mat, 6);
    const before = w.snapshot(2, 63, -16, 4, 66, 15);
    const bot = createFakeBot(w, { inventory: INVENTORY });
    prepareBot(bot);
    const plan = pathTo(bot, createSafeMovements(bot), GOAL());
    assert.equal(plan.status, 'success');
    assert.deepEqual(edits(plan), { breaks: [], places: [] });
    const stop = attachTeleportKinematics(bot);
    try {
      await safeGoto(bot, GOAL(), { timeoutMs: 5000 });
    } finally {
      stop();
    }
    assert.deepEqual(bot.entity.position.floored().toArray(), [6, 64, 0]);
    assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
    assert.deepEqual(w.snapshot(2, 63, -16, 4, 66, 15), before);
  }
});

test('寻路配置被锁死：之后再改 canDig/搭塔/脚手架也无效', () => {
  const bot = createFakeBot(wallWorld('stone'), { inventory: INVENTORY });
  prepareBot(bot);
  const m = legacyMovements(bot);
  bot.pathfinder.setMovements(m);
  m.canDig = true;
  m.allow1by1towers = true;
  m.scafoldingBlocks = [bot.registry.itemsByName.dirt.id];
  assert.equal(bot.pathfinder.movements.canDig, false);
  assert.equal(bot.pathfinder.movements.allow1by1towers, false);
  assert.equal(bot.pathfinder.movements.scafoldingBlocks.length, 0);
  const r = pathTo(bot, bot.pathfinder.movements, GOAL());
  assert.deepEqual(edits(r), { breaks: [], places: [] });
});

test('底层守卫：没有任务授权时 pathfinder 式的直接 dig/place 会被拒绝', async () => {
  const w = wallWorld('stone');
  const bot = createFakeBot(w, { inventory: INVENTORY });
  prepareBot(bot);
  await assert.rejects(bot.dig(bot.blockAt(new Vec3(3, 65, 0)), true), ActionDenied);
  await assert.rejects(bot.placeBlock(bot.blockAt(new Vec3(1, 63, 0)), new Vec3(0, 1, 0)), ActionDenied);
  assert.equal(callsOf(bot, 'dig').length, 0);
  assert.equal(callsOf(bot, 'place').length, 0);
  assert.equal(w.name(3, 65, 0), 'stone');
});

// 站在耕地上时路径节点高度是 x.9375，先取脚所在的格子
const overFarmland = (w, path) => path.filter((n) => w.name(Math.floor(n.x), Math.floor(n.y + 0.1) - 1, Math.floor(n.z)) === 'farmland');

test('尽量不踩农田：旁边不远有石头路时绕过去；没有近路时平地走过去（不跳不落）', () => {
  const w = flatWorld();
  w.fill(3, 63, -16, 3, 63, 15, 'farmland');
  w.fill(3, 63, 2, 3, 63, 2, 'stone');
  const bot = createFakeBot(w);
  const near = pathTo(bot, createSafeMovements(bot), GOAL());
  assert.equal(near.status, 'success');
  assert.equal(overFarmland(w, near.path).length, 0, '有近路时不应经过农田');

  // 5 格宽、横跨整个区域的农田：跳不过去，只能走过去
  w.fill(3, 63, -16, 7, 63, 15, 'farmland');
  const across = pathTo(bot, createSafeMovements(bot), new goals.GoalBlock(10, 64, 0));
  assert.equal(across.status, 'success');
  const onFarm = overFarmland(w, across.path);
  assert.ok(onFarm.length > 0, '没有近路时可以平地穿过');
  let prev = bot.entity.position;
  for (const n of across.path) {
    if (onFarm.includes(n)) assert.ok(prev.y - n.y < 0.2, '进入农田时不能是往下落');
    prev = n;
  }
});

test('follow-player 追不过墙时不挖不垫', async () => {
  const w = wallWorld('dirt');
  const bot = createFakeBot(w, { inventory: INVENTORY });
  bot.players.muxue = { username: 'muxue', entity: { position: new Vec3(6.5, 64, 0.5), height: 1.8, username: 'muxue', isValid: true } };
  const h = createHarness(bot);
  const stop = attachTeleportKinematics(bot);
  try {
    const r = await h.call('follow-player', { username: 'muxue' });
    assert.match(text(r), /开始跟随/);
    await sleep(400);
  } finally {
    stop();
    await h.call('stop-action');
  }
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
  assert.equal(w.name(3, 65, 0), 'dirt');
});

test('move-to-position 过不去时返回失败原因，不拆墙', async () => {
  const w = wallWorld('terracotta');
  const bot = createFakeBot(w, { inventory: INVENTORY });
  const h = createHarness(bot);
  const stop = attachTeleportKinematics(bot);
  let r;
  try {
    r = await h.call('move-to-position', { x: 6, y: 64, z: 0, range: 0, timeoutMs: 3000 });
  } finally {
    stop();
  }
  assert.equal(r.isError, true);
  assert.match(text(r), /找不到不用挖方块、不用垫方块的路/);
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
});

test('项目脚本 travel-to（已迁移到 ctx.goto）遇到墙会停下，不拆墙', async () => {
  const w = wallWorld('stone');
  const before = w.snapshot(2, 63, -16, 4, 66, 15);
  const bot = createFakeBot(w, { inventory: INVENTORY });
  const h = createHarness(bot, { scriptsDir: BOT_SCRIPTS });
  const stop = attachTeleportKinematics(bot);
  let r;
  try {
    r = await h.call('run-script', { name: 'travel-to', params: { x: 10, z: 0 }, timeoutSeconds: 20 });
  } finally {
    stop();
  }
  assert.match(text(r), /走不动了/);
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
  assert.deepEqual(w.snapshot(2, 63, -16, 4, 66, 15), before);
});

test('项目脚本 travel-to 有路时正常到达', async () => {
  const w = wallWorld('stone', 6);
  const bot = createFakeBot(w);
  const h = createHarness(bot, { scriptsDir: BOT_SCRIPTS });
  const stop = attachTeleportKinematics(bot);
  let r;
  try {
    r = await h.call('run-script', { name: 'travel-to', params: { x: 8, z: 0 }, timeoutSeconds: 20 });
  } finally {
    stop();
  }
  assert.match(text(r), /结果：到了/);
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
});

// 高台：x -8..0、z -2..2 垫高 h 格，站在上面 (0.5, 64+h, 0.5)，目标是地面 (5, 64, 0)，只能跳下去
function ledgeBot(h, health) {
  const w = flatWorld();
  w.fill(-8, 64, -2, 0, 63 + h, 2, 'stone');
  const bot = createFakeBot(w, { position: new Vec3(0.5, 64 + h, 0.5) });
  bot.health = health;
  return bot;
}
const GROUND = () => new goals.GoalBlock(5, 64, 0);

test('跳下高处：3 格不扣血随便跳；只扣几点血、血够多时也跳，扣血的跳法代价更高', () => {
  const low = ledgeBot(3, 20);
  const r3 = pathTo(low, createSafeMovements(low), GROUND());
  assert.equal(r3.status, 'success');

  const high = ledgeBot(6, 20); // 摔 6 格扣 3 点
  const r6 = pathTo(high, createSafeMovements(high), GROUND());
  assert.equal(r6.status, 'success', '满血时跳 6 格');
  assert.ok(r6.path.every((n) => !n.toBreak?.length && !n.toPlace?.length));
  assert.ok(r6.cost >= r3.cost + 3 * 5, `扣血的跳法要加代价（${r3.cost} → ${r6.cost}）`);
});

test('跳下高处：血不够或者太高（扣血超过 4 点）就不跳', () => {
  const hurt = ledgeBot(6, 14); // 只能接受扣 2 点
  assert.notEqual(pathTo(hurt, createSafeMovements(hurt), GROUND()).status, 'success');
  const tooHigh = ledgeBot(8, 20); // 摔 8 格扣 5 点
  assert.notEqual(pathTo(tooHigh, createSafeMovements(tooHigh), GROUND()).status, 'success');
  const ok = ledgeBot(5, 14); // 扣 2 点，剩 12
  assert.equal(pathTo(ok, createSafeMovements(ok), GROUND()).status, 'success');
});

test('跳下高处：落进水里不算伤害', () => {
  const w = flatWorld();
  w.fill(-8, 64, -2, 0, 73, 2, 'stone'); // 站在 y74，下面 10 格
  w.fill(1, 63, -1, 6, 63, 1, 'water');
  const bot = createFakeBot(w, { position: new Vec3(0.5, 74, 0.5) });
  const r = pathTo(bot, createSafeMovements(bot), new goals.GoalNear(3, 63, 0, 1));
  assert.equal(r.status, 'success');
});
