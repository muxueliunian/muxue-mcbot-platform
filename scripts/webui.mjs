#!/usr/bin/env node
// 本地 WebUI：看托管 Bot 的状态、游戏聊天、AI 回复和工具调用，可以叫停或停止托管。
// 只读 runtime/ 里驱动器写的文件（心跳、会话、activity-*.jsonl），只写叫停/停止标记；不碰游戏和 Agent 进程。
// 只监听 127.0.0.1；每次启动生成一次性令牌，打开终端里打印的地址后存进 Cookie，其他网页拿不到。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

export function createWebServer({ runtime, token = crypto.randomBytes(24).toString('hex') }) {
  let port = 0;
  const allowedHost = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
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
  return {
    server, token,
    listen: (p) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(port); });
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mcbot 控制台</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--text:#1d2129;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#16a34a;--busy:#d97706;--off:#9ca3af;--err:#dc2626;
--chat:#0f766e;--reply:#2563eb;--tool:#7c3aed;--event:#64748b}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--panel:#1a1d24;--text:#e5e7eb;--muted:#9ca3af;--line:#2a2f3a;--accent:#60a5fa;--chat:#2dd4bf;--reply:#60a5fa;--tool:#a78bfa;--event:#94a3b8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:16px;margin:0}header .hint{color:var(--muted);font-size:12px}
main{display:grid;grid-template-columns:280px 1fr;gap:16px;padding:16px;height:calc(100vh - 53px)}
@media (max-width:760px){main{grid-template-columns:1fr;height:auto}}
.bots{display:flex;flex-direction:column;gap:10px;overflow:auto}
.bot{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;cursor:pointer}
.bot.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.bot .top{display:flex;align-items:center;gap:8px;font-weight:600}
.dot{width:9px;height:9px;border-radius:50%;background:var(--off);flex:none}.dot.on{background:var(--ok)}.dot.busy{background:var(--busy)}
.meta{color:var(--muted);font-size:12px;margin-top:4px}
.btns{display:flex;gap:8px;margin-top:10px}
button{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}button.danger{color:var(--err)}button:disabled{opacity:.4;cursor:default}
.feed{background:var(--panel);border:1px solid var(--line);border-radius:8px;display:flex;flex-direction:column;min-height:0}
.bar{display:flex;flex-wrap:wrap;gap:12px;padding:10px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;align-items:center}
.bar label{display:flex;gap:4px;align-items:center;cursor:pointer}
#rows{overflow:auto;padding:6px 0;flex:1;min-height:300px}
.row{display:grid;grid-template-columns:64px 52px 1fr;gap:8px;padding:3px 12px;align-items:baseline}
.row:hover{background:color-mix(in srgb,var(--line) 40%,transparent)}
.t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
.tag{font-size:11px;border-radius:4px;padding:0 4px;text-align:center;color:#fff;background:var(--event)}
.k-event-chat .tag{background:var(--chat)}.k-reply .tag{background:var(--reply)}.k-tool .tag{background:var(--tool)}.k-error .tag,.k-turn.err .tag{background:var(--err)}
.k-turn .tag,.k-turn_start .tag{background:var(--muted)}
.msg{white-space:pre-wrap;word-break:break-word}.k-tool .msg,.k-info .msg,.k-turn .msg,.k-turn_start .msg{color:var(--muted);font-size:13px}
.k-reply .msg{font-weight:500}.err .msg{color:var(--err)}
.empty{color:var(--muted);padding:24px;text-align:center}
</style></head><body>
<header><h1>mcbot 控制台</h1><span class="hint">只在本机可见 · 每 1.5 秒刷新</span></header>
<main><section class="bots" id="bots"><div class="empty">还没有托管记录</div></section>
<section class="feed"><div class="bar"><span id="title">选择左边的 Bot</span><span style="flex:1"></span>
<label><input type="checkbox" id="f-tool" checked>工具调用</label><label><input type="checkbox" id="f-info">驱动器提示</label><label><input type="checkbox" id="f-auto" checked>自动滚动</label></div>
<div class="bar" id="now"></div><div id="rows"></div></section></main>
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
