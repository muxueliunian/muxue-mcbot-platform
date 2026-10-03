// 空闲视线：平时不盯着人看，只在关注窗口（她说话、小克说话、她走近、她打小克）里看她；被盯着会回看再别过头
// 时间参数按比例缩短（约 1/20），不连服务器
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { flatWorld, createFakeBot, Vec3 } from './helpers/fake-bot.mjs';
import { tempDir, sleep } from './helpers/harness.mjs';
import { configurePolicy, prepareBot } from '../dist/action-policy.js';
import { RegionStore } from '../dist/regions.js';
import { startIdleActions, gazeOffAngle } from '../dist/idle.js';
import { socialSettings, speak } from '../dist/social.js';
import { beginActivity, endActivity, beginBody, endBody } from '../dist/task-control.js';

// 只测视线：不走、不换手
const FAST = {
  tickMs: 10,
  quietMs: 30,
  cooldownMs: 600,
  swapMinMs: 1e9,
  swapMaxMs: 1e9,
  walkAfterIdleMs: 1e9,
  walkMinMs: 1e9,
  walkMaxMs: 1e9,
  lookSteps: 2,
  lookStepMs: 5,
  sceneryMinMs: 150,
  sceneryMaxMs: 500,
  peekMinMs: 750,
  peekMaxMs: 2000,
  peekHoldMinMs: 75,
  peekHoldMaxMs: 150,
  attentionMinMs: 300,
  attentionMaxMs: 400,
  attentionShiftMinMs: 75,
  attentionShiftMaxMs: 150,
  attentionAwayChance: 0,
  stareMs: 75,
  stareBackMinMs: 100,
  stareBackMaxMs: 150,
  stareAwayMinMs: 100,
  stareAwayMaxMs: 200,
  stareCooldownMs: 500
};

const LOOKING = (15 * Math.PI) / 180;
// 她在 (3.5, 64, 0.5)，小克在原点那一格：yaw = -π/2 是背对小克看 +x，π/2 是正对着小克
const AWAY = -Math.PI / 2;
const AT_BOT = Math.PI / 2;

let cleanup = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  socialSettings.idleActions = true;
  socialSettings.idleLook = true;
});

function setup({ playerAt = new Vec3(3.5, 64, 0.5), herYaw = AWAY, timing = {} } = {}) {
  configurePolicy(new RegionStore(path.join(tempDir('mcbot-gaze-'), 'regions.json'), 'test-world', 'Claude'));
  const bot = createFakeBot(flatWorld());
  prepareBot(bot);
  bot.quickBarSlot = 0;
  bot.setQuickBarSlot = (n) => { bot.quickBarSlot = n; };
  const her = { id: 77, type: 'player', name: 'player', username: 'muxue', position: playerAt, height: 1.8, yaw: herYaw, pitch: 0, isValid: true };
  bot.entities[her.id] = her;
  bot.players.muxue = { username: 'muxue', entity: her };
  const idle = startIdleActions(bot, { ...FAST, ...timing });
  cleanup.push(() => bot.emit('end', 'test'));
  return { bot, idle, her };
}

const lookingAt = (bot, her) => gazeOffAngle(bot, her) < LOOKING;

async function sample(ms, fn) {
  const out = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    out.push(fn());
    await sleep(5);
  }
  return out;
}

async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

test('平时：她在旁边、没人说话时，大部分时间不看她，只偶尔瞥一眼', async () => {
  const { bot, idle, her } = setup();
  const s = await sample(4000, () => lookingAt(bot, her));
  const ratio = s.filter(Boolean).length / s.length;
  assert.ok(ratio < 0.3, `看她的时间比例 ${(ratio * 100).toFixed(1)}% 应该低于 30%`);
  assert.ok(idle.state().peeks >= 1, '会偶尔瞥她一眼');
  assert.ok(idle.state().glances >= 4, `会换着看周围，实际 ${idle.state().glances}`);
  assert.equal(idle.state().attentions, 0, '一开始就在旁边的人不算刚走近');
});

test('关注窗口：她说话后看着她，窗口过了就移开', async () => {
  const { bot, idle, her } = setup({ timing: { peekMinMs: 1e9, peekMaxMs: 1e9 } });
  await sleep(100);
  bot.emit('chat', 'muxue', '在干嘛');
  assert.ok(await waitFor(() => lookingAt(bot, her), 200), '说话后转过来看她');
  assert.equal(idle.state().gaze.mode, 'attention');
  const during = await sample(200, () => lookingAt(bot, her));
  assert.ok(during.every(Boolean), '窗口内一直看着她');
  assert.ok(await waitFor(() => idle.state().gaze.mode === 'scenery', 600), '窗口过了回到看周围');
  const after = await sample(600, () => lookingAt(bot, her));
  assert.ok(after.filter(Boolean).length / after.length < 0.3, '窗口过后不再盯着');
});

test('关注窗口：小克对她说话、她刚走近、她打了小克都会开始窗口；机器人说话不算', async () => {
  const { bot, idle, her } = setup({ playerAt: new Vec3(30.5, 64, 0.5), timing: { peekMinMs: 1e9, peekMaxMs: 1e9 } });
  await sleep(50);
  // 远处的人说话不算（超过 16 格）
  bot.emit('chat', 'muxue', '喂');
  await sleep(50);
  assert.equal(idle.state().attentions, 0);

  // 她走近
  her.position = new Vec3(4.5, 64, 0.5);
  assert.ok(await waitFor(() => idle.state().gaze.mode === 'attention', 200), '她刚走近');
  assert.ok(await waitFor(() => lookingAt(bot, her), 200));
  assert.ok(await waitFor(() => idle.state().gaze.mode !== 'attention', 800));

  // 小克对她说话
  await speak(bot, '嗯', 'muxue');
  assert.ok(await waitFor(() => idle.state().gaze.mode === 'attention', 200), '小克对她说话');
  assert.ok(await waitFor(() => idle.state().gaze.mode !== 'attention', 800));

  // 她打了小克
  bot.emit('entityHurt', bot.entity, her);
  assert.ok(await waitFor(() => idle.state().gaze.mode === 'attention', 200), '她打了小克');
  assert.ok(await waitFor(() => idle.state().gaze.mode !== 'attention', 800));

  // 另一个 Bot 说话不算
  const gem = { id: 78, type: 'player', username: 'Gemini', position: new Vec3(-3.5, 64, 0.5), height: 1.8, yaw: 0, pitch: 0 };
  bot.entities[78] = gem;
  bot.players.Gemini = { username: 'Gemini', entity: gem };
  const n = idle.state().attentions;
  bot.emit('chat', 'Gemini', '你好');
  await sleep(50);
  assert.equal(idle.state().attentions, n);
});

test('对视：她盯着小克超过阈值会回看，然后别过头；冷却期内不再回看，冷却后才会', async () => {
  const { bot, idle, her } = setup({ herYaw: AT_BOT, timing: { peekMinMs: 1e9, peekMaxMs: 1e9 } });
  assert.ok(await waitFor(() => idle.state().gaze.mode === 'stare-back', 500), '被盯着会回看');
  assert.ok(await waitFor(() => lookingAt(bot, her), 100), '回看时看着她');
  assert.equal(idle.state().stareBacks, 1);
  assert.ok(await waitFor(() => idle.state().gaze.mode === 'stare-away', 300), '然后别过头');
  await sleep(30);
  assert.ok(gazeOffAngle(bot, her) > 0.5, `别过头时不看她（夹角 ${gazeOffAngle(bot, her).toFixed(2)}）`);
  const coolUntil = idle.state().gaze.stareCooldownUntil;
  // 冷却期内她一直盯着，也不再回看
  while (Date.now() < coolUntil - 20) {
    assert.equal(idle.state().stareBacks, 1, '冷却期内不再回看');
    await sleep(5);
  }
  assert.ok(await waitFor(() => idle.state().stareBacks === 2, 500), '冷却后还盯着就再回看');
});

test('她看着别处时不算对视', async () => {
  const { idle } = setup({ herYaw: AT_BOT + 0.5, timing: { peekMinMs: 1e9, peekMaxMs: 1e9 } });
  await sleep(500);
  assert.equal(idle.state().stareBacks, 0);
});

test('干活时不转头：说话、被盯着都不抢视线', async () => {
  const { bot, idle, her } = setup({ herYaw: AT_BOT });
  await sleep(50);
  beginActivity();
  beginBody();
  try {
    await sleep(20);
    const yaw = bot.entity.yaw;
    const pitch = bot.entity.pitch;
    bot.emit('chat', 'muxue', '在干嘛');
    await sleep(400);
    assert.equal(bot.entity.yaw, yaw);
    assert.equal(bot.entity.pitch, pitch);
    assert.equal(idle.state().stareBacks, 0);
  } finally {
    endBody();
    endActivity();
  }
  // 干完活窗口还在的话接着看她，已经过了就照常
  assert.ok(await waitFor(() => idle.state().gaze.mode !== 'none', 300));
  void her;
});

test('idleLook 关掉时完全不转头（关注窗口、对视、看周围都不做）', async () => {
  socialSettings.idleLook = false;
  const { bot, idle } = setup({ herYaw: AT_BOT });
  bot.emit('chat', 'muxue', '在干嘛');
  await speak(bot, '嗯');
  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;
  await sleep(600);
  assert.equal(bot.entity.yaw, yaw);
  assert.equal(bot.entity.pitch, pitch);
  assert.equal(idle.state().stareBacks + idle.state().glances + idle.state().peeks, 0);
});
