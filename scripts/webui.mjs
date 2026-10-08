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
  const agents = Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, { label: a.label, efforts: a.efforts, models: a.models,
    defaultNickname: a.defaultNickname, accountHint: a.accountHint }]));
  return { profiles, agents, accounts: accountDirs(), sessionOptions: Object.keys(SESSION_OPTIONS) };
}

export function createWebServer({ runtime, token = crypto.randomBytes(24).toString('hex'), launcher }) {
  let port = 0;
  launcher ||= createLauncher({ runtime, isRunning: (name) => !!listBots(runtime).find((b) => b.name === name)?.running });
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
    if (url.pathname.startsWith('/api/profiles') || url.pathname === '/api/connection') {
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

// 页面风格参考 NapCat WebUI：渐变背景加模糊光斑、透明侧栏、选中项右移带小胶囊、胶囊顶栏和按钮、半透明毛玻璃卡片。颜色、图标、字样都是自己的。
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mcbot 控制台</title>
<style>
:root{color-scheme:light;--primary:#ec6a9c;--primary-strong:#d94f86;--primary-soft:rgba(236,106,156,.12);--primary-pale:#f9c9db;--secondary:#7fb6cb;
--bg1:#eef1ff;--bg2:#ffffff;--bg3:#fdf0f6;--glass:rgba(255,255,255,.62);--glass-strong:rgba(255,255,255,.82);--glass-line:rgba(255,255,255,.75);
--text:#27272a;--muted:#71717a;--line:rgba(24,24,27,.07);--fill:rgba(24,24,27,.045);--fill-hover:rgba(24,24,27,.07);
--ok:#17a865;--busy:#e3912b;--off:#a1a1aa;--err:#e0457b;--err-soft:rgba(224,69,123,.12);--ok-soft:rgba(23,168,101,.12);
--chat:#14a39a;--reply:#6a8cf0;--tool:#a070e6;--event:#8a93a6;--shadow:0 8px 30px rgba(236,106,156,.10);--blob-a:rgba(249,201,219,.55);--blob-b:rgba(176,216,231,.5);--blob-c:rgba(251,207,232,.4)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--primary:#f0679b;--primary-strong:#f58ab2;--primary-soft:rgba(240,103,155,.18);--primary-pale:#5b2a3f;
--bg1:#111827;--bg2:#1c2230;--bg3:#111827;--glass:rgba(32,34,44,.58);--glass-strong:rgba(32,34,44,.86);--glass-line:rgba(255,255,255,.07);
--text:#ececf1;--muted:#a1a1aa;--line:rgba(255,255,255,.08);--fill:rgba(255,255,255,.06);--fill-hover:rgba(255,255,255,.1);--err-soft:rgba(224,69,123,.2);--ok-soft:rgba(23,168,101,.2);
--shadow:0 8px 30px rgba(0,0,0,.25);--blob-a:rgba(240,103,155,.16);--blob-b:rgba(127,182,203,.13);--blob-c:rgba(160,112,230,.12)}}
:root[data-theme="dark"]{color-scheme:dark;--primary:#f0679b;--primary-strong:#f58ab2;--primary-soft:rgba(240,103,155,.18);--primary-pale:#5b2a3f;
--bg1:#111827;--bg2:#1c2230;--bg3:#111827;--glass:rgba(32,34,44,.58);--glass-strong:rgba(32,34,44,.86);--glass-line:rgba(255,255,255,.07);
--text:#ececf1;--muted:#a1a1aa;--line:rgba(255,255,255,.08);--fill:rgba(255,255,255,.06);--fill-hover:rgba(255,255,255,.1);--err-soft:rgba(224,69,123,.2);--ok-soft:rgba(23,168,101,.2);
--shadow:0 8px 30px rgba(0,0,0,.25);--blob-a:rgba(240,103,155,.16);--blob-b:rgba(127,182,203,.13);--blob-c:rgba(160,112,230,.12)}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;color:var(--text);background:linear-gradient(135deg,var(--bg1),var(--bg2) 50%,var(--bg3));background-attachment:fixed;
font:14px/1.55 Quicksand,Nunito,"Segoe UI Variable Text","Segoe UI",system-ui,"Microsoft YaHei UI","PingFang SC",sans-serif;letter-spacing:.02em;-webkit-font-smoothing:antialiased;overflow:hidden}
::selection{background:var(--primary-pale);color:var(--text)}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:rgba(236,106,156,.35);border-radius:3px}::-webkit-scrollbar-thumb:hover{background:rgba(236,106,156,.6)}::-webkit-scrollbar-track{background:transparent}
.blobs{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.blobs i{position:absolute;border-radius:50%}
.blobs i:nth-child(1){width:480px;height:480px;left:-120px;top:-140px;background:var(--blob-a);filter:blur(100px)}
.blobs i:nth-child(2){width:400px;height:400px;right:-10%;top:20%;background:var(--blob-b);filter:blur(90px)}
.blobs i:nth-child(3){width:560px;height:560px;left:22%;bottom:-18%;background:var(--blob-c);filter:blur(110px)}
svg.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.shell{display:flex;height:100vh}
aside{width:16rem;flex:none;display:flex;flex-direction:column;padding:22px 14px 16px;gap:4px}
.brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;letter-spacing:.04em;padding:0 10px}
.brand i{width:4px;height:20px;border-radius:4px;background:var(--primary);box-shadow:0 2px 8px var(--primary-soft)}
.brand-sub{color:var(--muted);font-size:12px;padding:0 10px 0 24px;margin-bottom:18px}
nav{display:flex;flex-direction:column;gap:6px}
.nav-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;padding:10px 14px;border-radius:14px;cursor:pointer;color:var(--text);transition:all .3s}
.nav-item:hover{background:var(--fill-hover);transform:translateX(4px)}
.nav-item.on{background:var(--primary-soft);color:var(--primary-strong);font-weight:600;transform:translateX(4px)}
.nav-item .pip{width:12px;height:6px;border-radius:6px;margin-left:auto;background:var(--primary-pale);transition:all .3s}
.nav-item.on .pip{background:var(--primary);width:18px;box-shadow:0 0 8px var(--primary-soft)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:8px}
.side-foot .note{color:var(--muted);font-size:12px;text-align:center}
.scrim{display:none}
.content{flex:1;min-width:0;display:flex;flex-direction:column;padding:8px 8px 0}
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;height:42px;padding:0 8px 0 10px;border-radius:999px;background:var(--glass);
backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);border:1px solid var(--glass-line);box-shadow:0 2px 12px var(--primary-soft)}
.crumb{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:13px}.crumb b{color:var(--text);font-weight:600}
.topbar .grow{flex:1}.topbar .live{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;padding-right:6px}
.view{flex:1;min-height:0;padding:14px 8px 14px;overflow:auto}
.view.enter{animation:enter .4s ease}
@keyframes enter{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
.glass,.bot{background:var(--glass);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);border:1px solid var(--glass-line);border-radius:18px;box-shadow:var(--shadow)}
.grid{display:grid;grid-template-columns:300px 1fr;gap:16px;align-items:start}
#view-monitor .grid{height:100%;align-items:stretch}
.col-title{font-size:13px;font-weight:600;color:var(--muted);margin:2px 6px 10px;display:flex;align-items:center;gap:8px}
.col-title::before{content:"";width:3px;height:12px;border-radius:3px;background:var(--secondary)}
.bots{display:flex;flex-direction:column;gap:10px;overflow:auto;min-height:0;padding:2px}
.bot{padding:14px;cursor:pointer;transition:transform .25s,box-shadow .25s,border-color .25s}
.bot:hover{transform:translateY(-2px)}
.bot.sel{border-color:var(--primary);box-shadow:0 0 0 1px var(--primary),var(--shadow)}
.bot .top{display:flex;align-items:center;gap:8px;font-weight:600}
.dot{width:9px;height:9px;border-radius:50%;background:var(--off);flex:none}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}.dot.busy{background:var(--busy);box-shadow:0 0 0 3px rgba(227,145,43,.18);animation:pulse 1.4s infinite}
@keyframes pulse{50%{box-shadow:0 0 0 6px rgba(227,145,43,0)}}
.meta{color:var(--muted);font-size:12px;margin-top:4px}
.btns{display:flex;gap:8px;margin-top:12px}
button{font:inherit;font-size:12px;padding:5px 14px;border-radius:999px;border:0;background:var(--primary-soft);color:var(--primary-strong);cursor:pointer;font-weight:500;transition:all .25s}
button:hover{filter:brightness(1.04);box-shadow:0 4px 14px var(--primary-soft)}
button:disabled{opacity:.4;cursor:default;box-shadow:none}
button.danger{background:var(--err-soft);color:var(--err)}
button.primary{background:var(--primary);color:#fff;box-shadow:0 6px 16px rgba(236,106,156,.35)}
button.ghost{background:transparent;color:var(--text)}button.ghost:hover{background:var(--fill-hover);box-shadow:none}
button.icon{padding:6px;display:inline-flex;border-radius:50%}
button.wide{width:100%;padding:8px 14px;font-size:13px}
.feed{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.bar{display:flex;flex-wrap:wrap;gap:14px;padding:12px 16px;color:var(--muted);font-size:12px;align-items:center;border-bottom:1px solid var(--line)}
#title{font-size:14px;font-weight:600;color:var(--text)}
.bar label{display:flex;gap:6px;align-items:center;cursor:pointer}
input[type=checkbox],input[type=radio]{accent-color:var(--primary)}
#now{background:var(--fill)}
#rows{overflow:auto;padding:8px 6px;flex:1;min-height:300px}
.row{display:grid;grid-template-columns:62px 48px 1fr;gap:10px;padding:4px 10px;align-items:baseline;border-radius:10px}
.row:hover{background:var(--fill)}
.t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
.tag{--c:var(--event);font-size:11px;border-radius:999px;padding:0 6px;text-align:center;color:var(--c);background:color-mix(in srgb,var(--c) 15%,transparent);font-weight:600}
.k-event-chat .tag{--c:var(--chat)}.k-reply .tag{--c:var(--reply)}.k-tool .tag{--c:var(--tool)}.k-error .tag,.k-turn.err .tag{--c:var(--err)}
.k-turn .tag,.k-turn_start .tag{--c:var(--off)}
.msg{white-space:pre-wrap;word-break:break-word}.k-tool .msg,.k-info .msg,.k-turn .msg,.k-turn_start .msg{color:var(--muted);font-size:13px}
.k-reply .msg{font-weight:500}.err .msg{color:var(--err)}
.empty{color:var(--muted);padding:28px;text-align:center}
.bots>button{align-self:stretch;padding:10px;font-size:13px}
.form{padding:22px 24px;max-width:820px}
.form h2{font-size:17px;margin:0 0 6px}
.form h3{display:flex;align-items:center;gap:8px;font-size:13px;margin:22px 0 12px;color:var(--primary-strong);font-weight:600}
.form h3::before{content:"";width:3px;height:12px;border-radius:3px;background:var(--primary)}
.field{display:grid;grid-template-columns:110px 1fr;gap:6px 14px;align-items:center;margin-bottom:12px}
.field>label,.field>span:first-child{color:var(--muted);font-size:13px}
.field>.hint{grid-column:2;color:var(--muted);font-size:12px}
.field input:not([type=radio]),.field select{font:inherit;padding:8px 12px;border:1px solid transparent;border-radius:12px;background:var(--fill);color:var(--text);width:100%;min-width:0;outline:none;transition:all .2s}
.field input:not([type=radio]):hover,.field select:hover{background:var(--fill-hover)}
.field input:not([type=radio]):focus,.field select:focus{border-color:var(--primary);background:var(--glass-strong);box-shadow:0 0 0 3px var(--primary-soft)}
.field select option{background:var(--bg2);color:var(--text)}
.inline{display:flex;gap:8px;align-items:center}.inline input{flex:1}
.radio{display:flex;gap:18px;flex-wrap:wrap}.radio label{display:flex;gap:6px;align-items:center;white-space:nowrap}.radio label.off{color:var(--muted)}
details{margin-top:18px;border-radius:14px;background:var(--fill);padding:2px 14px}
details summary{cursor:pointer;color:var(--muted);font-size:13px;padding:10px 0;list-style-position:inside}
details[open]{padding-bottom:6px}
.actions{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap;align-items:center}
.actions button{font-size:13px;padding:8px 18px}
#c-msg{font-size:12px;color:var(--muted);margin-top:10px}#c-msg.err{color:var(--err)}
.status{margin-top:12px;padding:12px 14px;border-radius:14px;background:var(--fill);font-size:13px}
.status pre{margin:8px 0 0;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,"Cascadia Mono",Consolas,monospace;color:var(--muted)}
.okc{color:var(--ok)}.errc{color:var(--err)}
@media (max-width:1100px){.grid{grid-template-columns:1fr}#view-monitor .grid{height:auto}#bots{max-height:40vh}.feed{min-height:60vh}}
@media (max-width:767px){
body{overflow:auto}.shell{height:auto;min-height:100vh}
aside{position:fixed;inset:0 auto 0 0;z-index:50;background:var(--glass-strong);backdrop-filter:blur(24px) saturate(1.5);-webkit-backdrop-filter:blur(24px) saturate(1.5);
border-radius:0 18px 18px 0;box-shadow:0 10px 40px rgba(0,0,0,.18);transform:translateX(-105%);transition:transform .35s cubic-bezier(.2,.9,.3,1.2)}
body.nav-open aside{transform:none}
body.nav-open .scrim{display:block;position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.2);backdrop-filter:blur(1px)}
.grid{grid-template-columns:1fr}#view-monitor .grid{height:auto}.view{overflow:visible;padding-bottom:40px}
.field{grid-template-columns:1fr}.field>.hint{grid-column:1}.form{padding:18px 16px}}
@media (min-width:768px){#menu{display:none}}
</style></head><body>
<div class="blobs"><i></i><i></i><i></i></div>
<div class="shell">
<aside id="side"><div class="brand"><i></i>mcbot</div><div class="brand-sub">本地控制台</div>
<nav><button class="nav-item on" id="tab-monitor"><svg class="i" viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>监控<span class="pip"></span></button>
<button class="nav-item" id="tab-config"><svg class="i" viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>配置<span class="pip"></span></button></nav>
<div class="side-foot"><button class="wide" id="theme-btn">主题：跟随系统</button><div class="note">只在本机可见</div></div></aside>
<div class="scrim" id="scrim"></div>
<div class="content">
<header class="topbar"><button class="icon ghost" id="menu" aria-label="菜单"><svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg></button>
<span class="crumb">mcbot<span>/</span><b id="crumb">监控</b></span><span class="grow"></span><span class="live" id="live"><span class="dot on"></span>每 1.5 秒刷新</span></header>
<section class="view" id="view-config" hidden><div class="grid"><div><div class="col-title">配置档案</div><section class="bots" id="profiles"></section></div>
<form class="form glass" id="cform" autocomplete="off"><h2 id="c-title">新配置</h2>
<div class="field"><label for="c-label">名称</label><input id="c-label" maxlength="40" required></div>
<div class="field"><label for="c-agent">Agent</label><select id="c-agent"></select></div>
<h3>账号</h3>
<div class="field"><span>凭据</span><div class="radio"><label><input type="radio" name="cred" checked>用本机已有的登录</label><label class="off" title="以后支持"><input type="radio" name="cred" disabled>API key（以后支持）</label></div></div>
<div class="field"><label for="c-configDir">账号目录</label><input id="c-configDir" list="dl-account" placeholder="留空用默认账号"><span class="hint" id="h-account"></span></div>
<h3>模型</h3>
<div class="field"><label for="c-model">模型</label><input id="c-model" list="dl-model" placeholder="留空用 Agent 的默认模型"><span class="hint" id="h-model"></span></div>
<div class="field"><label for="c-effort">思考强度</label><select id="c-effort"></select><span class="hint">越高越聪明，也越慢、越费额度；试玩一般用 low</span></div>
<h3>角色和世界</h3>
<div class="field"><label for="c-connectionFile">连接文件</label><div class="inline"><input id="c-connectionFile" placeholder="服务器的 config/mcbot-server-control/connection.json" required><button type="button" id="c-check">检查</button></div><span class="hint" id="h-conn">游戏里的角色名和世界从这个文件读</span></div>
<div class="field"><label for="c-nickname">昵称</label><input id="c-nickname" maxlength="16"><span class="hint">玩家可以用昵称叫它</span></div>
<div class="field"><label for="c-memoryDir">记忆目录</label><input id="c-memoryDir" placeholder="留空就不带人设"><span class="hint">里面有 xiaoke/persona.md 和 shared/players/ 时带上人设和玩家档案</span></div>
<details><summary>高级选项</summary>
<div class="field"><label for="c-nodePath">Node 路径</label><input id="c-nodePath" placeholder="留空用 PATH 里的 node"></div>
<div class="field"><label for="c-idleMinutes">空闲提醒</label><input id="c-idleMinutes" type="number" min="0" max="1440" placeholder="0（关）"><span class="hint">空闲多少分钟提醒 Agent 一次</span></div>
<div class="field"><label for="c-resumeWindowMin">接着旧会话</label><input id="c-resumeWindowMin" type="number" min="0" max="1440" placeholder="50"><span class="hint">离上次请求不到这么多分钟就接着旧会话；0 表示总是接着</span></div>
<div class="field"><label for="c-rotateTokens">换新会话</label><input id="c-rotateTokens" type="number" min="0" max="2000000" step="1000" placeholder="200000"><span class="hint">上下文超过这么多 tokens 就整理记忆后换新会话；0 表示不换</span></div>
<div class="field"><label for="c-maxRestarts">最多重启</label><input id="c-maxRestarts" type="number" min="0" max="100" placeholder="10"><span class="hint">Agent 连续崩溃这么多次后不再重启</span></div>
</details>
<div class="actions"><button type="submit">保存</button><button type="button" class="primary" id="c-launch">保存并启动托管</button><button type="button" class="danger" id="c-stop">停止托管</button><span style="flex:1"></span><button type="button" class="ghost" id="c-del">删除这份配置</button></div>
<div id="c-msg"></div><div class="status" id="c-status" hidden></div>
<datalist id="dl-account"></datalist><datalist id="dl-model"></datalist></form></div></section>
<main class="view" id="view-monitor"><div class="grid"><div style="display:flex;flex-direction:column;min-height:0"><div class="col-title">托管中的 Bot</div><section class="bots" id="bots"><div class="empty">还没有托管记录</div></section></div>
<section class="feed glass"><div class="bar"><span id="title">选择左边的 Bot</span><span style="flex:1"></span>
<label><input type="checkbox" id="f-tool" checked>工具调用</label><label><input type="checkbox" id="f-info">驱动器提示</label><label><input type="checkbox" id="f-auto" checked>自动滚动</label></div>
<div class="bar" id="now"></div><div id="rows"></div></section></div></main>
</div></div>
<script>
const $=(s)=>document.querySelector(s);let bots=[],sel=localStorage.getItem('mcbot.sel')||'',offset=-1,items=[];
const TAG={event:'事件',reply:'回复',tool:'工具',turn:'本轮',turn_start:'开始',info:'提示',error:'出错',halt:'叫停'};
const fmt=(t)=>new Date(t).toLocaleTimeString('zh-CN',{hour12:false});
const ago=(t)=>{if(!t)return'—';const s=Math.round((Date.now()-t)/1000);return s<60?s+' 秒前':s<3600?Math.round(s/60)+' 分钟前':Math.round(s/3600)+' 小时前'};
async function api(p,opt){const r=await fetch(p,opt);return r.json()}
function renderBots(){const box=$('#bots');if(!bots.length){box.innerHTML='<div class="empty">还没有托管记录</div>';return}
box.replaceChildren(...bots.map(b=>{const d=document.createElement('div');d.className='bot'+(b.name===sel?' sel':'');
const st=b.running?(b.busy?'思考中':'在线'):'已停止';
d.innerHTML='<div class="top"><span class="dot '+(b.running?(b.busy?'busy':'on'):'')+'"></span><span></span></div><div class="meta"></div><div class="meta"></div><div class="btns"><button class="halt">叫停</button><button class="danger stop">停止托管</button></div>';
d.querySelector('.top span:last-child').textContent=b.nickname+'（'+b.name+'）';
const m=d.querySelectorAll('.meta');m[0].textContent=st+' · '+(b.agent||'?')+' · '+(b.body||'?')+(b.worldId?' · '+b.worldId:'');
m[1].textContent='上下文 '+(b.contextTokens?Math.round(b.contextTokens/1000)+'k':'—')+' · 上次请求 '+ago(b.lastRequestAt);
const h=d.querySelector('.halt'),s=d.querySelector('.stop');h.disabled=!b.running||b.body!=='server';s.disabled=!b.running;
h.title='停下当前动作和推理，等你在游戏里给新任务';s.title='关掉托管，Bot 会下线';
h.onclick=(e)=>{e.stopPropagation();control('halt',b)};s.onclick=(e)=>{e.stopPropagation();if(confirm('停止托管 '+b.nickname+'？Bot 会下线'))control('stop',b)};
d.onclick=()=>select(b.name);return d}))}
async function control(a,b){const r=await api('/api/'+a+'?name='+encodeURIComponent(b.name),{method:'POST'});if(!r.ok)alert(r.error||'失败')}
function select(n){if(n===sel)return;sel=n;try{localStorage.setItem('mcbot.sel',n)}catch{}offset=-1;items=[];$('#rows').innerHTML='';renderBots();poll()}
function rowOf(it){const d=document.createElement('div');let k=it.kind;let cls='row k-'+k;if(k==='event'&&(it.type==='chat'||it.type==='whisper'))cls+=' k-event-chat';if(it.error)cls+=' err';
d.className=cls;let text=it.text||'';if(k==='event'&&(it.type==='chat'||it.type==='whisper'))text=(it.from?it.from+'：':'')+text;
if(k==='tool')text=it.name+' '+(it.input||'');if(k==='turn_start')text='开始一轮（'+(it.turnKind||'事件')+'）';if(it.error&&k==='turn')text+='\\n'+it.error;
const tag=k==='event'&&it.type==='chat'?'聊天':(TAG[k]||k);
d.innerHTML='<span class="t"></span><span class="tag"></span><span class="msg"></span>';d.children[0].textContent=fmt(it.t);d.children[1].textContent=tag;d.children[2].textContent=text;return d}
function visible(it){if(it.kind==='tool')return $('#f-tool').checked;if(it.kind==='info'||it.kind==='turn_start')return $('#f-info').checked;return true}
// 从记录里推算现在的状态：最近的陪伴指令（叫停后清掉）、最近一次工具、最近一次出错
function renderNow(){let base='',mode='',tool=null,err=null;for(const it of items){if(it.kind==='tool'){tool=it;let input={};try{input=JSON.parse(it.input||'{}')||{}}catch{}
if(it.name==='companion-mode'){const a=input.action;if(a==='follow'||a==='wait'){base=(input.mining?'陪挖':a==='follow'?'跟随':'原地等待')+(input.player?' '+input.player:'')+'（'+fmt(it.t)+'起）';mode=base}
else if(a==='pause'&&base)mode=base+'，暂停中';else if(a==='resume')mode=base}
if(it.name==='stop-action'){base='';mode=''}}if(it.kind==='halt'){base='';mode=''}if(it.kind==='error'||(it.kind==='turn'&&it.error))err=it}
const parts=['陪伴模式：'+(mode||'无'),'最近工具：'+(tool?tool.name+'（'+fmt(tool.t)+'）':'—')];if(err)parts.push('最近出错：'+fmt(err.t)+' '+(err.error||err.text||'').slice(0,80));
$('#now').textContent=sel?parts.join('　·　'):''}
function renderRows(){renderNow();const box=$('#rows');const shown=items.filter(visible);if(!shown.length){box.innerHTML='<div class="empty">'+(sel?'暂无记录':'选择左边的 Bot')+'</div>';return}
box.replaceChildren(...shown.slice(-1500).map(rowOf));if($('#f-auto').checked)box.scrollTop=box.scrollHeight}
async function poll(){try{const r=await api('/api/bots');bots=r.bots||[];if(!sel&&bots.length)sel=(bots.find(b=>b.running)||bots[0]).name;renderBots();
const b=bots.find(x=>x.name===sel);$('#title').textContent=b?b.nickname+' 的记录':'选择左边的 Bot';
if(sel){const a=await api('/api/activity?name='+encodeURIComponent(sel)+'&after='+offset);if(offset<0||a.items.length){items=items.concat(a.items).slice(-3000);renderRows()}offset=a.offset}}catch(e){$('#title').textContent='连不上 WebUI 服务：'+e.message}}
for(const id of ['#f-tool','#f-info'])$(id).onchange=renderRows;
poll();setInterval(poll,1500);
// ---- 配置页 ----
let cfg=null,cur=null,cfgTimer=0;const NUMS=['idleMinutes','resumeWindowMin','rotateTokens','maxRestarts'];
const TEXTS=['label','configDir','model','connectionFile','nickname','memoryDir','nodePath'];
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json()}
function say(t,err){const m=$('#c-msg');m.textContent=t||'';m.className=err?'err':''}
function opts(sel,list,label){sel.replaceChildren(...list.map(v=>{const o=document.createElement('option');o.value=v;o.textContent=label?label(v):v;return o}))}
// refill：重新填表单（第一次打开、保存或删除之后）；定时刷新只更新列表和状态，不动正在填的表单
async function loadCfg(refill){try{cfg=await api('/api/profiles')}catch(e){say('连不上 WebUI 服务：'+e.message,true);return}
if(!$('#c-agent').options.length)opts($('#c-agent'),Object.keys(cfg.agents),k=>cfg.agents[k].label);
if(cur&&cur.id)cur=cfg.profiles.find(x=>x.id===cur.id)||null;
if(refill||!$('#cform').dataset.filled){if(!cur)cur=cfg.profiles[0]||null;fill(cur||blank())}renderProfiles();renderStatus()}
function blank(){return{agent:'claude',effort:'low',label:'新配置'}}
function renderProfiles(){const box=$('#profiles');const add=document.createElement('button');add.textContent='＋ 新建配置';add.type='button';add.onclick=()=>{cur=null;fill(blank());renderProfiles();renderStatus()};
const cards=cfg.profiles.map(p=>{const d=document.createElement('div');d.className='bot'+(cur&&cur.id===p.id?' sel':'');
const fail=p.launch&&p.launch.exitCode!==null&&!p.running;
d.innerHTML='<div class="top"><span class="dot '+(p.running?'on':'')+'"></span><span></span></div><div class="meta"></div><div class="meta"></div>';
d.querySelector('.top span:last-child').textContent=p.label;const m=d.querySelectorAll('.meta');
m[0].textContent=cfg.agents[p.agent].label+' · '+(p.model||'默认模型')+' · '+p.effort;
m[1].textContent=(p.connection.ok?p.connection.username+' @ '+p.connection.worldId:'连接文件有问题')+' · '+(p.running?'在线':fail?'上次启动失败':'未启动');
d.onclick=()=>{cur=p;fill(p);renderProfiles();renderStatus()};return d});
box.replaceChildren(add,...(cards.length?cards:[Object.assign(document.createElement('div'),{className:'empty',textContent:'还没有配置'})]))}
function fill(p){const f=$('#cform');f.dataset.filled='1';$('#c-title').textContent=p.id?'编辑：'+p.label:'新配置';
for(const k of TEXTS)$('#c-'+k).value=p[k]||'';for(const k of NUMS)$('#c-'+k).value=p[k]??'';$('#c-agent').value=p.agent||'claude';onAgent(p.effort);
$('#h-conn').textContent=p.connection?(p.connection.ok?'角色 '+p.connection.username+'，世界 '+p.connection.worldId:p.connection.error):'游戏里的角色名和世界从这个文件读';
$('#h-conn').className='hint'+(p.connection?(p.connection.ok?' okc':' errc'):'');$('#c-del').disabled=!p.id;say('')}
function onAgent(effort){const a=cfg.agents[$('#c-agent').value];const want=effort||$('#c-effort').value;opts($('#c-effort'),a.efforts);
$('#c-effort').value=a.efforts.includes(want)?want:a.efforts[0];
const dl=(id,list)=>$(id).replaceChildren(...list.map(v=>Object.assign(document.createElement('option'),{value:v})));
dl('#dl-model',a.models);dl('#dl-account',cfg.accounts[$('#c-agent').value]||[]);
$('#h-account').textContent=a.accountHint;$('#c-nickname').placeholder=a.defaultNickname;
$('#h-model').textContent=a.models.length?'可以从列表选，也可以自己填；名字不对时托管日志会报出来':'留空用 Agent 的默认模型'}
function collect(){const o={agent:$('#c-agent').value,effort:$('#c-effort').value,credential:{kind:'login'}};if(cur&&cur.id)o.id=cur.id;
for(const k of TEXTS)o[k]=$('#c-'+k).value.trim();for(const k of NUMS){const v=$('#c-'+k).value.trim();o[k]=v===''?null:Number(v)}return o}
async function save(){const r=await post('/api/profiles/save',collect());if(!r.ok){say(r.error||'保存失败',true);return null}
cur=r.profile;await loadCfg(true);say('已保存');return cur}
function renderStatus(){const box=$('#c-status');const p=cur&&cur.id&&cfg.profiles.find(x=>x.id===cur.id);
$('#c-stop').disabled=!(p&&p.running);$('#c-launch').disabled=!!(p&&p.running);if(!p){box.hidden=true;return}box.hidden=false;
const l=p.launch;let html='',cls='',text;if(p.running){text='在线：'+p.connection.username+' 正在托管，去「监控」看记录';cls='okc'}
else if(l&&l.exitCode===null){text='启动中…（'+Math.round((Date.now()-l.startedAt)/1000)+' 秒）'}
else if(l){text='启动脚本已退出（退出码 '+l.exitCode+'）'+(l.error?'：'+l.error:'');cls=l.exitCode===0?'':'errc'}
else{text=p.connection.ok?'未启动':p.connection.error;cls=p.connection.ok?'':'errc'}
box.replaceChildren(Object.assign(document.createElement('div'),{className:cls,textContent:text}));
if(l&&l.log&&!p.running)box.append(Object.assign(document.createElement('pre'),{textContent:l.log}))}
$('#cform').onsubmit=async(e)=>{e.preventDefault();await save()};
$('#c-agent').onchange=()=>onAgent();
$('#c-check').onclick=async()=>{const r=await post('/api/connection',{file:$('#c-connectionFile').value.trim()});const h=$('#h-conn');
h.textContent=r.ok?'角色 '+r.username+'，世界 '+r.worldId+'，控制口 '+r.endpoint:r.error;h.className='hint '+(r.ok?'okc':'errc')};
$('#c-launch').onclick=async()=>{const p=await save();if(!p)return;const r=await post('/api/profiles/launch',{id:p.id});
say(r.ok?'已启动 '+r.name+'（进程 '+r.pid+'），等它连上游戏…':r.error||'启动失败',!r.ok);loadCfg()};
$('#c-stop').onclick=async()=>{const p=cur&&cfg.profiles.find(x=>x.id===cur.id);if(!p||!confirm('停止托管 '+p.connection.username+'？Bot 会下线'))return;
const r=await api('/api/stop?name='+encodeURIComponent(p.connection.username),{method:'POST'});say(r.ok?'已发出停止':r.error||'失败',!r.ok);loadCfg()};
$('#c-del').onclick=async()=>{if(!cur||!cur.id||!confirm('删除配置「'+cur.label+'」？不影响正在托管的 Bot'))return;
const r=await post('/api/profiles/delete',{id:cur.id});if(!r.ok){say(r.error||'删除失败',true);return}cur=null;loadCfg(true)};
function setTab(t){$('#view-monitor').hidden=t!=='monitor';$('#view-config').hidden=t!=='config';$('#tab-monitor').classList.toggle('on',t==='monitor');
$('#tab-config').classList.toggle('on',t==='config');try{localStorage.setItem('mcbot.tab',t)}catch{}clearInterval(cfgTimer);
$('#crumb').textContent=t==='config'?'配置':'监控';$('#live').hidden=t!=='monitor';document.body.classList.remove('nav-open');
const v=$(t==='config'?'#view-config':'#view-monitor');v.classList.remove('enter');void v.offsetWidth;v.classList.add('enter');
if(t==='config'){loadCfg();cfgTimer=setInterval(()=>loadCfg(),3000)}}
$('#tab-monitor').onclick=()=>setTab('monitor');$('#tab-config').onclick=()=>setTab('config');
$('#menu').onclick=()=>document.body.classList.toggle('nav-open');$('#scrim').onclick=()=>document.body.classList.remove('nav-open');
// 主题：跟随系统 → 亮色 → 暗色，记在本浏览器里
const THEMES={auto:'跟随系统',light:'亮色',dark:'暗色'};
let themeNow='auto';
function setTheme(m){themeNow=m;if(m==='auto')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=m;$('#theme-btn').textContent='主题：'+THEMES[m];try{localStorage.setItem('mcbot.theme',m)}catch{}}
let theme0='auto';try{theme0=localStorage.getItem('mcbot.theme')||'auto'}catch{}setTheme(THEMES[theme0]?theme0:'auto');
$('#theme-btn').onclick=()=>{const ks=Object.keys(THEMES);setTheme(ks[(ks.indexOf(themeNow)+1)%ks.length])};
let tab0='monitor';try{tab0=localStorage.getItem('mcbot.tab')||'monitor'}catch{}setTab(tab0);
</script></body></html>`;

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
