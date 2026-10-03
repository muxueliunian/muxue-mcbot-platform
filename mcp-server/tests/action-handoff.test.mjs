import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { flatWorld, createFakeBot, attachTeleportKinematics, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, callsOf, sleep } from './helpers/harness.mjs';

test('stop-action 后的新交还指令第一次就能走到玩家身边，不继承旧停止请求', async () => {
  const bot = createFakeBot(flatWorld(), { inventory: [['grass_block', 1]] });
  bot.players.muxue = { username: 'muxue', entity: { position: new Vec3(6.5, 64, 0.5), height: 1.8, username: 'muxue', isValid: true } };
  const h = createHarness(bot);
  const stop = attachTeleportKinematics(bot);
  try {
    const stopped = await h.call('stop-action');
    assert.ok(!stopped.isError, text(stopped));
    await sleep(30); // 空闲几个 physicsTick，模拟玩家稍后给出新的明确任务
    const handed = await h.call('give-item', { username: 'muxue', itemName: 'grass_block', count: 1 });
    assert.ok(!handed.isError, text(handed));
    assert.equal(callsOf(bot, 'toss').length, 1);
  } finally {
    stop();
  }
});

test('行走中叫停立即撤销旧交还动作，之后的新交还第一次就能完成', async () => {
  const bot = createFakeBot(flatWorld(), { inventory: [['grass_block', 1]] });
  bot.players.muxue = { username: 'muxue', entity: { position: new Vec3(12.5, 64, 0.5), height: 1.8, username: 'muxue', isValid: true } };
  const h = createHarness(bot);
  const stop = attachTeleportKinematics(bot);
  try {
    const goalStarted = once(bot, 'goal_updated');
    const oldTask = h.call('give-item', { username: 'muxue', itemName: 'grass_block', count: 1 });
    await goalStarted;
    const stopped = await h.call('stop-action');
    assert.ok(!stopped.isError, text(stopped));
    assert.equal(bot.pathfinder.goal, null);
    assert.ok(Object.values(bot.controlState).every((state) => state === false));
    assert.ok((await oldTask).isError, '进行中的旧指令必须收到中断结果');
    assert.equal(callsOf(bot, 'toss').length, 0, '旧指令叫停后不应继续抛物品');

    const newTask = await h.call('give-item', { username: 'muxue', itemName: 'grass_block', count: 1 });
    assert.ok(!newTask.isError, text(newTask));
    assert.equal(callsOf(bot, 'toss').length, 1);
  } finally {
    stop();
  }
});
