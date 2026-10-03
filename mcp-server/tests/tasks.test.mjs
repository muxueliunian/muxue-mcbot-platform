// 任务所有权与取消：脚本受控接口、后台子调用、stop/超时/断线/换维度后旧任务的动作
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatWorld, createFakeBot, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, callsOf, sleep } from './helpers/harness.mjs';
import { isSafeMovements, ActionDenied } from '../dist/action-policy.js';

const BOT_SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bot-scripts');
const INV = [['stone_pickaxe', 1], ['dirt', 8]];

function setup(opts = {}) {
  const w = flatWorld();
  w.set(1, 64, 0, 'dirt');
  w.set(1, 64, 1, 'dirt');
  const bot = createFakeBot(w, { inventory: INV });
  const h = createHarness(bot, opts);
  return { w, bot, h };
}

const denied = (bot) => {
  const list = [];
  bot.on('mcbot:denied', (e) => list.push(e));
  return list;
};

test('脚本的 ctx.bot：可以查询，但直接挖方块、底层连接、寻路配置、聊天、改属性都被拒绝', async () => {
  const { w, bot, h } = setup();
  h.writeScript('read-only', `export default async function (ctx) {
    const b = ctx.bot.blockAt(new ctx.Vec3(1, 64, 0));
    return [b.name, ctx.bot.inventory.items().length, Math.floor(ctx.bot.entity.position.y), ctx.bot.game.dimension].join(',');
  }`);
  assert.match(text(await h.call('run-script', { name: 'read-only' })), /结果：dirt,2,64,overworld/);

  const cases = {
    'raw-dig': ['await ctx.bot.dig(ctx.bot.blockAt(new ctx.Vec3(1, 64, 0)));', /不在本次任务的挖掘目标里/],
    'raw-client': ['ctx.bot._client.write("x", {});', /不能使用 bot._client/],
    'raw-movements': ['ctx.bot.pathfinder.setMovements({});', /setMovements is not a function/],
    'raw-movements-read': ['if (ctx.bot.pathfinder.movements !== undefined) throw new Error("leak"); throw new Error("hidden");', /hidden/],
    'raw-chat': ['ctx.bot.chat("/fill ~ ~ ~ ~ ~ ~ air");', /不能使用 bot.chat/],
    'say-command': ['await ctx.say("/kill @e");', /不能发送 \/ 开头的命令/],
    'raw-set': ['ctx.bot.dig = async () => {};', /不能修改 bot.dig/],
    'raw-place': ['await ctx.bot.placeBlock(ctx.bot.blockAt(new ctx.Vec3(2, 63, 0)), new ctx.Vec3(0, 1, 0));', /不在本次任务的放置目标里/],
  };
  for (const [name, [body, expected]] of Object.entries(cases)) {
    h.writeScript(name, `export default async function (ctx) { ${body} return 'done'; }`);
    const r = text(await h.call('run-script', { name }));
    assert.match(r, expected, name);
    assert.doesNotMatch(r, /结果：done/, name);
  }
  assert.deepEqual(bot.calls.filter((c) => ['dig', 'place', 'chat'].includes(c.type)), []);
  assert.equal(w.name(1, 64, 0), 'dirt');
});

test('项目现有脚本都能加载', async () => {
  const { h } = setup({ scriptsDir: BOT_SCRIPTS });
  const r = text(await h.call('list-scripts'));
  for (const name of ['dig-staircase', 'gather-wood', 'scan-air', 'scan-ground', 'travel-to']) {
    assert.match(r, new RegExp(`- ${name}：`));
  }
  assert.doesNotMatch(r, /加载失败|缺少 default/);
  // 只读脚本在受控接口下照常工作
  const scan = text(await h.call('run-script', { name: 'scan-air', params: { from: { x: 1, y: 64, z: 0 }, to: { x: 1, y: 64, z: 1 } } }));
  assert.match(scan, /外壳全是实心方块/);
  const ground = text(await h.call('run-script', { name: 'scan-ground', params: { r: 1 } }));
  assert.match(ground, /陆地高度 63~64/);
});

test('后台脚本调用自己的子工具可以执行；同时外部的动作被拒绝，聊天和查询可用', async () => {
  const { w, bot, h } = setup();
  h.writeScript('slow-dig', `export default async function (ctx) {
    await ctx.sleep(300);
    return await ctx.tool('dig-block', { x: 1, y: 64, z: 0 });
  }`);
  const start = await h.call('run-script', { name: 'slow-dig', background: true });
  assert.match(text(start), /已在后台开始任务/);
  const outside = await h.call('dig-block', { x: 1, y: 64, z: 1 });
  assert.equal(outside.isError, true);
  assert.match(text(outside), /后台任务 .* 还在运行/);
  assert.match(text(await h.call('send-chat', { message: '在挖' })), /Sent message/);
  assert.match(text(await h.call('get-position')), /Current position/);
  await h.factory.settle();
  assert.deepEqual(callsOf(bot, 'dig').map((c) => c.pos.toArray().join(',')), ['1,64,0']);
  assert.equal(w.name(1, 64, 1), 'dirt');
  const task = h.events.since(0, ['task']);
  assert.equal(task.length, 1);
  assert.match(task[0].text, /Dug dirt at \(1, 64, 0\)/);
});

test('stop-action 发生在脚本 await 中：之后恢复的旧代码发不出动作', async () => {
  const { bot, h } = setup();
  const seen = denied(bot);
  h.writeScript('zombie', `export default async function (ctx) {
    await new Promise((r) => setTimeout(r, 300));
    await ctx.bot.equip(ctx.bot.inventory.items()[0], 'hand');
    await ctx.tool('dig-block', { x: 1, y: 64, z: 0 });
    return 'still running';
  }`);
  await h.call('run-script', { name: 'zombie', background: true });
  await sleep(100);
  await h.call('stop-action');
  await h.factory.settle();
  await sleep(50);
  assert.equal(callsOf(bot, 'equip').length, 0);
  assert.equal(callsOf(bot, 'dig').length, 0);
  assert.ok(seen.some((e) => /stop-action/.test(e.reason)));
  assert.match(h.events.since(0, ['task'])[0].text, /任务已失效|stop-action/);
  assert.doesNotMatch(h.events.since(0, ['task'])[0].text, /still running/);
});

test('脚本超时后 Promise.race 已返回，脚本残留代码随后恢复也发不出动作', async () => {
  const { bot, h } = setup();
  h.writeScript('overtime', `export default async function (ctx) {
    await new Promise((r) => setTimeout(r, 7500));
    await ctx.bot.equip(ctx.bot.inventory.items()[0], 'hand');
    ctx.bot.setControlState('forward', true);
    return 'late';
  }`);
  const started = Date.now();
  const r = text(await h.call('run-script', { name: 'overtime', timeoutSeconds: 5 }));
  assert.match(r, /提前停止：达到时间上限 5 秒/);
  assert.ok(Date.now() - started < 7400, '应在脚本恢复前返回');
  const seen = denied(bot);
  await sleep(800);
  assert.equal(callsOf(bot, 'equip').length, 0);
  assert.equal(bot.controlState.forward, false);
  assert.ok(seen.some((e) => e.what === 'equip'));
}, { timeout: 20000 });

test('脚本注册的监听器在脚本结束后移除，不能借事件继续动作', async () => {
  const { bot, h } = setup();
  const baseline = bot.listenerCount('physicsTick');
  h.writeScript('listener', `export default async function (ctx) {
    ctx.bot.on('physicsTick', () => { ctx.bot.equip(ctx.bot.inventory.items()[0], 'hand').catch(() => {}); });
    return 'registered';
  }`);
  assert.match(text(await h.call('run-script', { name: 'listener' })), /registered/);
  assert.equal(bot.listenerCount('physicsTick'), baseline);
  bot.emit('physicsTick');
  await sleep(20);
  assert.equal(callsOf(bot, 'equip').length, 0);
});

test('断线：旧 Bot 上的旧任务动作被拒绝；重连后的新 Bot 自动装好守卫和安全寻路', async () => {
  const { bot, h } = setup();
  h.writeScript('waiter', `export default async function (ctx) {
    await new Promise((r) => setTimeout(r, 300));
    await ctx.bot.equip(ctx.bot.inventory.items()[0], 'hand');
    return 'late';
  }`);
  await h.call('run-script', { name: 'waiter', background: true });
  await sleep(50);
  bot.emit('end', 'test disconnect');
  await h.factory.settle();
  assert.equal(callsOf(bot, 'equip').length, 0);
  assert.match(h.events.since(0, ['task'])[0].text, /连接已断开/);

  const fresh = createFakeBot(flatWorld(), { inventory: INV });
  h.setBot(fresh);
  assert.ok(isSafeMovements(fresh.pathfinder.movements));
  assert.equal(fresh.pathfinder.movements.canDig, false);
  await assert.rejects(fresh.dig(fresh.blockAt(new Vec3(1, 63, 0))), ActionDenied);
  assert.equal(callsOf(fresh, 'dig').length, 0);
  // 旧 Bot 的动作一律拒绝（例如残留的定时器）
  await assert.rejects(bot.equip(bot.inventory.items()[0], 'hand'), /连接已断开/);
});

test('换维度：旧任务的动作被拒绝', async () => {
  const { bot, h } = setup();
  h.writeScript('dim', `export default async function (ctx) {
    await new Promise((r) => setTimeout(r, 300));
    await ctx.bot.equip(ctx.bot.inventory.items()[0], 'hand');
    return 'late';
  }`);
  await h.call('run-script', { name: 'dim', background: true });
  await sleep(50);
  bot.game.dimension = 'the_nether';
  await h.factory.settle();
  assert.equal(callsOf(bot, 'equip').length, 0);
  assert.match(h.events.since(0, ['task'])[0].text, /维度已从 overworld 变为 the_nether/);
});

test('前台动作同一时间只允许一个；查询类工具不受影响', async () => {
  const { bot, h } = setup();
  h.writeScript('wait', `export default async function (ctx) { await ctx.sleep(300); return 'ok'; }`);
  const first = h.call('run-script', { name: 'wait' });
  await sleep(50);
  const second = await h.call('dig-block', { x: 1, y: 64, z: 0 });
  assert.equal(second.isError, true);
  assert.match(text(second), /run-script 还在执行/);
  assert.match(text(await h.call('get-position')), /Current position/);
  assert.match(text(await first), /结果：ok/);
  assert.equal(callsOf(bot, 'dig').length, 0);
  assert.match(text(await h.call('dig-block', { x: 1, y: 64, z: 0 })), /Dug dirt/);
});

test('invoke 只能在任务内部调用', async () => {
  const { h } = setup();
  await assert.rejects(h.factory.invoke('get-position'), /只能在任务内部调用/);
});

test('图片结果：脚本和后台事件只拿到文字说明，不带 Base64', async () => {
  const { h } = setup();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 7)]);
  h.factory.registerTool('test-image', 'test', {}, async () => h.factory.createImageResponse(png, 'image/png', '测试图'));
  const direct = await h.call('test-image');
  assert.equal(direct.content[1].type, 'image');
  assert.deepEqual(Buffer.from(direct.content[1].data, 'base64'), png);
  h.writeScript('img', `export default async function (ctx) { return await ctx.tool('test-image'); }`);
  const r = text(await h.call('run-script', { name: 'img' }));
  assert.match(r, /测试图/);
  assert.match(r, /结果里有 1 张图片/);
  assert.doesNotMatch(r, /undefined/);
  await h.call('run-script', { name: 'img', background: true });
  await h.factory.settle();
  const ev = h.events.since(0, ['task']).map((e) => e.text).join('\n');
  assert.match(ev, /结果里有 1 张图片/);
  assert.ok(!ev.includes(png.toString('base64').slice(0, 40)));
  assert.ok(ev.length < 1000);
  // 类型不符、过大
  assert.equal(h.factory.createImageResponse(png, 'image/jpeg', 'x').isError, true);
  assert.equal(h.factory.createImageResponse(Buffer.concat([png, Buffer.alloc(3_600_000)]), 'image/png', 'x').isError, true);
});
