// 复现：stop-action / 脚本超时时，正在进行（尚未完成）的挖掘要被真正中止，方块保持原样
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatWorld, createFakeBot } from './helpers/fake-bot.mjs';
import { createHarness, text, callsOf, sleep } from './helpers/harness.mjs';

async function waitFor(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await sleep(10);
  assert.ok(cond(), '等待条件超时');
}

function stoneSetup(digTimeMs) {
  const w = flatWorld();
  w.set(1, 64, 0, 'stone');
  w.set(1, 64, 1, 'stone');
  w.set(1, 65, 0, 'stone');
  const bot = createFakeBot(w, { inventory: [['stone_pickaxe', 1]] });
  bot.digTimeMs = digTimeMs;
  const h = createHarness(bot);
  return { w, bot, h };
}

test('前台 dig-block 挖到一半时 stop-action：挖掘被中止，方块不变，工具立即返回', async () => {
  const { w, bot, h } = stoneSetup(2000);
  const started = Date.now();
  const pending = h.call('dig-block', { x: 1, y: 64, z: 0 });
  await waitFor(() => callsOf(bot, 'dig').length === 1);
  assert.match(text(await h.call('stop-action')), /已停止/);
  const r = await pending;
  assert.ok(Date.now() - started < 1000, `应在挖完前返回（用时 ${Date.now() - started}ms）`);
  assert.equal(r.isError, true, text(r));
  assert.deepEqual(callsOf(bot, 'digAborted').map((c) => c.pos.toArray().join(',')), ['1,64,0']);
  assert.equal(callsOf(bot, 'digDone').length, 0);
  assert.equal(bot.targetDigBlock, null);
  await sleep(2200);
  assert.equal(w.name(1, 64, 0), 'stone', '原定的挖掘时间过后方块仍在');
  assert.equal(callsOf(bot, 'digDone').length, 0);
});

test('后台 mine-blocks 挖到一半时 stop-action：当前方块不再挖掉，后面的也不挖', async () => {
  const { w, bot, h } = stoneSetup(1500);
  const started = Date.now();
  await h.call('mine-blocks', { positions: [{ x: 1, y: 64, z: 0 }, { x: 1, y: 64, z: 1 }, { x: 1, y: 65, z: 0 }], collect: false, background: true });
  await waitFor(() => callsOf(bot, 'dig').length === 1);
  await h.call('stop-action');
  await h.factory.settle();
  assert.ok(Date.now() - started < 1200, `后台任务应很快结束（用时 ${Date.now() - started}ms）`);
  const ev = h.events.since(0, ['task']).map((e) => e.text).join('\n');
  assert.match(ev, /stop-action/);
  assert.equal(callsOf(bot, 'dig').length, 1);
  assert.equal(callsOf(bot, 'digAborted').length, 1);
  await sleep(1700);
  assert.deepEqual([w.name(1, 64, 0), w.name(1, 64, 1), w.name(1, 65, 0)], ['stone', 'stone', 'stone']);
  assert.equal(callsOf(bot, 'digDone').length, 0);
});

test('脚本超时时正在进行的挖掘也被中止（Promise.race 返回后不再挖完）', async () => {
  const { w, bot, h } = stoneSetup(10000);
  h.writeScript('slow-dig', `export default async function (ctx) {
    await ctx.tool('dig-block', { x: 1, y: 64, z: 0 });
    return 'dug';
  }`);
  const r = text(await h.call('run-script', { name: 'slow-dig', timeoutSeconds: 5 }));
  assert.match(r, /提前停止：达到时间上限 5 秒/);
  await waitFor(() => callsOf(bot, 'digAborted').length === 1, 1000);
  assert.equal(w.name(1, 64, 0), 'stone');
  assert.equal(bot.targetDigBlock, null);
}, { timeout: 30000 });

test('没有被打断时，挖掘照常完成（不影响正常采集）', async () => {
  const { w, bot, h } = stoneSetup(200);
  const r = await h.call('dig-block', { x: 1, y: 64, z: 0 });
  assert.match(text(r), /Dug stone/);
  assert.equal(w.name(1, 64, 0), 'air');
  assert.equal(callsOf(bot, 'digAborted').length, 0);
  assert.equal(callsOf(bot, 'digDone').length, 1);
});
