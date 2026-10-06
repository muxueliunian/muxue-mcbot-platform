import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createWebServer, listBots, readActivity, requestControl, parseWebArgs } from '../../scripts/webui.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-webui-'));
const heartbeat = (dir, name, extra = {}) => fs.writeFileSync(path.join(dir, `companion-${name}.json`),
  JSON.stringify({ pid: process.pid, agent: 'dsh', updatedAt: Date.now(), name, nickname: 'DeepSeek', body: 'server', busy: false, ...extra }));
const act = (dir, name, rows) => fs.appendFileSync(path.join(dir, `activity-${name}.jsonl`), rows.map((r) => JSON.stringify(r) + '\n').join(''));

test('WebUI 参数：默认端口 8770，只认识 --port、--runtime、--open', () => {
  assert.equal(parseWebArgs([]).port, 8770);
  assert.equal(parseWebArgs(['--port', '0']).port, 0);
  assert.throws(() => parseWebArgs(['--host', '0.0.0.0']), /不认识的参数/);
  assert.throws(() => parseWebArgs(['--port', 'x']), /--port/);
});

test('Bot 列表：心跳新鲜且进程在才算在线，停掉的 Bot 靠活动记录也列出来', () => {
  const dir = tmp();
  try {
    heartbeat(dir, 'ServerBot', { busy: true });
    fs.writeFileSync(path.join(dir, 'session-ServerBot.json'), JSON.stringify({ provider: 'dsh', contextTokens: 11437, lastRequestAt: 5, bodyScope: { body: 'server', worldId: 'w1' } }));
    heartbeat(dir, 'Old', { updatedAt: Date.now() - 120000 });
    act(dir, 'Gone', [{ t: 1, kind: 'info', text: 'x' }]);
    fs.writeFileSync(path.join(dir, 'companion-bad name.json'), '{}');
    const bots = listBots(dir);
    assert.deepEqual(bots.map((b) => b.name), ['Gone', 'Old', 'ServerBot']);
    const sb = bots.find((b) => b.name === 'ServerBot');
    assert.equal(sb.running, true); assert.equal(sb.busy, true); assert.equal(sb.contextTokens, 11437); assert.equal(sb.worldId, 'w1');
    assert.equal(bots.find((b) => b.name === 'Old').running, false);
    assert.equal(bots.find((b) => b.name === 'Gone').running, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('活动记录按字节位置增量读，半行留到下次，文件轮转变小就从头读', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'activity-ServerBot.jsonl');
    act(dir, 'ServerBot', [{ t: 1, kind: 'event', type: 'chat', text: '你好' }, { t: 2, kind: 'reply', text: '在呢' }]);
    const first = readActivity(dir, 'ServerBot');
    assert.deepEqual(first.items.map((i) => i.text), ['你好', '在呢']);
    assert.equal(first.offset, fs.statSync(file).size);
    fs.appendFileSync(file, JSON.stringify({ t: 3, kind: 'tool', name: 'observe' }) + '\n' + '{"t":4,"kind":"re');
    const second = readActivity(dir, 'ServerBot', first.offset);
    assert.deepEqual(second.items.map((i) => i.name), ['observe']);
    fs.appendFileSync(file, 'ply","text":"好"}\n');
    assert.deepEqual(readActivity(dir, 'ServerBot', second.offset).items.map((i) => i.text), ['好']);
    fs.writeFileSync(file, JSON.stringify({ t: 9, kind: 'info', text: '新文件' }) + '\n');
    assert.deepEqual(readActivity(dir, 'ServerBot', second.offset + 1000).items.map((i) => i.text), ['新文件']);
    assert.deepEqual(readActivity(dir, 'Nobody'), { offset: 0, items: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('叫停和停止托管只放标记文件；不在线、非 ServerBody 叫停会被拒绝', () => {
  const dir = tmp();
  try {
    heartbeat(dir, 'ServerBot');
    heartbeat(dir, 'Claude', { body: 'mineflayer' });
    assert.deepEqual(requestControl(dir, 'ServerBot', 'halt'), { ok: true });
    assert.ok(fs.existsSync(path.join(dir, 'companion-ServerBot.halt')));
    assert.deepEqual(requestControl(dir, 'ServerBot', 'stop'), { ok: true });
    assert.ok(fs.existsSync(path.join(dir, 'companion-ServerBot.stop')));
    assert.match(requestControl(dir, 'Claude', 'halt').error, /ServerBody/);
    assert.match(requestControl(dir, 'Nobody', 'stop').error, /没有在托管/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WebUI 服务：只听本机，要令牌 Cookie，拒绝别的 Host', async () => {
  const dir = tmp();
  const web = createWebServer({ runtime: dir, token: 'ab12' });
  try {
    heartbeat(dir, 'ServerBot');
    act(dir, 'ServerBot', [{ t: 1, kind: 'reply', text: '在呢' }]);
    const port = await web.listen(0);
    assert.equal(web.server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/bots`)).status, 403, '没有 Cookie');
    assert.equal((await fetch(`${base}/`)).status, 403);
    assert.equal((await fetch(`${base}/?t=wrong`, { redirect: 'manual' })).status, 403);
    const login = await fetch(`${base}/?t=ab12`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200); assert.match(await page.text(), /mcbot 控制台/);
    const bots = await (await fetch(`${base}/api/bots`, { headers: { cookie } })).json();
    assert.equal(bots.bots[0].name, 'ServerBot');
    const feed = await (await fetch(`${base}/api/activity?name=ServerBot`, { headers: { cookie } })).json();
    assert.equal(feed.items[0].text, '在呢');
    assert.equal((await fetch(`${base}/api/activity?name=../x`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${base}/api/halt?name=ServerBot`, { headers: { cookie } })).status, 404, '只接受 POST');
    assert.equal((await fetch(`${base}/api/halt?name=ServerBot`, { method: 'POST', headers: { cookie } })).status, 200);
    // fetch 不让改 Host，用 http.request 模拟 DNS 重绑定
    const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/bots', headers: { cookie, host: `evil.example:${port}` } },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(status, 403, 'DNS 重绑定');
  } finally { await web.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
