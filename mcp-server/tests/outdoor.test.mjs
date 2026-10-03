// 阶段 3：跟随、环境事件、朝向协调、躲避、地点记忆
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { flatWorld, createFakeBot, attachTeleportKinematics, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, sleep, tempDir } from './helpers/harness.mjs';
import { attachWorldWatchers, HOSTILE_COOLDOWN_MS } from '../dist/world-events.js';
import { startReflexes, reflexSettings } from '../dist/reflexes.js';
import { claimGaze, releaseGaze, mayLook } from '../dist/gaze.js';
import { speak, socialSettings } from '../dist/social.js';
import { startIdleActions } from '../dist/idle.js';
import { TaskHandle } from '../dist/task-control.js';
import { GoalFollowNear } from '../dist/follow.js';

let stops = [];
beforeEach(() => { stops = []; });
afterEach(async () => { for (const s of stops.splice(0)) await s(); });

function player(bot, name, pos, extra = {}) {
  const entity = { id: 900 + Object.keys(bot.players).length, type: 'player', username: name, position: pos, height: 1.8, yaw: 0, pitch: 0, ...extra };
  bot.players[name] = { username: name, entity };
  bot.entities[entity.id] = entity;
  return entity;
}

function mob(bot, id, name, pos) {
  const e = { id, type: 'hostile', name, displayName: name, position: pos, height: 1.8 };
  bot.entities[id] = e;
  return e;
}

async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await sleep(50);
}

function lookCounter(bot) {
  const real = bot.lookAt;
  const counter = { n: 0 };
  bot.lookAt = async (...a) => { counter.n++; return real(...a); };
  return counter;
}

async function followSetup(world = flatWorld()) {
  const bot = createFakeBot(world);
  const h = createHarness(bot);
  const stopKin = attachTeleportKinematics(bot);
  stops.push(async () => { await h.call('stop-action'); stopKin(); });
  return { bot, h };
}

test('跟随：离远了才走，走到保持距离内就停，不站到玩家脚下', async () => {
  const { bot, h } = await followSetup();
  const p = player(bot, 'muxue', new Vec3(2.5, 64, 0.5));
  assert.match(text(await h.call('follow-player', { username: 'muxue', distance: 3 })), /开始跟随 muxue/);
  await sleep(400);
  assert.equal(bot.pathfinder.goal, null, '距离够近时不动');
  p.position = new Vec3(10.5, 64, 0.5);
  await sleep(1200);
  const d = bot.entity.position.distanceTo(p.position);
  assert.ok(d <= 3.5 && d >= 1, `应停在约 3 格处（实际 ${d.toFixed(1)}）`);
  assert.notDeepEqual(bot.entity.position.floored().toArray(), p.position.floored().toArray());
  assert.match(text(await h.call('get-status')), /跟随：正在跟随 muxue/);
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
});

test('跟随目标不会停在登记的门口', () => {
  const avoid = new Set(['5,64,0']);
  const goal = new GoalFollowNear(6.5, 64, 0.5, 3, avoid, { x: 6.5, y: 64, z: 0.5 });
  assert.equal(goal.isEnd({ x: 5, y: 64, z: 0 }), false, '门口格子');
  assert.equal(goal.isEnd({ x: 6, y: 64, z: 0 }), false, '玩家脚下');
  assert.equal(goal.isEnd({ x: 4, y: 64, z: 1 }), true);
});

test('跟随：人不见了、被传送、走散时停下并发 follow 事件', async () => {
  {
    const { bot, h } = await followSetup();
    player(bot, 'muxue', new Vec3(8.5, 64, 0.5));
    await h.call('follow-player', { username: 'muxue' });
    await sleep(200);
    delete bot.players.muxue;
    await sleep(500);
    assert.equal(bot.pathfinder.goal, null);
    assert.match(h.events.since(0, ['follow']).map((e) => e.text).join('\n'), /看不到 muxue 了/);
    assert.match(text(await h.call('get-status')), /跟随：没有在跟随/);
  }
  {
    const { bot, h } = await followSetup();
    const p = player(bot, 'muxue', new Vec3(8.5, 64, 0.5));
    await h.call('follow-player', { username: 'muxue' });
    await sleep(350);
    p.position = new Vec3(8.5, 64, 60.5);
    await sleep(500);
    assert.match(h.events.since(0, ['follow']).map((e) => e.text).join('\n'), /像是传送了/);
    assert.equal(bot.pathfinder.goal, null);
  }
  {
    const { bot, h } = await followSetup();
    player(bot, 'muxue', new Vec3(8.5, 64, 0.5));
    await h.call('follow-player', { username: 'muxue', maxDistance: 8 });
    await sleep(100);
    bot.players.muxue.entity.position = new Vec3(8.5, 64, 12.5);
    await sleep(500);
    assert.match(h.events.since(0, ['follow']).map((e) => e.text).join('\n'), /走散了|传送/);
  }
});

test('跟随：墙挡住时连续找不到路就原地等（只说一次），不挖不垫；她挪了位置、有路了再跟上', async () => {
  const w = flatWorld();
  w.fill(3, 64, -16, 3, 65, 15, 'stone');
  const { bot, h } = await followSetup(w);
  const p = player(bot, 'muxue', new Vec3(8.5, 64, 0.5));
  await h.call('follow-player', { username: 'muxue' });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !h.events.since(0, ['follow']).length) await sleep(100);
  assert.match(h.events.since(0, ['follow']).map((e) => e.text).join('\n'), /暂时跟不过去 muxue/);
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
  assert.equal(w.name(3, 65, 0), 'stone');
  assert.match(text(await h.call('get-status')), /正在跟随 muxue.*原地等/);

  // 她在墙那边走来走去：还是过不去，不再重复说
  p.position = new Vec3(9.5, 64, 4.5);
  await sleep(1500);
  assert.equal(h.events.since(0, ['follow']).length, 1);

  // 她把墙挖开了、又挪了位置：接着跟
  w.fill(3, 64, -2, 3, 65, 2, 'air');
  p.position = new Vec3(9.5, 64, 0.5);
  const reached = Date.now() + 5000;
  while (Date.now() < reached && bot.entity.position.distanceTo(p.position) > 4) await sleep(100);
  assert.ok(bot.entity.position.distanceTo(p.position) <= 4, `应该跟上（相距 ${bot.entity.position.distanceTo(p.position).toFixed(1)}）`);
});

test('跟随：原地等时她没挪位置、只是把墙挖通了，10 秒后自己再试，跟上', async () => {
  const w = flatWorld();
  w.fill(3, 64, -16, 3, 65, 15, 'stone');
  const { bot, h } = await followSetup(w);
  const p = player(bot, 'muxue', new Vec3(8.5, 64, 0.5));
  await h.call('follow-player', { username: 'muxue' });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !h.events.since(0, ['follow']).length) await sleep(100);
  assert.match(text(await h.call('get-status')), /原地等/);
  w.fill(3, 64, -2, 3, 65, 2, 'air');
  const reached = Date.now() + 14000;
  while (Date.now() < reached && bot.entity.position.distanceTo(p.position) > 4) await sleep(200);
  assert.ok(bot.entity.position.distanceTo(p.position) <= 4, `应该跟上（相距 ${bot.entity.position.distanceTo(p.position).toFixed(1)}）`);
});

test('跟随：别的动作进行时暂停，不抢寻路目标；stop-action 结束跟随', async () => {
  const { bot, h } = await followSetup();
  const p = player(bot, 'muxue', new Vec3(2.5, 64, 0.5));
  await h.call('follow-player', { username: 'muxue' });
  h.writeScript('busy', `export default async function (ctx) { await ctx.sleep(900); return 'ok'; }`);
  await h.call('run-script', { name: 'busy', background: true });
  p.position = new Vec3(10.5, 64, 0.5);
  await sleep(600);
  assert.equal(bot.pathfinder.goal, null, '后台任务期间不应开始跟随移动');
  await h.factory.settle();
  await sleep(700);
  assert.ok(bot.entity.position.x > 5, '任务结束后继续跟上');
  await h.call('stop-action');
  p.position = new Vec3(-10.5, 64, 0.5);
  await sleep(600);
  assert.equal(bot.pathfinder.goal, null);
  assert.match(text(await h.call('get-status')), /没有在跟随/);
});

test('敌对生物靠近：合并成一条事件，冷却期内不重复，新来的之后才再报', async () => {
  const bot = createFakeBot(flatWorld());
  const h = createHarness(bot);
  const detach = attachWorldWatchers(bot, h.events);
  stops.push(detach);
  mob(bot, 1, 'zombie', new Vec3(-3.5, 64, -3.5));
  mob(bot, 2, 'skeleton', new Vec3(5.5, 64, 0.5));
  mob(bot, 3, 'zombie', new Vec3(20.5, 64, 0.5)); // 太远
  await sleep(1300);
  let ev = h.events.since(0, ['hostile']);
  assert.equal(ev.length, 1);
  assert.match(ev[0].text, /^敌对生物靠近：skeleton（右边 5 格），zombie（左前方 6 格）$/);
  bot.entities[1].position = new Vec3(-2.5, 64, -2.5); // 移动不再报
  mob(bot, 4, 'spider', new Vec3(0.5, 64, 6.5)); // 冷却期内的新生物先不报
  await sleep(1200);
  ev = h.events.since(0, ['hostile']);
  assert.equal(ev.length, 1);
  assert.ok(HOSTILE_COOLDOWN_MS >= 10000);
});

test('苦力怕点燃声、爆炸：发 danger 事件（去重），会打断长任务', async () => {
  const bot = createFakeBot(flatWorld());
  bot._client = new EventEmitter();
  const h = createHarness(bot);
  const handle = new TaskHandle({ timeoutMs: 60000, interruptOnChat: false });
  stops.push(attachWorldWatchers(bot, h.events));
  for (let i = 0; i < 3; i++) bot.emit('soundEffectHeard', 'minecraft:entity.creeper.primed', new Vec3(-2.5, 64, 0.5), 1, 1);
  bot.emit('soundEffectHeard', 'entity.creeper.primed', new Vec3(40, 64, 0), 1, 1); // 太远
  bot.emit('soundEffectHeard', 'block.stone.break', new Vec3(1, 64, 0), 1, 1);
  let ev = h.events.since(0, ['danger']);
  assert.equal(ev.length, 1);
  assert.match(ev[0].text, /听到苦力怕点燃的声音，在我左边 3 格/);
  assert.match(handle.check(), /发生事件（danger/);
  bot._client.emit('explosion', { x: 10.5, y: 64, z: 0.5, radius: 3 });
  bot._client.emit('explosion', { x: 10.6, y: 64, z: 0.5, radius: 3 });
  bot._client.emit('explosion', { x: 200, y: 64, z: 0.5, radius: 3 });
  ev = h.events.since(0, ['danger']);
  assert.equal(ev.length, 2);
  assert.match(ev[1].text, /右边 10 格发生了爆炸/);
});

test('躲避：听到点燃且苦力怕很近时往反方向退；身后不安全就不动', async () => {
  const saved = { ...reflexSettings };
  reflexSettings.autoEat = false;
  try {
    // 安全：苦力怕在北边，往南退
    {
      const bot = createFakeBot(flatWorld());
      bot.game.gameMode = 'survival';
      const creeper = mob(bot, 5, 'creeper', new Vec3(0.5, 64, -2));
      bot.nearestEntity = (f) => (f(creeper) ? creeper : null);
      const events = [];
      bot._client = new EventEmitter();
      const h = createHarness(bot);
      stops.push(attachWorldWatchers(bot, h.events));
      startReflexes(bot, (t, x) => events.push([t, x]));
      stops.push(() => bot.emit('end'));
      bot.emit('soundEffectHeard', 'entity.creeper.primed', creeper.position, 1, 1);
      await waitFor(() => bot.controlState.forward, 3000);
      assert.equal(bot.controlState.forward, true);
      assert.ok(Math.abs(Math.abs(bot.entity.yaw) - Math.PI) < 0.01, `应面朝南（yaw=${bot.entity.yaw}）`);
      assert.ok(events.some(([t, x]) => t === 'reflex' && /往后躲开/.test(x)));
      assert.equal(bot.calls.filter((c) => c.type === 'attack').length, 0, '点燃的苦力怕不去打');
      bot.emit('end'); // 停掉这个 Bot 的本能循环，免得影响下一段
    }
    // 不安全：南边是岩浆
    {
      const w = flatWorld();
      w.set(0, 63, 2, 'lava');
      const bot = createFakeBot(w);
      const creeper = mob(bot, 6, 'creeper', new Vec3(0.5, 64, -2));
      bot.nearestEntity = (f) => (f(creeper) ? creeper : null);
      const events = [];
      startReflexes(bot, (t, x) => events.push([t, x]));
      stops.push(() => bot.emit('end'));
      const { notePrimed } = await import('../dist/reflexes.js');
      await sleep(1300); // 等上一次躲避的冷却结束
      notePrimed(creeper.position);
      await waitFor(() => events.some(([t]) => t === 'danger'), 3000);
      assert.equal(bot.controlState.forward, false);
      assert.ok(events.some(([t, x]) => t === 'danger' && /身后不安全/.test(x)));
    }
  } finally {
    Object.assign(reflexSettings, saved);
  }
});

test('朝向协调：干活时说话不转头、不做转身表情；战斗时聊天不抢视线；空闲时才张望', async () => {
  const bot = createFakeBot(flatWorld());
  const h = createHarness(bot);
  player(bot, 'muxue', new Vec3(3.5, 64, 0.5));
  const looks = lookCounter(bot);
  releaseGaze('combat'); // 上一个测试的躲避可能还占着视线

  await speak(bot, '在呢', 'muxue');
  assert.equal(looks.n, 1, '空闲时说话会看向对方');

  h.writeScript('work', `export default async function (ctx) { await ctx.sleep(1500); return 'ok'; }`);
  await h.call('run-script', { name: 'work', background: true });
  assert.equal(mayLook('idle'), false);
  assert.equal(mayLook('chat'), false);
  assert.equal(mayLook('combat'), true);
  await h.call('send-chat', { message: '马上好' });
  assert.equal(looks.n, 1, '干活时说话不转头');
  assert.match(text(await h.call('emote', { action: 'spin' })), /正在忙/);
  assert.match(text(await h.call('emote', { action: 'wave' })), /挥了挥手/);
  await h.factory.settle();

  claimGaze('combat', 400);
  await speak(bot, '等等', 'muxue');
  assert.equal(looks.n, 1, '战斗占用视线时不看人');
  assert.match(text(await h.call('emote', { action: 'nod' })), /正在忙/);
  releaseGaze('combat');
  await speak(bot, '好了', 'muxue');
  assert.equal(looks.n, 2);

  // 空闲张望：干活时不张望
  socialSettings.idleLook = true;
  const idle = startIdleActions(bot, { sceneryMinMs: 100, sceneryMaxMs: 200, peekMinMs: 100, peekMaxMs: 200 });
  stops.push(() => idle.stop());
  bot.nearestEntity = (f) => Object.values(bot.entities).find((e) => f(e)) ?? null;
  await h.call('run-script', { name: 'work', background: true });
  const before = looks.n;
  await sleep(1300);
  assert.equal(looks.n, before, '后台任务期间不张望');
  await h.factory.settle();
});

test('地点记忆：按距离列出附近的，区分世界和维度，可以忘掉', async () => {
  const dir = tempDir('mcbot-places-');
  const bot = createFakeBot(flatWorld());
  const h = createHarness(bot, { regionFile: path.join(dir, 'regions.json') });
  await h.call('remember-place', { name: 'mine-1', kind: 'mine', pos: { x: 100, y: 40, z: 0 }, note: '往下有铁', source: '测试：我发现的' });
  await h.call('remember-place', { name: 'tree', kind: 'landmark', source: '测试' });
  await h.call('remember-place', { name: 'far', kind: 'landmark', pos: { x: 5000, y: 64, z: 0 }, source: '测试' });
  bot.game.dimension = 'the_nether';
  await h.call('remember-place', { name: 'portal', kind: 'landmark', source: '测试' });
  bot.game.dimension = 'overworld';
  const list = text(await h.call('list-places', {}));
  assert.match(list, /^- tree（landmark）\(0, 64, 0\)：就在这里/);
  assert.match(list, /- mine-1（mine）\(100, 40, 0\)：东方 100 格，低 24 格｜往下有铁｜刚记录/);
  assert.doesNotMatch(list, /far|portal/);
  assert.match(text(await h.call('observe', {})), /记着的地点（32 格内）：tree（landmark）/);
  await h.call('forget-place', { name: 'tree', source: '测试：树被砍了' });
  assert.doesNotMatch(text(await h.call('list-places', {})), /tree/);
  assert.match(text(await h.call('list-places', { radius: 10000 })), /far/);
});
