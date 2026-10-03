// YSM 动画：假 RCON 服务器测认证、命令、错误处理；映射表查找；emote 工具接上 YSM
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tempDir, createHarness, text } from './helpers/harness.mjs';
import { flatWorld, createFakeBot } from './helpers/fake-bot.mjs';
import { EventEmitter } from 'node:events';
import {
  rconCommand, playYsmAnimation, loadYsmEmotes, ysmAnimationFor, isValidAnimationName,
  playYsmWithAutoStop, cancelYsmIdle, pendingYsmAnimation, ysmDurationFor
} from '../dist/ysm.js';

const PASSWORD = 'test-secret';

function packet(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
}

// 假 RCON 服务器：认证包（类型 3）密码对就回原 id，不对回 -1；命令包（类型 2）记下来并回一句空回复
async function fakeRcon({ reply = '', silent = false } = {}) {
  const commands = [];
  const auths = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('utf8', 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (silent) continue;
        if (type === 3) {
          auths.push(body);
          socket.write(packet(body === PASSWORD ? id : -1, 2, ''));
        } else if (type === 2) {
          commands.push(body);
          socket.write(packet(id, 0, reply));
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { port, commands, auths, close: () => new Promise((r) => server.close(r)) };
}

function serverDirWith(props) {
  const dir = tempDir('mcbot-ysm-server-');
  const lines = Object.entries(props).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(dir, 'server.properties'), `#Minecraft server properties\n${lines.join('\n')}\n`);
  return dir;
}

// 找一个现在没人监听的端口
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

const savedEnv = { MC_SERVER_DIR: process.env.MC_SERVER_DIR, MCBOT_DATA_DIR: process.env.MCBOT_DATA_DIR };
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('RCON：认证成功后执行命令，ysm play 带上用户名和动画名', async () => {
  const rcon = await fakeRcon({ reply: 'ok-reply' });
  try {
    const dir = serverDirWith({ 'enable-rcon': 'true', 'rcon.port': rcon.port, 'rcon.password': PASSWORD });
    const r = await rconCommand('list', { dir });
    assert.deepEqual(r, { ok: true, reply: 'ok-reply' });
    const p = await playYsmAnimation('Claude', 'extra3', { dir });
    assert.equal(p.ok, true);
    assert.deepEqual(rcon.commands, ['list', 'ysm play Claude extra3']);
    assert.deepEqual(rcon.auths, [PASSWORD, PASSWORD]);
  } finally {
    await rcon.close();
  }
});

test('RCON：密码错误返回中文错误，不执行命令', async () => {
  const rcon = await fakeRcon();
  try {
    const dir = serverDirWith({ 'enable-rcon': 'true', 'rcon.port': rcon.port, 'rcon.password': 'wrong' });
    const r = await playYsmAnimation('Claude', 'extra1', { dir });
    assert.equal(r.ok, false);
    assert.match(r.error, /认证失败/);
    assert.deepEqual(rcon.commands, []);
  } finally {
    await rcon.close();
  }
});

test('RCON：连不上、没回应、没开 RCON、没有配置文件都返回中文错误', async () => {
  const port = await freePort();
  const refused = await rconCommand('list', { dir: serverDirWith({ 'enable-rcon': 'true', 'rcon.port': port, 'rcon.password': PASSWORD }) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /连不上 RCON/);

  const silent = await fakeRcon({ silent: true });
  try {
    const started = Date.now();
    const r = await rconCommand('list', { dir: serverDirWith({ 'enable-rcon': 'true', 'rcon.port': silent.port, 'rcon.password': PASSWORD }), timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.match(r.error, /没有回应/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await silent.close();
  }

  const off = await rconCommand('list', { dir: serverDirWith({ 'enable-rcon': 'false', 'rcon.port': port, 'rcon.password': PASSWORD }) });
  assert.match(off.error, /没开 RCON/);

  const missing = await rconCommand('list', { dir: path.join(tempDir('mcbot-ysm-empty-'), 'nope') });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /读不到服务器配置/);
});

test('动画名非法时直接拒绝，不连 RCON', async () => {
  const rcon = await fakeRcon();
  try {
    const dir = serverDirWith({ 'enable-rcon': 'true', 'rcon.port': rcon.port, 'rcon.password': PASSWORD });
    for (const bad of ['extra0; op muxue', 'extra0\nstop', 'a b', '', 'x'.repeat(65), '动画']) {
      assert.equal(isValidAnimationName(bad), false, bad);
      const r = await playYsmAnimation('Claude', bad, { dir });
      assert.equal(r.ok, false);
      assert.match(r.error, /不合法/);
    }
    assert.equal((await playYsmAnimation('Cl aude', 'extra0', { dir })).ok, false);
    for (const good of ['extra0', 'ysm:wave', 'idle.sit-2']) assert.equal(isValidAnimationName(good), true, good);
    assert.deepEqual(rcon.commands, []);
    assert.deepEqual(rcon.auths, []);
  } finally {
    await rcon.close();
  }
});

test('映射表：按 current 模型查表情；文件不存在当空表；坏 JSON 给出说明', () => {
  const dir = tempDir('mcbot-ysm-data-');
  const file = path.join(dir, 'ysm-emotes.json');
  assert.deepEqual(loadYsmEmotes(file), { models: {} });
  assert.equal(ysmAnimationFor('wave', loadYsmEmotes(file)), undefined);

  fs.writeFileSync(file, JSON.stringify({
    _note: '注释',
    current: 'ds_whale.ysm',
    'ds_whale.ysm': { wave: 'extra1', nod: 'extra2', bad: 3 },
    'wine_fox/13_matured': { wave: 'extra5' }
  }));
  const table = loadYsmEmotes(file);
  assert.equal(table.current, 'ds_whale.ysm');
  assert.deepEqual(table.models['ds_whale.ysm'], { wave: 'extra1', nod: 'extra2' });
  assert.equal(table.models._note, undefined);
  assert.equal(ysmAnimationFor('wave', table), 'extra1');
  assert.equal(ysmAnimationFor('spin', table), undefined);
  assert.equal(ysmAnimationFor('wave', { ...table, current: 'wine_fox/13_matured' }), 'extra5');
  assert.equal(ysmAnimationFor('wave', { ...table, current: undefined }), undefined);
  assert.equal(table.durations, undefined);
  assert.equal(ysmDurationFor('extra6', table), 6);

  fs.writeFileSync(file, JSON.stringify({ _durations: { extra6: 8, bad: 'x', zero: 0 }, current: 'm', m: {} }));
  const timed = loadYsmEmotes(file);
  assert.deepEqual(timed.durations, { extra6: 8 });
  assert.equal(ysmDurationFor('extra6', timed), 8);
  assert.equal(ysmDurationFor('extra7', timed), 6);

  fs.writeFileSync(file, '{ 坏掉的');
  const broken = loadYsmEmotes(file);
  assert.deepEqual(broken.models, {});
  assert.match(broken.error, /读不了/);

  // 默认路径走环境变量 MCBOT_DATA_DIR
  const envDir = tempDir('mcbot-ysm-data-');
  fs.writeFileSync(path.join(envDir, 'ysm-emotes.json'), JSON.stringify({ current: 'm', m: { jump: 'extra7' } }));
  process.env.MCBOT_DATA_DIR = envDir;
  assert.equal(ysmAnimationFor('jump'), 'extra7');
});

test('emote 工具：animation 直接播；映射到的表情先播动画再做原动作；RCON 失败只做原动作', async () => {
  const rcon = await fakeRcon();
  try {
    process.env.MC_SERVER_DIR = serverDirWith({ 'enable-rcon': 'true', 'rcon.port': rcon.port, 'rcon.password': PASSWORD });
    const dataDir = tempDir('mcbot-ysm-data-');
    process.env.MCBOT_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(dataDir, 'ysm-emotes.json'), JSON.stringify({ current: 'ds_whale.ysm', 'ds_whale.ysm': { wave: 'extra1' } }));
    const bot = createFakeBot(flatWorld());
    let swings = 0;
    bot.swingArm = () => { swings++; };
    const h = createHarness(bot);

    assert.match(text(await h.call('emote', {})), /至少要给一个/);

    const direct = text(await h.call('emote', { animation: 'extra3' }));
    assert.match(direct, /播放了 YSM 动画 extra3/);
    assert.equal(swings, 0);

    const mapped = text(await h.call('emote', { action: 'wave' }));
    assert.match(mapped, /挥了挥手/);
    assert.match(mapped, /播放了 YSM 动画 extra1/);
    assert.equal(swings, 3);

    assert.match(text(await h.call('emote', { animation: 'bad name' })), /不合法/);
    assert.deepEqual(rcon.commands, ['ysm play Claude extra3', 'ysm play Claude extra1']);

    // 没映射的表情不连 RCON
    const plain = text(await h.call('emote', { action: 'look' }));
    assert.doesNotMatch(plain, /YSM/);
    assert.equal(rcon.commands.length, 2);

    // RCON 连不上：只做原来的动作，结果里说明
    process.env.MC_SERVER_DIR = serverDirWith({ 'enable-rcon': 'true', 'rcon.port': await freePort(), 'rcon.password': PASSWORD });
    const failed = text(await h.call('emote', { action: 'wave' }));
    assert.match(failed, /挥了挥手/);
    assert.match(failed, /YSM 动画 extra1 没播成：连不上 RCON.*只做了原来的动作/);
    assert.equal(swings, 6);
  } finally {
    cancelYsmIdle();
    await rcon.close();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只有 username 和 end 事件的假 Bot，直接测自动收尾
function tinyBot() {
  const bot = new EventEmitter();
  bot.username = 'Claude';
  return bot;
}

test('自动收尾：到时间发 idle；连播两个只在第二个后收尾一次；断线不发；收尾失败不抛', async () => {
  const rcon = await fakeRcon();
  try {
    const dir = serverDirWith({ 'enable-rcon': 'true', 'rcon.port': rcon.port, 'rcon.password': PASSWORD });
    const bot = tinyBot();

    assert.equal((await playYsmWithAutoStop(bot, 'extra6', 0.2, { dir })).ok, true);
    assert.equal(pendingYsmAnimation(), 'extra6');
    await sleep(500);
    assert.deepEqual(rcon.commands, ['ysm play Claude extra6', 'ysm play Claude idle']);
    assert.equal(pendingYsmAnimation(), undefined);
    assert.equal(bot.listenerCount('end'), 0);

    rcon.commands.length = 0;
    await playYsmWithAutoStop(bot, 'extra6', 0.3, { dir });
    await sleep(150);
    await playYsmWithAutoStop(bot, 'extra7', 0.3, { dir });
    assert.equal(bot.listenerCount('end'), 1);
    await sleep(200);
    // 第一个的时间已经过了，但被第二个顶掉了，还没收尾
    assert.deepEqual(rcon.commands, ['ysm play Claude extra6', 'ysm play Claude extra7']);
    await sleep(400);
    assert.deepEqual(rcon.commands, ['ysm play Claude extra6', 'ysm play Claude extra7', 'ysm play Claude idle']);

    // 没播成（名字不合法）时，前一个动画的收尾计时保留
    rcon.commands.length = 0;
    await playYsmWithAutoStop(bot, 'extra6', 0.3, { dir });
    assert.equal((await playYsmWithAutoStop(bot, 'bad name', 5, { dir })).ok, false);
    assert.equal(pendingYsmAnimation(), 'extra6');
    await sleep(500);
    assert.deepEqual(rcon.commands, ['ysm play Claude extra6', 'ysm play Claude idle']);

    // 断线：清掉计时器，不发命令
    rcon.commands.length = 0;
    await playYsmWithAutoStop(bot, 'extra6', 0.2, { dir });
    bot.emit('end', 'quit');
    assert.equal(pendingYsmAnimation(), undefined);
    await sleep(400);
    assert.deepEqual(rcon.commands, ['ysm play Claude extra6']);
  } finally {
    cancelYsmIdle();
    await rcon.close();
  }

  // 收尾时服务器已经关了：只记日志，不抛异常
  const gone = await fakeRcon();
  const goneDir = serverDirWith({ 'enable-rcon': 'true', 'rcon.port': gone.port, 'rcon.password': PASSWORD });
  await playYsmWithAutoStop(tinyBot(), 'extra6', 0.2, { dir: goneDir });
  await gone.close();
  await sleep(500);
  assert.equal(pendingYsmAnimation(), undefined);
});

test('emote 自动收尾：默认时长读 _durations；身体类工具开始时立刻收尾；聊天不打断；idle 不再安排收尾', async () => {
  const rcon = await fakeRcon();
  try {
    process.env.MC_SERVER_DIR = serverDirWith({ 'enable-rcon': 'true', 'rcon.port': rcon.port, 'rcon.password': PASSWORD });
    const dataDir = tempDir('mcbot-ysm-data-');
    process.env.MCBOT_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(dataDir, 'ysm-emotes.json'), JSON.stringify({ _durations: { extra6: 8 }, current: 'ds_whale.ysm', 'ds_whale.ysm': {} }));
    const h = createHarness(createFakeBot(flatWorld()));

    assert.match(text(await h.call('emote', { animation: 'extra6' })), /extra6.*8 秒后自动停/);
    assert.match(text(await h.call('emote', { animation: 'extra3' })), /extra3.*6 秒后自动停/);
    assert.match(text(await h.call('emote', { animation: 'extra6', seconds: 1 })), /1 秒后自动停/);
    assert.equal(pendingYsmAnimation(), 'extra6');
    await sleep(1400);
    assert.deepEqual(rcon.commands, ['ysm play Claude extra6', 'ysm play Claude extra3', 'ysm play Claude extra6', 'ysm play Claude idle']);

    // 聊天不是身体类工具，不打断跳舞；转头、走路这类工具一开始就收尾
    rcon.commands.length = 0;
    await h.call('emote', { animation: 'extra7', seconds: 30 });
    await h.call('send-chat', { message: '看我跳舞' });
    assert.equal(pendingYsmAnimation(), 'extra7');
    await h.call('look-at', { x: 5, y: 65, z: 5 });
    assert.equal(pendingYsmAnimation(), undefined);
    await sleep(300);
    assert.deepEqual(rcon.commands, ['ysm play Claude extra7', 'ysm play Claude idle']);

    // 手动播 idle：停下当前动画，之后不再安排收尾
    rcon.commands.length = 0;
    await h.call('emote', { animation: 'extra6', seconds: 1 });
    assert.match(text(await h.call('emote', { animation: 'idle' })), /回到待机/);
    assert.equal(pendingYsmAnimation(), undefined);
    await sleep(1300);
    assert.deepEqual(rcon.commands, ['ysm play Claude extra6', 'ysm play Claude idle']);
  } finally {
    cancelYsmIdle();
    await rcon.close();
  }
});
