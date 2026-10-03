// 组 D：空闲小动作（看风景、换手、锚点附近走几步），被打断立刻停下并冷却。空闲视线的看人规则见 idle-gaze.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pathfinderPkg from 'mineflayer-pathfinder';
import { flatWorld, createFakeBot, attachTeleportKinematics, Vec3 } from './helpers/fake-bot.mjs';
import { tempDir, sleep, createHarness, text } from './helpers/harness.mjs';
import { configurePolicy, prepareBot } from '../dist/action-policy.js';
import { RegionStore } from '../dist/regions.js';
import { startIdleActions } from '../dist/idle.js';
import { socialSettings } from '../dist/social.js';
import { beginActivity, endActivity, beginBody, endBody } from '../dist/task-control.js';

const { goals } = pathfinderPkg;

// 测试用的快节奏：默认不看风景、不换手，只测要测的那一项
const FAST = {
  tickMs: 15,
  quietMs: 30,
  cooldownMs: 600,
  sceneryMinMs: 1e9,
  sceneryMaxMs: 1e9,
  peekMinMs: 1e9,
  peekMaxMs: 1e9,
  swapMinMs: 1e9,
  swapMaxMs: 1e9,
  swapHoldMinMs: 150,
  swapHoldMaxMs: 180,
  walkAfterIdleMs: 60,
  walkMinMs: 40,
  walkMaxMs: 60,
  walkTimeoutMs: 2000,
  lookSteps: 3,
  lookStepMs: 5
};

let cleanup = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  socialSettings.idleActions = true;
  socialSettings.idleLook = true;
});

function setup({ region = null, playerAt = new Vec3(6.5, 64, 6.5), timeOfDay = 1000, timing = {}, inventory = [] } = {}) {
  const regionFile = path.join(tempDir('mcbot-idle-'), 'regions.json');
  const store = new RegionStore(regionFile, 'test-world', 'Claude');
  if (region) store.upsert({ name: 'home', kind: 'home', dimension: 'overworld', ...region, source: '测试' });
  configurePolicy(store);
  const w = flatWorld();
  const bot = createFakeBot(w, { inventory });
  prepareBot(bot);
  bot.time.timeOfDay = timeOfDay;
  bot.quickBarSlot = 0;
  bot.setQuickBarSlot = (n) => {
    bot.quickBarSlot = n;
    bot.calls.push({ type: 'slot', n });
  };
  if (playerAt) {
    const e = { id: 77, type: 'player', name: 'player', username: 'muxue', position: playerAt, height: 1.8 };
    bot.entities[e.id] = e;
    bot.players.muxue = { username: 'muxue', entity: e };
  }
  const stopKin = attachTeleportKinematics(bot);
  const idle = startIdleActions(bot, { ...FAST, ...timing });
  // 记录走过的每个位置
  const visited = [];
  const rec = setInterval(() => visited.push(bot.entity.position.floored()), 3);
  cleanup.push(() => {
    clearInterval(rec);
    stopKin();
    bot.emit('end', 'test');
  });
  return { w, bot, idle, visited };
}

async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

test('白天、附近有真人玩家、空闲时：在锚点 3 格内走一两步，不挖不放', async () => {
  const { bot, idle, visited } = setup();
  await sleep(1500);
  assert.ok(idle.state().walks >= 2, `应该走了几次，实际 ${idle.state().walks}`);
  assert.deepEqual(idle.state().anchor.toArray(), [0, 64, 0]);
  const moved = visited.filter((p) => p.x !== 0 || p.z !== 0);
  assert.ok(moved.length > 0, '位置应该变过');
  for (const p of visited) {
    assert.ok(Math.hypot(p.x, p.z) <= 3, `离锚点超过 3 格：${p}`);
    assert.equal(p.y, 64);
  }
  assert.deepEqual(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place'), []);
});

test('在登记区域里完全不走；锚点在区域外时，目标和路线都不进区域', async () => {
  const inside = setup({ region: { from: { x: -10, y: 60, z: -10 }, to: { x: 10, y: 70, z: 10 } } });
  await sleep(800);
  assert.equal(inside.idle.state().walks, 0);
  assert.ok(inside.visited.every((p) => p.x === 0 && p.z === 0));
  for (const fn of cleanup.splice(0)) fn();

  // 区域从 x=1 开始：只能往 x<=0 那边走
  const beside = setup({ region: { from: { x: 1, y: 60, z: -10 }, to: { x: 10, y: 70, z: 10 } } });
  await sleep(1500);
  assert.ok(beside.idle.state().walks >= 1);
  assert.ok(beside.visited.every((p) => p.x <= 0), `进了区域：${beside.visited.find((p) => p.x > 0)}`);
});

test('悬崖边、水边不去：锚点旁边是深坑和水时，只往安全的一侧走', async () => {
  const { w, idle, visited } = setup({ timing: { walkTimeoutMs: 1000 } });
  // x<=-1 挖成 4 格深的坑，z>=2 一排水
  w.fill(-4, 60, -4, -1, 63, 4, 'air');
  w.fill(-3, 63, 2, 3, 63, 4, 'water');
  await sleep(1500);
  assert.ok(idle.state().walks >= 1);
  for (const p of visited) {
    assert.ok(p.x >= 1 || (p.x === 0 && p.z === 0), `走到了坑边：${p}`);
    assert.ok(p.z <= 0 || (p.x === 0 && p.z === 0), `走到了水边：${p}`);
  }
});

test('有工具开始时立刻停下、不抢工具的寻路目标，冷却期内不再走，冷却后恢复', async () => {
  const { bot, idle } = setup();
  assert.ok(await waitFor(() => idle.state().walking), '先开始一次空闲走动');
  beginActivity();
  beginBody();
  try {
    await sleep(10);
    assert.equal(idle.state().walking, false);
    assert.equal(bot.pathfinder.goal, null, '空闲走动的目标被清掉');
    // 工具设自己的目标，空闲逻辑不能动它
    const toolGoal = new goals.GoalBlock(-5, 64, -5);
    const setGoal = bot.pathfinder.setGoal;
    const calls = [];
    bot.pathfinder.setGoal = (g, d) => {
      calls.push(g);
      return setGoal(g, d);
    };
    bot.pathfinder.setGoal(toolGoal);
    calls.length = 0;
    await sleep(100);
    assert.deepEqual(calls, [], '空闲逻辑不能改工具的寻路目标');
    bot.pathfinder.setGoal(null);
  } finally {
    endBody();
    endActivity();
  }
  const walks = idle.state().walks;
  await sleep(400);
  assert.equal(idle.state().walks, walks, '冷却期内不走');
  assert.ok(await waitFor(() => idle.state().walks > walks, 2000), '冷却后恢复');
});

test('有人聊天、被打、敌对生物靠近都会打断并冷却', async () => {
  const { bot, idle } = setup();
  assert.ok(await waitFor(() => idle.state().walking));
  bot.emit('chat', 'muxue', '在干嘛');
  assert.equal(idle.state().walking, false);
  assert.equal(bot.pathfinder.goal, null);
  const walks = idle.state().walks;
  await sleep(300);
  assert.equal(idle.state().walks, walks);

  assert.ok(await waitFor(() => idle.state().walking, 3000));
  bot.emit('entityHurt', bot.entity, undefined);
  assert.equal(idle.state().walking, false);
  const afterHurt = idle.state().walks;

  bot.entities[88] = { id: 88, type: 'hostile', name: 'zombie', position: new Vec3(0.5, 64, 5.5), height: 1.95 };
  await sleep(1000);
  assert.equal(idle.state().walks, afterHurt, '僵尸在附近时不走');
});

test('晚上不走；附近没有真人玩家也不走', async () => {
  const night = setup({ timeOfDay: 15000 });
  await sleep(600);
  assert.equal(night.idle.state().walks, 0);
  for (const fn of cleanup.splice(0)) fn();

  const alone = setup({ playerAt: new Vec3(30.5, 64, 0.5) });
  await sleep(600);
  assert.equal(alone.idle.state().walks, 0);
});

test('换手：切到快捷栏里别的有东西的格子，过一会儿换回原格子；工具开始时立刻换回', async () => {
  const inventory = [['stone_pickaxe', 1], ['bread', 5], ['torch', 10]];
  const { bot, idle } = setup({ playerAt: null, inventory, timing: { swapMinMs: 50, swapMaxMs: 60, swapHoldMinMs: 150, swapHoldMaxMs: 180 } });
  assert.ok(await waitFor(() => bot.quickBarSlot !== 0), '应该换过手');
  assert.ok([1, 2].includes(bot.quickBarSlot), `换到有东西的格子，实际 ${bot.quickBarSlot}`);
  assert.equal(idle.state().swappedFrom, 0);
  assert.ok(await waitFor(() => bot.quickBarSlot === 0, 1000), '过一会儿换回原来的格子');

  assert.ok(await waitFor(() => bot.quickBarSlot !== 0, 1000));
  beginActivity();
  try {
    // 同一个调用栈里就已经换回，不等定时器或物理 tick
    assert.equal(bot.quickBarSlot, 0, '工具开始时立刻换回');
  } finally {
    endActivity();
  }
});

test('换手期间调用会用手上物品的工具：执行器开始时手上已经是原来的格子，并进入冷却', async () => {
  const inventory = [['stone_pickaxe', 1], ['bread', 5], ['torch', 10]];
  const { bot, idle } = setup({ playerAt: null, inventory, timing: { swapMinMs: 20, swapMaxMs: 30, swapHoldMinMs: 5000, swapHoldMaxMs: 6000 } });
  const h = createHarness(bot);
  let seen = null;
  h.factory.registerTool('test-use-held', 'test only', {}, async () => {
    seen = { slot: bot.quickBarSlot, goal: bot.pathfinder.goal };
    return h.factory.createResponse('ok');
  });
  assert.ok(await waitFor(() => bot.quickBarSlot !== 0), '应该换过手');
  const r = await h.call('test-use-held');
  assert.equal(text(r), 'ok');
  assert.deepEqual(seen, { slot: 0, goal: null });
  assert.ok(idle.state().quietUntil > Date.now(), '进了冷却');
  assert.equal(idle.state().swappedFrom, null);
});

test('看风景：附近没人时平滑地转头看看；idleLook 关掉就不看', async () => {
  const { bot, idle } = setup({ playerAt: null, timing: { sceneryMinMs: 40, sceneryMaxMs: 60 } });
  const yaw0 = bot.entity.yaw;
  assert.ok(await waitFor(() => Math.abs(bot.entity.yaw - yaw0) > 0.3, 1000), '应该转过头');
  assert.ok(idle.state().glances >= 1);
  for (const fn of cleanup.splice(0)) fn();

  socialSettings.idleLook = false;
  const off = setup({ playerAt: null, timing: { sceneryMinMs: 40, sceneryMaxMs: 60 } });
  await sleep(400);
  assert.equal(off.bot.entity.yaw, 0);
  assert.equal(off.idle.state().glances, 0);
});

test('关掉 idleActions 后不走、不换手，但看风景照旧（归 idleLook 管）', async () => {
  socialSettings.idleActions = false;
  const { bot, idle, visited } = setup({ timing: { sceneryMinMs: 40, sceneryMaxMs: 60, swapMinMs: 40, swapMaxMs: 60 }, inventory: [['stone_pickaxe', 1], ['bread', 5]] });
  await sleep(800);
  assert.equal(idle.state().walks + idle.state().swaps, 0);
  assert.ok(visited.every((p) => p.x === 0 && p.z === 0));
  assert.equal(bot.quickBarSlot, 0);
  assert.ok(idle.state().glances >= 1, '还会看周围');
});

test('bot 断开时清理定时器和监听', async () => {
  const { bot, idle } = setup();
  const before = bot.listenerCount('chat');
  bot.emit('end', 'quit');
  assert.equal(bot.listenerCount('chat'), before - 1);
  const walks = idle.state().walks;
  await sleep(300);
  assert.equal(idle.state().walks, walks);
});
