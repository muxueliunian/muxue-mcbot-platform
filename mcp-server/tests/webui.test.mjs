import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createWebServer, listBots, readActivity, requestControl, parseWebArgs } from '../../scripts/webui.mjs';
import { claudeModelsFrom, codexModelsFrom, dshModelsFrom, createModelCatalog } from '../../scripts/agent-models.mjs';
import { normalizeProfile, saveProfile, loadProfiles, deleteProfile, inspectConnection, launchArgs, createLauncher, accountDirs } from '../../scripts/webui-profiles.mjs';

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

// ---- 配置页 ----
const connection = (dir, extra = {}) => {
  const file = path.join(dir, 'connection.json');
  fs.writeFileSync(file, JSON.stringify({ protocol: 2, backend: 'server', username: 'Claude', worldId: 'alpha', token: 'secret-token', endpoint: 'http://127.0.0.1:8767/v2', ...extra }));
  return file;
};
const profile = (dir, extra = {}) => ({ label: '小克试玩', agent: 'claude', effort: 'low', connectionFile: connection(dir), ...extra });

test('配置档案：只收认识的字段，不存 API key；思考强度按 Agent 分；路径要完整', () => {
  const dir = tmp();
  try {
    const p = normalizeProfile(profile(dir, { model: 'claude-sonnet-5-5', configDir: '~/.claude-r', idleMinutes: '5', rotateTokens: '' }));
    assert.match(p.id, /^[0-9a-f]{8}$/);
    assert.equal(p.configDir, path.join(os.homedir(), '.claude-r'));
    assert.equal(p.idleMinutes, 5); assert.equal(p.rotateTokens, null);
    assert.deepEqual(p.credential, { kind: 'login' });
    assert.throws(() => normalizeProfile(profile(dir, { apiKey: 'sk-x' })), /不认识的字段：apiKey/);
    assert.throws(() => normalizeProfile(profile(dir, { credential: { kind: 'apiKey', value: 'sk-x' } })), /以后再做/);
    assert.throws(() => normalizeProfile(profile(dir, { agent: 'gemini' })), /Agent/);
    assert.throws(() => normalizeProfile(profile(dir, { agent: 'dsh', effort: 'medium' })), /low、high、max/);
    assert.equal(normalizeProfile(profile(dir, { effort: 'max' })).effort, 'max');
    assert.equal(normalizeProfile(profile(dir, { agent: 'codex', effort: 'ultra' })).effort, 'ultra');
    assert.throws(() => normalizeProfile(profile(dir, { effort: 'ultra' })), /思考强度/);
    assert.throws(() => normalizeProfile(profile(dir, { nickname: '-Headless' })), /不能以 - 开头/);
    assert.throws(() => normalizeProfile(profile(dir, { model: 'a b' })), /模型名/);
    assert.throws(() => normalizeProfile(profile(dir, { memoryDir: 'memory' })), /完整路径/);
    assert.throws(() => normalizeProfile(profile(dir, { maxRestarts: 101 })), /maxRestarts/);
    assert.throws(() => normalizeProfile({ ...profile(dir), connectionFile: '' }), /连接文件不能为空/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('配置档案存在 runtime 里，可以改、删；坏档案读的时候跳过', () => {
  const dir = tmp();
  try {
    const a = saveProfile(dir, profile(dir));
    const b = saveProfile(dir, profile(dir, { label: 'dsh', agent: 'dsh', effort: 'high' }));
    saveProfile(dir, { ...a, model: 'opus' });
    assert.deepEqual(loadProfiles(dir).map((p) => [p.label, p.model]), [['小克试玩', 'opus'], ['dsh', '']]);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'webui-profiles.json'), 'utf8'));
    raw.profiles.push({ label: 'x', agent: 'nope' });
    fs.writeFileSync(path.join(dir, 'webui-profiles.json'), JSON.stringify(raw));
    assert.equal(loadProfiles(dir).length, 2);
    assert.equal(deleteProfile(dir, b.id), true); assert.equal(deleteProfile(dir, b.id), false);
    assert.deepEqual(loadProfiles(dir).map((p) => p.id), [a.id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('连接文件：只返回角色、世界和地址，不带令牌；只认本机 ServerBody', () => {
  const dir = tmp();
  try {
    const r = inspectConnection(connection(dir));
    assert.deepEqual(r, { ok: true, username: 'Claude', worldId: 'alpha', endpoint: 'http://127.0.0.1:8767' });
    assert.doesNotMatch(JSON.stringify(r), /secret-token/);
    assert.match(inspectConnection(connection(dir, { endpoint: 'http://10.0.0.2:8767/v2' })).error, /本机/);
    assert.match(inspectConnection(connection(dir, { protocol: 1 })).error, /协议 2/);
    assert.match(inspectConnection(path.join(dir, 'none.json')).error, /不存在/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('启动参数：每个值单独一项，带 -Headless；没填的会话选项不传', () => {
  const dir = tmp();
  try {
    const p = normalizeProfile(profile(dir, { model: 'opus', nickname: '小克', maxRestarts: 0 }));
    const a = launchArgs(p, 'S.ps1');
    assert.deepEqual(a.slice(0, 4), ['-NoProfile', '-NonInteractive', '-File', 'S.ps1']);
    const after = (flag) => a[a.indexOf(flag) + 1];
    assert.equal(after('-ConnectionFile'), p.connectionFile); assert.equal(after('-Agent'), 'claude');
    assert.equal(after('-Model'), 'opus'); assert.equal(after('-Nickname'), '小克'); assert.equal(after('-MaxRestarts'), '0');
    assert.ok(a.includes('-Headless')); assert.ok(!a.includes('-IdleMinutes')); assert.ok(!a.includes('-ConfigDir'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('启动：在线的不再启动；脚本退出后能看到退出码和输出', async () => {
  const dir = tmp();
  try {
    const script = path.join(dir, 'fake.mjs');
    fs.writeFileSync(script, "console.log('ARGS ' + process.argv.slice(2).join('|')); process.exit(3);");
    let running = false;
    const launcher = createLauncher({ runtime: dir, isRunning: () => running, command: [process.execPath, script] });
    const p = normalizeProfile(profile(dir));
    running = true;
    assert.match(launcher.launch(p).error, /已经在托管/);
    running = false;
    const r = launcher.launch(p);
    assert.equal(r.ok, true); assert.equal(r.name, 'Claude');
    assert.match(launcher.launch(p).error, /正在启动/);
    for (let i = 0; i < 100 && launcher.status('Claude').exitCode === null; i++) await new Promise((res) => setTimeout(res, 50));
    const s = launcher.status('Claude');
    assert.equal(s.exitCode, 3); assert.match(s.log, /ARGS -NoProfile\|.*-Headless/);
    assert.match(launcher.launch(normalizeProfile(profile(dir, { connectionFile: path.join(dir, 'none.json') }))).error, /不存在/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('账号目录：只列用户目录下像账号目录的文件夹名', () => {
  const home = tmp();
  try {
    for (const d of ['.claude', '.claude-r', '.codex', '.dsh', '.config']) fs.mkdirSync(path.join(home, d));
    fs.writeFileSync(path.join(home, '.claude-file'), '');
    assert.deepEqual(accountDirs(home), { claude: ['~/.claude', '~/.claude-r'], codex: ['~/.codex'], dsh: ['~/.dsh'] });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('配置接口：要 JSON、查来源；保存后列表不带令牌，启动走启动器', async () => {
  const dir = tmp();
  const launched = [];
  const web = createWebServer({ runtime: dir, token: 'cd34', launcher: { launch: (p) => { launched.push(p.id); return { ok: true, name: 'Claude', pid: 1 }; }, status: () => null } });
  try {
    const port = await web.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const cookie = (await fetch(`${base}/?t=cd34`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/profiles`)).status, 403, '没有 Cookie');
    assert.equal((await fetch(`${base}/api/profiles/save`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await post('/api/profiles/save', profile(dir), { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/profiles/save', profile(dir, { apiKey: 'sk' }))).status, 400);
    const saved = await (await post('/api/profiles/save', profile(dir))).json();
    assert.equal(saved.ok, true);
    const view = await (await fetch(`${base}/api/profiles`, { headers: { cookie } })).json();
    assert.equal(view.profiles[0].connection.username, 'Claude'); assert.equal(view.profiles[0].running, false);
    assert.deepEqual(view.agents.dsh.efforts, ['low', 'high', 'max']);
    assert.doesNotMatch(JSON.stringify(view), /secret-token/);
    const conn = await (await post('/api/connection', { file: view.profiles[0].connectionFile })).json();
    assert.equal(conn.worldId, 'alpha'); assert.doesNotMatch(JSON.stringify(conn), /secret-token/);
    assert.equal((await post('/api/profiles/launch', { id: saved.profile.id })).status, 200);
    assert.deepEqual(launched, [saved.profile.id]);
    assert.equal((await post('/api/profiles/launch', { id: 'ffffffff' })).status, 404);
    assert.equal((await post('/api/profiles/delete', { id: saved.profile.id })).status, 200);
    assert.equal(loadProfiles(dir).length, 0);
  } finally { await web.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('模型列表：三家 CLI 的返回整理成同一种格式，只留模型名、说明和思考强度', () => {
  const claude = claudeModelsFrom({ account: { email: 'x@y' }, models: [
    { value: 'default', displayName: 'Default' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Best', supportsEffort: true, supportedEffortLevels: ['low', 'max'] },
    { value: 'haiku', displayName: 'Haiku 4.5' },
  ] });
  assert.deepEqual(claude, [
    { value: 'opus', label: 'Opus 5.5', desc: 'claude-opus-5-5 · Best', efforts: ['low', 'max'] },
    { value: 'haiku', label: 'Haiku 4.5', desc: '', efforts: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(claude), /x@y/);
  const codex = codexModelsFrom({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], default_reasoning_level: 'low' },
    { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: [] },
  ] });
  assert.deepEqual(codex.map((m) => [m.value, m.efforts, m.defaultEffort]), [['gpt-6.1-sol', ['low', 'ultra'], 'low']]);
  const dsh = dshModelsFrom([
    { id: 'model', options: [{ name: 'deepseek-v4-flash', value: 'a' }, { group: 'x', options: [{ name: 'DeepSeek-V4-Pro', value: 'b' }, { name: 'deepseek-v4-flash', value: 'a2' }] }] },
    { id: 'reasoning_effort', options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }, { value: 'max' }] },
  ]);
  assert.deepEqual(dsh.map((m) => m.value), ['deepseek-v4-flash', 'DeepSeek-V4-Pro']);
  assert.deepEqual(dsh[0].efforts, ['low', 'high', 'max']);
});

test('模型列表缓存：同一账号一小时内用缓存，refresh 重读，读失败时带上旧结果', async () => {
  const dir = tmp();
  try {
    let calls = 0, fail = false;
    const fetchers = { claude: async (configDir) => { calls++; if (fail) throw new Error('CLI 不在'); return [{ value: 'opus', label: configDir, desc: '', efforts: [] }]; } };
    const cat = createModelCatalog({ runtime: dir, fetchers });
    const [a, b] = await Promise.all([cat.get('claude', 'D1'), cat.get('claude', 'D1')]);
    assert.equal(calls, 1, '同时的请求合并'); assert.equal(a.ok, true); assert.equal(b.models[0].label, 'D1');
    assert.equal((await cat.get('claude', 'D1')).cached, true); assert.equal(calls, 1);
    await cat.get('claude', 'D2'); assert.equal(calls, 2, '换账号目录要重读');
    fail = true;
    const r = await cat.get('claude', 'D1', true);
    assert.equal(r.ok, false); assert.match(r.error, /CLI 不在/); assert.equal(r.stale, true); assert.equal(r.models[0].value, 'opus');
    assert.equal((await createModelCatalog({ runtime: dir, fetchers }).get('claude', 'D2')).cached, true, '缓存存在 runtime 里，重启后还在');
    assert.equal((await cat.get('nope')).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('模型接口：要令牌；账号目录要完整路径；结果原样返回', async () => {
  const dir = tmp();
  const asked = [];
  const web = createWebServer({ runtime: dir, token: 'ef56', launcher: { launch: () => ({ ok: true }), status: () => null },
    models: { get: async (agent, account, refresh) => { asked.push([agent, account, refresh]); return { ok: true, source: 'x', models: [{ value: 'opus' }] }; } } });
  try {
    const port = await web.listen(0);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/models?agent=claude`)).status, 403);
    const cookie = (await fetch(`${base}/?t=ef56`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const get = (q) => fetch(`${base}/api/models?${q}`, { headers: { cookie } });
    assert.equal((await (await get('agent=claude&account=~/.claude-r&refresh=1')).json()).models[0].value, 'opus');
    assert.deepEqual(asked[0], ['claude', path.join(os.homedir(), '.claude-r'), true]);
    assert.equal((await get('agent=claude&account=relative')).status, 400);
    assert.equal((await get('agent=gemini')).status, 400);
  } finally { await web.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
