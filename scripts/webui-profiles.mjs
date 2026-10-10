// WebUI 的托管配置：按档案存在 runtime/webui-profiles.json（被 git 忽略），用 node scripts/start-server-play.mjs --headless 启动（不需要 PowerShell）。
// 只存启动参数和路径，不存凭据：Agent 用本机已有的登录或配置目录；API key 以后再做（credential.kind 预留）。
// 档案只记游戏目录和模式（lan：玩家自己的游戏开单人世界再对局域网开放；server：本机的服务器目录），
// 连接文件由游戏目录推出来（模组写在 config/mcbot-server-control/connection.json），里面的控制令牌只在这里校验，不返回给网页。
// 旧档案存的是 connectionFile，读的时候换成游戏目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectionFileOf, gameDirOf, gameType, readGameConfig, writeGameConfig } from './webui-games.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'webui-profiles.json';
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const ID_RE = /^[0-9a-f]{8}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;
// 外观：<来源>=<选项>，比如 yes_steve_model:model=ds_whale.ysm；选项不能带引号、反斜杠和控制字符
const APPEARANCE_RE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+=[^"\\\u0000-\u001f\u007f]{1,128}$/;
const LOG_TAIL_BYTES = 4096;

export const AGENTS = Object.freeze({
  claude: { label: 'Claude Code', efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // 模型列表从本机 CLI 读（agent-models.mjs）；读不到时只给别名，别名总是指向最新版
    fallbackModels: ['opus', 'sonnet', 'fable', 'haiku'],
    accountRe: /^\.claude(-[A-Za-z0-9_-]+)?$/, accountHint: 'Claude 的配置目录，例如 ~/.claude-b；留空则使用默认账号' },
  // Codex 每个模型支持的档位不同（有的到 ultra），配置页按模型目录收窄；这里是允许的全集
  codex: { label: 'Codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    fallbackModels: [], accountRe: /^\.codex(-[A-Za-z0-9_-]+)?$/, accountHint: 'CODEX_HOME 目录；留空则使用默认账号' },
  // dsh 的思考强度只有 low、high、max（medium 会被当成 high）
  dsh: { label: 'dsh（DeepSeek）', efforts: ['low', 'high', 'max'],
    fallbackModels: [], accountRe: /^\.dsh$/,
    accountHint: 'DSH_HOME；留空则使用仓库中的 runtime/dsh/home，填写 ~/.dsh 则使用桌面版已配置的凭据' },
});

/** 会话选项：null 表示用驱动器默认值。 */
export const SESSION_OPTIONS = Object.freeze({
  idleMinutes: { flag: '--idle-minutes', min: 0, max: 1440 },
  resumeWindowMin: { flag: '--resume-window-min', min: 0, max: 1440 },
  rotateTokens: { flag: '--rotate-tokens', min: 0, max: 2000000 },
  maxRestarts: { flag: '--max-restarts', min: 0, max: 100 },
});

/** 保护玩家（8h）：开关是布尔（默认开），数值 null 表示用默认值。 */
export const GUARD_OPTIONS = Object.freeze({
  guard: { flag: '--guard', kind: 'switch' },
  guardRadius: { flag: '--guard-radius', min: 3, max: 12 },
  guardLowHealth: { flag: '--guard-low-health', min: 4, max: 16 },
  guardBow: { flag: '--guard-bow', kind: 'switch' },
  guardShield: { flag: '--guard-shield', kind: 'switch' },
});

export const MODES = Object.freeze({ lan: '单人 / 局域网', server: '服务器' });
const KEYS = new Set(['id', 'label', 'agent', 'gameDir', 'mode', 'username', 'port', 'connectionFile', 'configDir', 'model', 'effort', 'nickname', 'memoryDir', 'blueprintDir', 'nodePath',
  'credential', 'updatedAt', 'appearance', ...Object.keys(SESSION_OPTIONS), ...Object.keys(GUARD_OPTIONS)]);

const plainText = (v) => typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v);
export const expandHome = (v) => /^~(?=$|[\\/])/.test(v) ? path.join(os.homedir(), v.slice(1)) : v;

function checkPath(v, label, required = false) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${label}不能为空`);
    return '';
  }
  if (!plainText(v) || v.length > 400) throw new Error(`${label}格式错误`);
  const expanded = expandHome(v);
  if (!path.isAbsolute(expanded)) throw new Error(`${label}须为完整路径（可用 ~ 开头）`);
  return path.normalize(expanded);
}

/** 游戏目录和模式；旧档案只有 connectionFile 时从它推出游戏目录，模式看目录里有没有 server.properties。 */
function gameOf(input) {
  let gameDir = checkPath(input.gameDir, '游戏目录');
  if (!gameDir && input.connectionFile) {
    gameDir = gameDirOf(checkPath(input.connectionFile, '连接文件'));
    if (!gameDir) throw new Error('旧配置的连接文件不在游戏目录中，请在「连接配置」中重新选择游戏');
  }
  if (!gameDir) throw new Error('请先在「连接配置」中选择游戏');
  const mode = input.mode === undefined || input.mode === null || input.mode === '' ? gameType(gameDir) : input.mode;
  if (!MODES[mode]) throw new Error('模式仅可为单人局域网或服务器');
  return { gameDir, mode };
}

/** Bot 的游戏名：存在档案里，启动托管前写进游戏的 server.json。旧档案没有就留空，启动时用游戏里现在的名字。 */
function botName(v) {
  const name = String(v ?? '').trim();
  if (name && !NAME_RE.test(name)) throw new Error('游戏名仅可使用英文字母、数字和下划线，最多 16 个字符');
  return name;
}
/** 控制口端口（只在本机）；null 表示沿用游戏里现在的（默认 8766）。 */
function portOf(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('端口须为 1024～65535 的整数');
  return n;
}

/** 校验并整理一份档案；不认识的字段（比如 apiKey）直接拒绝，避免明文凭据被存下来。 */
export function normalizeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('档案格式错误');
  for (const k of Object.keys(input)) if (!KEYS.has(k)) throw new Error(`不支持的字段：${k}`);
  const agent = AGENTS[input.agent] ? input.agent : null;
  if (!agent) throw new Error('Agent 仅可为 claude、codex 或 dsh');
  const label = String(input.label ?? '').trim();
  if (!plainText(label) || !label || label.length > 40) throw new Error('名称须为 1～40 个字符');
  const effort = input.effort || 'low';
  if (!AGENTS[agent].efforts.includes(effort)) throw new Error(`${AGENTS[agent].label} 的思考强度仅可为 ${AGENTS[agent].efforts.join('、')}`);
  const model = String(input.model ?? '').trim();
  if (model && !MODEL_RE.test(model)) throw new Error('模型名仅可包含字母、数字和 . _ - : / [ ]');
  const nickname = String(input.nickname ?? '').trim();
  if (nickname && (!plainText(nickname) || nickname.length > 16 || nickname.startsWith('-'))) throw new Error('昵称最多 16 个字符，且不可以 - 开头');
  const appearance = String(input.appearance ?? '').trim();
  if (appearance && !APPEARANCE_RE.test(appearance)) throw new Error('外观须从服务器提供的列表中选择');
  const credential = input.credential ?? { kind: 'login' };
  if (credential?.kind !== 'login' || Object.keys(credential).length !== 1) throw new Error('凭据目前仅支持「使用本机已有登录」，暂不支持 API key');
  const out = {
    id: input.id && ID_RE.test(input.id) ? input.id : crypto.randomBytes(4).toString('hex'),
    label, agent, effort, model, nickname, appearance,
    ...gameOf(input),
    username: botName(input.username),
    port: portOf(input.port),
    configDir: checkPath(input.configDir, '账号目录'),
    memoryDir: checkPath(input.memoryDir, '记忆目录'),
    blueprintDir: checkPath(input.blueprintDir, '蓝图目录'),
    nodePath: checkPath(input.nodePath, 'Node 路径'),
    credential: { kind: 'login' },
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
  };
  for (const [k, o] of Object.entries(SESSION_OPTIONS)) {
    const v = input[k];
    if (v === undefined || v === null || v === '') { out[k] = null; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < o.min || n > o.max) throw new Error(`${k} 须为 ${o.min}～${o.max} 的整数`);
    out[k] = n;
  }
  for (const [k, o] of Object.entries(GUARD_OPTIONS)) {
    const v = input[k];
    if (o.kind === 'switch') {
      if (v !== undefined && v !== null && typeof v !== 'boolean') throw new Error(`${k} 须为开启或关闭`);
      out[k] = v !== false; continue;
    }
    if (v === undefined || v === null || v === '') { out[k] = null; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < o.min || n > o.max) throw new Error(`${k} 须为 ${o.min}～${o.max} 的整数`);
    out[k] = n;
  }
  return out;
}

export function loadProfiles(runtime) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(runtime, FILE), 'utf8'));
    return Array.isArray(data?.profiles) ? data.profiles.flatMap((p) => { try { return [normalizeProfile(p)]; } catch { return []; } }) : [];
  } catch { return []; }
}

function writeProfiles(runtime, profiles) {
  fs.mkdirSync(runtime, { recursive: true });
  const file = path.join(runtime, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles }, null, 2));
  fs.renameSync(tmp, file);
}

export function saveProfile(runtime, input) {
  const profile = { ...normalizeProfile(input), updatedAt: Date.now() };
  const list = loadProfiles(runtime);
  const i = list.findIndex((p) => p.id === profile.id);
  if (i >= 0) list[i] = profile; else list.push(profile);
  writeProfiles(runtime, list);
  return profile;
}

export function deleteProfile(runtime, id) {
  const list = loadProfiles(runtime);
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  writeProfiles(runtime, next);
  return true;
}

/** 读连接文件，只返回角色名、世界和地址；和 scripts/start-server-play.mjs 一样只认本机 http 的 ServerBody。 */
export function inspectConnection(file) {
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return e.code === 'ENOENT' ? { ok: false, code: 'missing', error: '连接文件不存在' } : { ok: false, error: '连接文件无法读取或不是 JSON' };
  }
  if (c?.protocol !== 2 || c?.backend !== 'server') return { ok: false, error: '不是协议 2 的 ServerBody 连接文件' };
  if (!NAME_RE.test(c.username || '') || !c.worldId || !c.token) return { ok: false, error: '连接文件缺少有效的 username、worldId 或令牌' };
  let endpoint;
  try { endpoint = new URL(c.endpoint); } catch { return { ok: false, error: '连接文件中的地址无效' }; }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) return { ok: false, error: '目前仅支持本机 http 控制端口' };
  return { ok: true, username: c.username, worldId: String(c.worldId), endpoint: endpoint.origin };
}

/** 档案对应的游戏现在能不能连：错误说成玩家能照着做的话，不提连接文件。 */
export function profileGame(profile) {
  const server = profile.mode === 'server';
  let isDir = false;
  try { isDir = fs.statSync(profile.gameDir).isDirectory(); } catch { /* 不存在 */ }
  if (!isDir) return { ok: false, error: server ? '未找到此服务器目录，请在「连接配置」中重新选择' : '未找到此游戏目录，请在「连接配置」中重新选择' };
  if (server !== (gameType(profile.gameDir) === 'server')) return { ok: false, error: server ? '此目录不是服务器目录（缺少 server.properties），请在「连接配置」中重新选择' : '此目录为服务器目录，请使用「服务器」模式' };
  return { ok: true };
}
/** Bot 名：档案里填的，没填就用游戏里现在的。 */
export const profileName = (profile) => profile.username || readGameConfig(profile.gameDir).username;

/** 把档案里的 Bot 名和端口写进游戏（保存和启动托管时都写）；返回写之后的名字。 */
export function applyToGame(profile) {
  const game = profileGame(profile);
  if (!game.ok) return game;
  const now = readGameConfig(profile.gameDir), username = profile.username || now.username;
  if (!username) return { ok: false, error: '请先在「角色」中填写 Bot 的游戏名' };
  const r = writeGameConfig(profile.gameDir, { username, port: profile.port ?? now.port });
  return r.ok ? { ...r, username, renamed: !!now.username && now.username !== username } : r;
}

export function profileConnection(profile) {
  const server = profile.mode === 'server';
  const game = profileGame(profile);
  if (!game.ok) return game;
  const conn = inspectConnection(connectionFileOf(profile.gameDir));
  if (conn.ok || conn.code !== 'missing') return conn;
  return { ok: false, error: server ? '服务器尚未启动过：安装核心模组后，请先启动一次服务器' : '尚未打开过世界：请进入游戏打开世界，按 Esc 选择「对局域网开放」' };
}

/**
 * 记忆目录里有哪些玩家档案（shared/players/<游戏名>.md）；只看文件在不在，不读内容。
 * 人设在「灵魂设置」中按 Bot 编辑（见 webui-games.mjs 的 personaFile）。留空时和驱动器一样用默认位置。
 */
export function inspectMemory(dir, agent = 'claude', root = ROOT) {
  let base = '';
  try { base = dir ? checkPath(dir, '记忆目录') : agent === 'claude' ? path.join(root, 'memory') : path.join(root, 'runtime', `${agent}-memory`); } catch (e) { return { ok: false, error: e.message }; }
  let players = [];
  try { players = fs.readdirSync(path.join(base, 'shared', 'players')).filter((n) => /^[A-Za-z0-9_]{1,16}\.md$/.test(n)).map((n) => n.slice(0, -3)).sort(); } catch { /* 没有就空着 */ }
  return { ok: true, players, text: players.length ? `玩家档案：${players.join('、')}` : `${dir ? '此目录' : '默认位置 ' + base}中没有玩家档案（shared/players）` };
}

/**
 * 服务器提供的外观（比如装了 YSM 适配时的模型列表）：用连接文件里的令牌问一次 hello，只返回外观部分。
 * 令牌不返回给网页；服务器没开时说一声，网页照样能保存已选的外观。
 */
export async function appearanceChoices(file, fetchImpl = fetch) {
  const conn = inspectConnection(file);
  if (!conn.ok) return conn;
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, error: '连接文件无法读取' }; }
  let hello;
  try {
    const r = await fetchImpl(c.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
    const v = await r.json();
    if (!r.ok || v?.ok !== true) return { ok: false, error: `服务器拒绝请求：${v?.error?.code || r.status}` };
    hello = v.result;
  } catch { return { ok: false, error: '服务器未运行或无法连接' }; }
  const sources = (Array.isArray(hello?.appearances) ? hello.appearances : [])
    .filter((s) => typeof s?.id === 'string' && Array.isArray(s.choices))
    .map((s) => ({ id: s.id, choices: s.choices.filter((x) => typeof x === 'string' && APPEARANCE_RE.test(`${s.id}=${x}`)) }));
  return { ok: true, sources };
}

/** 本机用户目录里像账号目录的文件夹（只列名字，不读里面的东西）。 */
export function accountDirs(home = os.homedir()) {
  let names = [];
  try { names = fs.readdirSync(home, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* 没有就空着 */ }
  return Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, names.filter((n) => a.accountRe.test(n)).sort().map((n) => `~/${n}`)]));
}

/** 拼 scripts/start-server-play.mjs 的参数。每个值都是单独一项，不经过 shell；值不会以 - 开头（路径是绝对路径，其余已校验）。 */
export function launchArgs(profile, script = path.join(ROOT, 'scripts', 'start-server-play.mjs')) {
  // --wait：世界没开、没开局域网时一直等，断开了自动重连，死了先复活（见 start-server-play.mjs）
  const a = [script, '--connection-file', connectionFileOf(profile.gameDir), '--agent', profile.agent, '--effort', profile.effort, '--headless', '--wait'];
  const name = profileName(profile);
  if (name) a.push('--username', name);
  if (profile.nickname) a.push('--nickname', profile.nickname);
  if (profile.configDir) a.push('--config-dir', profile.configDir);
  if (profile.memoryDir) a.push('--memory-dir', profile.memoryDir);
  if (profile.blueprintDir) a.push('--blueprint-dir', profile.blueprintDir);
  if (profile.model) a.push('--model', profile.model);
  if (profile.nodePath) a.push('--node-path', profile.nodePath);
  if (profile.appearance) a.push('--appearance', profile.appearance);
  for (const [k, o] of Object.entries(SESSION_OPTIONS)) if (profile[k] !== null && profile[k] !== undefined) a.push(o.flag, String(profile[k]));
  for (const [k, o] of Object.entries(GUARD_OPTIONS)) {
    if (o.kind === 'switch') a.push(o.flag, profile[k] === false ? 'off' : 'on');
    else if (profile[k] !== null && profile[k] !== undefined) a.push(o.flag, String(profile[k]));
  }
  return a;
}

const tail = (file) => {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
};

/**
 * 托管进程退出的原因，给网页显示：跑过一阵才退出的不算「启动失败」。
 * 用户点了停止的先认（等待期间断开过的日志里也会有断开字样）；没带 --wait 的旧托管在游戏关了或退出世界时报连接断开。
 */
export function endReason(rec, log = '') {
  if (/收到停止|stop marker/i.test(log)) return 'stopped';
  if (/TRANSPORT_LOST|CONTROL_UNREACHABLE|超时或断开/.test(log)) return 'disconnected';
  if (rec.exitCode === 0) return 'stopped';
  return (rec.endedAt || 0) - rec.startedAt > 60000 ? 'crashed' : 'failed';
}

/** 启动脚本在等什么：日志里最后一行「[等待] …」之后还没开始托管就算在等。 */
export function waitingText(log = '') {
  const lines = log.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[等待\] (.+)$/.exec(lines[i].trim());
    if (m) return m[1];
    if (/^ServerBody 配置：/.test(lines[i].trim())) return '';
  }
  return '';
}

/** 启动记录：同一个 WebUI 进程里启动过的，记下进程和退出码；脚本的输出写进 runtime/webui-launch-<角色>.log。 */
export function createLauncher({ runtime, isRunning, command = launchCommand(), spawnImpl = spawn }) {
  const launches = new Map();
  return {
    launch(profile) {
      // 世界开没开不用管：启动脚本会等。这里只把名字和端口写进游戏
      const applied = applyToGame(profile);
      if (!applied.ok) return applied;
      const name = applied.username;
      if (isRunning(name)) return { ok: false, error: `${name} 已在托管中，请先停止再启动` };
      const last = launches.get(name);
      if (last && last.exitCode === null) return { ok: false, error: `${name} 已启动（等待世界或托管中），请先停止再启动` };
      fs.mkdirSync(runtime, { recursive: true });
      const logFile = path.join(runtime, `webui-launch-${name}.log`);
      const fd = fs.openSync(logFile, 'w');
      let child;
      try {
        // 用 Node 直接跑启动脚本，不需要 PowerShell。Windows 上不 detached（以前 detached 的 pwsh 没有控制台会直接退出），
        // 输出写进日志文件、不占控制台；关掉 WebUI 后托管是否继续见 docs/dev.md 的本地 WebUI。
        child = spawnImpl(command[0], [...command.slice(1), ...launchArgs(profile)], {
          cwd: ROOT, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', fd, fd],
          env: { ...process.env, COMPANION_RUNTIME_DIR: runtime },
        });
      } catch (e) {
        fs.closeSync(fd);
        return { ok: false, error: `启动失败：${e.message}` };
      }
      fs.closeSync(fd);
      const rec = { profileId: profile.id, pid: child.pid, startedAt: Date.now(), exitCode: null, logFile };
      launches.set(name, rec);
      child.on('error', (e) => { rec.exitCode = -1; rec.error = e.message; rec.endedAt = Date.now(); });
      child.on('exit', (code) => { rec.exitCode = code ?? -1; rec.endedAt = Date.now(); });
      child.unref();
      return { ok: true, name, pid: child.pid };
    },
    /** 给网页看的状态：退出了就带上日志末尾，方便看为什么没起来。 */
    status(name) {
      const rec = launches.get(name);
      if (!rec) return null;
      const log = tail(rec.logFile);
      return { profileId: rec.profileId, startedAt: rec.startedAt, endedAt: rec.endedAt || 0, exitCode: rec.exitCode,
        error: rec.error || '', log: rec.exitCode === null ? '' : log, ended: rec.exitCode === null ? '' : endReason(rec, log),
        waiting: rec.exitCode === null ? waitingText(log) : '' };
    },
  };
}

/** 默认用跑 WebUI 的同一个 Node 跑启动脚本；测试用环境变量 MCBOT_WEBUI_LAUNCH_CMD（JSON 数组）替换。 */
export function launchCommand(env = process.env) {
  if (env.MCBOT_WEBUI_LAUNCH_CMD) {
    const cmd = JSON.parse(env.MCBOT_WEBUI_LAUNCH_CMD);
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((s) => typeof s === 'string')) throw new Error('MCBOT_WEBUI_LAUNCH_CMD 须为字符串数组');
    return cmd;
  }
  return [process.execPath];
}
