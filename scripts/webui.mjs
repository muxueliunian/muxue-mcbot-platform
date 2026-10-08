#!/usr/bin/env node
// 本地 WebUI：看托管 Bot 的状态、游戏聊天、AI 回复和工具调用，可以叫停或停止托管；
// 「配置」页按档案保存 Agent、账号、模型、思考强度等启动参数，并用 start-server-play.ps1 -Headless 启动托管（webui-profiles.mjs）。
// 监控只读 runtime/ 里驱动器写的文件（心跳、会话、activity-*.jsonl），叫停/停止只放标记；不碰游戏。
// 只监听 127.0.0.1；每次启动生成一次性令牌，打开终端里打印的地址后存进 Cookie，其他网页拿不到。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createModelCatalog } from './agent-models.mjs';
import { AGENTS, SESSION_OPTIONS, accountDirs, createLauncher, deleteProfile, expandHome, inspectConnection, loadProfiles, saveProfile } from './webui-profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const FIRST_READ_BYTES = 128 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const HEARTBEAT_FRESH_MS = 60000;

export function parseWebArgs(argv) {
  const out = { port: 8770, runtime: process.env.COMPANION_RUNTIME_DIR || path.join(ROOT, 'runtime'), open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--runtime') out.runtime = path.resolve(argv[++i]);
    else if (a === '--open') out.open = true;
    else throw new Error(`不认识的参数：${a}（可用 --port、--runtime、--open）`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port 必须是 0～65535 的整数');
  return out;
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** runtime 里出现过的所有 Bot：有心跳（在跑或刚停）或有活动记录的。 */
export function listBots(runtime, now = Date.now()) {
  let names = new Set();
  let files = [];
  try { files = fs.readdirSync(runtime); } catch { return []; }
  for (const f of files) {
    const m = /^(?:companion-(.+)\.json|activity-(.+)\.jsonl)$/.exec(f);
    const name = m && (m[1] || m[2]);
    if (name && NAME_RE.test(name)) names.add(name);
  }
  return [...names].sort().map((name) => {
    const hb = readJson(path.join(runtime, `companion-${name}.json`));
    const session = readJson(path.join(runtime, `session-${name}.json`));
    const running = !!hb && pidAlive(hb.pid) && now - hb.updatedAt < HEARTBEAT_FRESH_MS;
    return {
      name,
      nickname: hb?.nickname || name,
      agent: hb?.agent || session?.provider || '',
      body: hb?.body || session?.bodyScope?.body || '',
      running,
      busy: running && !!hb?.busy,
      updatedAt: hb?.updatedAt || 0,
      contextTokens: session?.contextTokens || 0,
      lastRequestAt: session?.lastRequestAt || 0,
      worldId: session?.bodyScope?.worldId || '',
    };
  });
}

/** 从字节位置往后读活动记录；第一次（after<0）只读末尾一段。文件被轮转变小了就从头读。 */
export function readActivity(runtime, name, after = -1) {
  const file = path.join(runtime, `activity-${name}.jsonl`);
  let size;
  try { size = fs.statSync(file).size; } catch { return { offset: 0, items: [] }; }
  let start = after < 0 || after > size ? Math.max(0, size - FIRST_READ_BYTES) : after;
  if (size - start > MAX_READ_BYTES) start = size - MAX_READ_BYTES;
  if (start === size) return { offset: size, items: [] };
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  let text = buf.toString('utf8');
  // 从中间开始读时丢掉第一行残片；最后一行没写完就留到下次
  if (start > 0 && (after < 0 || start !== after)) text = text.slice(text.indexOf('\n') + 1);
  const end = text.lastIndexOf('\n');
  const complete = end < 0 ? '' : text.slice(0, end + 1);
  const offset = size - Buffer.byteLength(text.slice(complete.length), 'utf8');
  const items = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try { items.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return { offset, items };
}

/** 叫停（停下动作等新任务）或停止托管（驱动器退出）：只放标记文件，驱动器自己处理。 */
export function requestControl(runtime, name, action) {
  const bot = listBots(runtime).find((b) => b.name === name);
  if (!bot?.running) return { ok: false, error: `${name} 没有在托管` };
  if (action === 'halt' && bot.body !== 'server') return { ok: false, error: '叫停目前只支持 ServerBody' };
  const suffix = action === 'halt' ? 'halt' : 'stop';
  fs.writeFileSync(path.join(runtime, `companion-${name}.${suffix}`), String(Date.now()));
  return { ok: true };
}

const MAX_BODY_BYTES = 64 * 1024;
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new Error('请求太大')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('请求不是 JSON')); } });
  req.on('error', reject);
});

/** 配置页要的数据：档案、每份档案对应的角色在不在线、上次启动的结果，以及表单的可选项。 */
function profilesView(runtime, launcher) {
  const bots = listBots(runtime);
  const profiles = loadProfiles(runtime).map((p) => {
    const conn = inspectConnection(p.connectionFile);
    const name = conn.ok ? conn.username : '';
    const bot = bots.find((b) => b.name === name);
    return { ...p, connection: conn, running: !!bot?.running, launch: name ? launcher.status(name) : null };
  });
  const agents = Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, { label: a.label, efforts: a.efforts, fallbackModels: a.fallbackModels,
    defaultNickname: a.defaultNickname, accountHint: a.accountHint }]));
  return { profiles, agents, accounts: accountDirs(), sessionOptions: Object.keys(SESSION_OPTIONS) };
}

export function createWebServer({ runtime, token = crypto.randomBytes(24).toString('hex'), launcher, models }) {
  let port = 0;
  launcher ||= createLauncher({ runtime, isRunning: (name) => !!listBots(runtime).find((b) => b.name === name)?.running });
  models ||= createModelCatalog({ runtime });
  const allowedHost = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  // POST 再查一次来源：浏览器带了 Origin 就必须是本页
  const allowedOrigin = (origin) => !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  const cookieToken = (req) => /(?:^|;\s*)mcbot_webui=([0-9a-f]+)/.exec(req.headers.cookie || '')?.[1];
  const send = (res, status, body, type = 'application/json; charset=utf-8', headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  const server = http.createServer((req, res) => {
    // 防 DNS 重绑定：Host 只能是本机地址
    if (!allowedHost(req.headers.host)) return send(res, 403, { error: 'host not allowed' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/' && url.searchParams.has('t')) {
      if (url.searchParams.get('t') !== token) return send(res, 403, '令牌不对：请用终端里打印的地址打开', 'text/plain; charset=utf-8');
      return send(res, 302, '', 'text/plain', { location: '/', 'set-cookie': `mcbot_webui=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    const authed = cookieToken(req) === token;
    if (url.pathname === '/') {
      if (!authed) return send(res, 403, '请用启动 WebUI 时终端里打印的地址打开（带令牌）', 'text/plain; charset=utf-8');
      return send(res, 200, PAGE, 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
    }
    if (!authed) return send(res, 403, { error: 'unauthorized' });
    if (req.method === 'POST' && !allowedOrigin(req.headers.origin)) return send(res, 403, { error: 'origin not allowed' });
    if (url.pathname.startsWith('/api/profiles') || url.pathname === '/api/connection' || url.pathname === '/api/models') {
      handleProfiles(req, res, url).catch((e) => send(res, 400, { ok: false, error: e.message }));
      return;
    }
    const name = url.searchParams.get('name') || '';
    if (req.method === 'GET' && url.pathname === '/api/bots') return send(res, 200, { bots: listBots(runtime) });
    if (req.method === 'GET' && url.pathname === '/api/activity') {
      if (!NAME_RE.test(name)) return send(res, 400, { error: 'bad name' });
      return send(res, 200, readActivity(runtime, name, Number(url.searchParams.get('after') ?? -1)));
    }
    if (req.method === 'POST' && (url.pathname === '/api/halt' || url.pathname === '/api/stop')) {
      if (!NAME_RE.test(name)) return send(res, 400, { error: 'bad name' });
      const result = requestControl(runtime, name, url.pathname === '/api/halt' ? 'halt' : 'stop');
      return send(res, result.ok ? 200 : 409, result);
    }
    send(res, 404, { error: 'not found' });
  });
  async function handleProfiles(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/profiles') return send(res, 200, profilesView(runtime, launcher));
    if (req.method === 'GET' && p === '/api/models') {
      const agent = url.searchParams.get('agent') || '';
      if (!AGENTS[agent]) return send(res, 400, { ok: false, error: '不认识的 Agent' });
      const raw = url.searchParams.get('account') || '';
      const account = raw ? path.normalize(expandHome(raw)) : '';
      if (account && (!path.isAbsolute(account) || /[\u0000-\u001f]/.test(account))) return send(res, 400, { ok: false, error: '账号目录要是完整路径' });
      return send(res, 200, await models.get(agent, account, url.searchParams.get('refresh') === '1'));
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { ok: false, error: '要用 JSON' });
    const body = await readBody(req);
    if (p === '/api/connection') {
      return send(res, 200, inspectConnection(expandHome(String(body.file || ''))));
    }
    if (p === '/api/profiles/save') return send(res, 200, { ok: true, profile: saveProfile(runtime, body) });
    const profile = loadProfiles(runtime).find((x) => x.id === body.id);
    if (!profile) return send(res, 404, { ok: false, error: '没有这份配置' });
    if (p === '/api/profiles/delete') { deleteProfile(runtime, profile.id); return send(res, 200, { ok: true }); }
    if (p === '/api/profiles/launch') { const r = launcher.launch(profile); return send(res, r.ok ? 200 : 409, r); }
    send(res, 404, { error: 'not found' });
  }
  return {
    server, token,
    listen: (p) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(port); });
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// 页面在 webui-page.html（单个内联 HTML，不加载外部资源）；风格参考 NapCat WebUI，颜色、图标、字样都是自己的。
const PAGE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'webui-page.html'), 'utf8');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseWebArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const web = createWebServer({ runtime: opts.runtime });
  web.listen(opts.port).then((port) => {
    const url = `http://127.0.0.1:${port}/?t=${web.token}`;
    console.log(`mcbot WebUI：${url}`);
    console.log(`读取 ${opts.runtime}；Ctrl+C 退出（不影响正在托管的 Bot）`);
    if (opts.open && process.platform === 'win32') {
      import('node:child_process').then(({ spawn }) => spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref());
    }
  }).catch((e) => { console.error(e.code === 'EADDRINUSE' ? `端口 ${opts.port} 被占用，用 --port 换一个` : e.message); process.exit(1); });
}
