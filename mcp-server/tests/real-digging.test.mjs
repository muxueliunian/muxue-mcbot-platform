// 用项目安装的 mineflayer 真实 digging 插件（lib/plugins/digging.js）验证挖掘的中止：
// 只替换网络层（_client.write 记录协议包）和世界更新，挖掘流程本身是 mineflayer 的代码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { flatWorld, createFakeBot } from './helpers/fake-bot.mjs';
import { createHarness, text, sleep } from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const injectDigging = require('mineflayer/lib/plugins/digging.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await sleep(10);
  assert.ok(cond(), '等待条件超时');
}

// fake 世界 + 真实 digging 插件
function realDigBot(w, inventory = []) {
  const bot = createFakeBot(w, { inventory });
  bot.packets = [];
  bot._client = new EventEmitter();
  bot._client.write = (name, data) => {
    bot.packets.push({ name, status: data.status, location: data.location?.toArray?.().join(','), face: data.face });
  };
  bot.getEquipmentDestSlot = () => 5;
  bot.swings = 0;
  bot.swingArm = () => { bot.swings++; };
  // 服务器确认方块变化（mineflayer 的 _updateBlockState 会触发 blockUpdate 事件）
  bot._updateBlockState = (pos, stateId) => {
    const old = w.world.getBlock(pos);
    w.world.setBlockStateId(pos, stateId);
    const now = w.world.getBlock(pos);
    bot.emit(`blockUpdate:${pos}`, old, now);
    bot.emit('blockUpdate', old, now);
  };
  // lookAt 可以挂起，模拟转头还没完成
  bot.lookGate = null;
  bot.lookAt = async () => {
    bot.calls.push({ type: 'lookAt' });
    if (bot.lookGate) await bot.lookGate.promise;
  };
  injectDigging(bot);
  return bot;
}

const digPackets = (bot) => bot.packets.filter((p) => p.name === 'block_dig').map((p) => `${p.status}@${p.location}`);

test('真实 digging：前台 dig-block 在 lookAt 等待中被 stop-action，恢复后不发开始/完成包，方块不变', async () => {
  const w = flatWorld();
  w.set(1, 64, 0, 'dirt');
  const bot = realDigBot(w);
  const h = createHarness(bot);
  const waitTime = bot.digTime(bot.blockAt(w.get(1, 64, 0).position));
  bot.lookGate = deferred();
  const pending = h.call('dig-block', { x: 1, y: 64, z: 0 });
  await waitFor(() => bot.calls.some((c) => c.type === 'lookAt'));
  await h.call('stop-action');
  bot.lookGate.resolve();
  const r = await pending;
  assert.equal(r.isError, true, text(r));
  assert.match(text(r), /任务已失效/);
  await sleep(waitTime + 300);
  assert.deepEqual(digPackets(bot), []);
  assert.equal(w.name(1, 64, 0), 'dirt');
  assert.equal(bot.targetDigBlock, null);
  assert.equal(bot.swings, 0);
});

test('真实 digging：后台 mine-blocks 在 lookAt 等待中被 stop-action，不发包，后面的方块也不挖', async () => {
  const w = flatWorld();
  w.set(1, 64, 0, 'dirt');
  w.set(1, 64, 1, 'dirt');
  const bot = realDigBot(w);
  const h = createHarness(bot);
  bot.lookGate = deferred();
  await h.call('mine-blocks', { positions: [{ x: 1, y: 64, z: 0 }, { x: 1, y: 64, z: 1 }], collect: false, requireDrops: false, background: true });
  await waitFor(() => bot.calls.some((c) => c.type === 'lookAt'));
  await h.call('stop-action');
  bot.lookGate.resolve();
  await h.factory.settle();
  await sleep(1200);
  assert.deepEqual(digPackets(bot), []);
  assert.deepEqual([w.name(1, 64, 0), w.name(1, 64, 1)], ['dirt', 'dirt']);
  assert.match(h.events.since(0, ['task'])[0].text, /stop-action/);
});

test('真实 digging：开始挖以后被 stop-action，发出取消包，计时器和挥手都清掉，之后不再发完成包', async () => {
  const w = flatWorld();
  w.set(1, 64, 0, 'dirt');
  const bot = realDigBot(w);
  const h = createHarness(bot);
  const waitTime = bot.digTime(w.get(1, 64, 0));
  assert.ok(waitTime >= 500, `徒手挖泥土应要一段时间（${waitTime}ms）`);
  const pending = h.call('dig-block', { x: 1, y: 64, z: 0 });
  await waitFor(() => digPackets(bot).length === 1);
  await h.call('stop-action');
  const r = await pending;
  assert.equal(r.isError, true, text(r));
  assert.deepEqual(digPackets(bot), ['0@1,64,0', '1@1,64,0']);
  const swings = bot.swings;
  await sleep(waitTime + 500);
  assert.deepEqual(digPackets(bot), ['0@1,64,0', '1@1,64,0'], '取消后不应再发完成包');
  assert.equal(bot.swings, swings, '挥手计时器应已清除');
  assert.equal(w.name(1, 64, 0), 'dirt');
  assert.equal(bot.targetDigBlock, null);
});

test('真实 digging：脚本超时导致任务结束时，进行中的挖掘被取消且计时器清掉', async () => {
  const w = flatWorld();
  w.set(1, 64, 0, 'obsidian'); // 徒手挖黑曜石要很久，一定在挖的过程中超时
  const bot = realDigBot(w);
  const h = createHarness(bot);
  h.writeScript('long-dig', `export default async function (ctx) {
    await ctx.tool('dig-block', { x: 1, y: 64, z: 0 });
    return 'dug';
  }`);
  const r = text(await h.call('run-script', { name: 'long-dig', timeoutSeconds: 5 }));
  assert.match(r, /提前停止：达到时间上限 5 秒/);
  await waitFor(() => digPackets(bot).length === 2, 1000);
  assert.deepEqual(digPackets(bot), ['0@1,64,0', '1@1,64,0']);
  const swings = bot.swings;
  await sleep(800);
  assert.equal(bot.swings, swings);
  assert.equal(w.name(1, 64, 0), 'obsidian');
  assert.equal(bot.targetDigBlock, null);
}, { timeout: 30000 });

test('真实 digging：没被打断时照常发开始、完成包并挖掉方块', async () => {
  const w = flatWorld();
  w.set(1, 64, 0, 'dirt');
  const bot = realDigBot(w);
  const h = createHarness(bot);
  const r = await h.call('dig-block', { x: 1, y: 64, z: 0 });
  assert.match(text(r), /Dug dirt/);
  assert.deepEqual(digPackets(bot), ['0@1,64,0', '2@1,64,0']);
  assert.equal(w.name(1, 64, 0), 'air');
  const swings = bot.swings;
  await sleep(500);
  assert.equal(bot.swings, swings, '完成后挥手计时器应已清除');
  assert.equal(bot.targetDigBlock, null);
});
