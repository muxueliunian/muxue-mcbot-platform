// 创造模式飞行：绕开墙和屋顶飞、飞不过去时不穿墙、悬停 / 落地切换、走路前自动落地
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatWorld, createFakeBot, attachTeleportKinematics, attachGravity, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, sleep } from './helpers/harness.mjs';

// 7×7 的石头屋子（墙 x/z = ±3，地板 y63，墙 y64~67，屋顶 y68），opening 为真时东墙开一个 1 宽 2 高的洞
function room(w, opening) {
  w.fill(-3, 64, -3, 3, 68, 3, 'stone');
  w.fill(-2, 64, -2, 2, 67, 2, 'air');
  if (opening) w.fill(3, 64, 0, 3, 65, 0, 'air');
}

// 记下飞行中身体到过的每个位置，检查有没有穿进方块
function trackPositions(bot) {
  const seen = [];
  let pos = bot.entity.position;
  Object.defineProperty(bot.entity, 'position', {
    get: () => pos,
    set: (v) => {
      pos = v;
      seen.push(v.clone());
    },
    configurable: true
  });
  return seen;
}

function insideBlock(w, p) {
  for (const x of [p.x - 0.29, p.x + 0.29]) for (const z of [p.z - 0.29, p.z + 0.29]) for (const y of [p.y + 0.01, p.y + 1, p.y + 1.79]) {
    const name = w.name(Math.floor(x), Math.floor(y), Math.floor(z));
    if (name !== 'air') return `${name} @ ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  }
  return null;
}

function creativeBot(w, opts) {
  const bot = createFakeBot(w, opts);
  bot.game.gameMode = 'creative';
  return bot;
}

test('fly-to：从屋里绕出墙上的洞飞到屋顶上，一路不穿墙，到了落地', async () => {
  const w = flatWorld();
  room(w, true);
  const bot = creativeBot(w);
  const h = createHarness(bot);
  const stopGravity = attachGravity(bot);
  const seen = trackPositions(bot);
  let r;
  try {
    r = await h.call('fly-to', { x: 0, y: 69, z: 0 });
  } finally {
    stopGravity();
  }
  assert.match(text(r), /飞到了 \(0, 69, 0\)，落地在 \(0, 69, 0\)/, text(r));
  assert.ok(seen.length > 10);
  for (const p of seen) assert.equal(insideBlock(w, p), null, `穿进方块了：${p}`);
  assert.equal(bot.physics.gravity, 0.08);
});

test('fly-to：封死的屋子飞不出去，报错、不动、重力恢复', async () => {
  const w = flatWorld();
  room(w, false);
  const bot = creativeBot(w);
  const h = createHarness(bot);
  const stopGravity = attachGravity(bot);
  let r;
  try {
    r = await h.call('fly-to', { x: 0, y: 69, z: 0 });
  } finally {
    stopGravity();
  }
  assert.match(text(r), /飞不过去/);
  assert.deepEqual(bot.entity.position.floored().toArray(), [0, 64, 0]);
  assert.equal(bot.physics.gravity, 0.08);
});

test('fly-to stay / set-flying：悬停不往下掉；落地开关；走路前自动落地；生存模式不能飞', async () => {
  const w = flatWorld();
  const bot = creativeBot(w);
  const h = createHarness(bot);
  const stops = [attachGravity(bot), attachTeleportKinematics(bot)];
  try {
    assert.match(text(await h.call('fly-to', { x: 4, y: 68, z: 2, stay: true })), /悬停在空中/);
    await sleep(100);
    assert.deepEqual(bot.entity.position.toArray(), [4.5, 68, 2.5]);
    assert.equal(bot.physics.gravity, 0);

    assert.match(text(await h.call('set-flying', { flying: false })), /已经落地：\(4, 64, 2\)/);
    assert.equal(bot.physics.gravity, 0.08);

    assert.match(text(await h.call('set-flying', { flying: true })), /悬停在 \(4, 64, 2\)/);
    assert.match(text(await h.call('fly-to', { x: 0, y: 70, z: 0, stay: true })), /悬停/);
    // 悬停时直接走路：先落地再走
    const walk = await h.call('move-to-position', { x: 6, y: 64, z: 0, range: 0 });
    assert.match(text(walk), /Successfully moved/, text(walk));
    assert.equal(bot.physics.gravity, 0.08);
    assert.deepEqual(bot.entity.position.floored().toArray(), [6, 64, 0]);
  } finally {
    stops.forEach((s) => s());
  }

  bot.game.gameMode = 'survival';
  assert.match(text(await h.call('fly-to', { x: 0, y: 70, z: 0 })), /只有创造模式能飞/);
  assert.match(text(await h.call('set-flying', { flying: true })), /只有创造模式能飞/);
});
