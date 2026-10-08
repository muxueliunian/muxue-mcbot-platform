// WebUI 的托管配置：按档案存在 runtime/webui-profiles.json（被 git 忽略），用 start-server-play.ps1 -Headless 启动。
// 只存启动参数和路径，不存凭据：Agent 用本机已有的登录或配置目录；API key 以后再做（credential.kind 预留）。
// 连接文件里的控制令牌只在这里校验，不返回给网页。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'webui-profiles.json';
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const ID_RE = /^[0-9a-f]{8}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;
const LOG_TAIL_BYTES = 4096;

export const AGENTS = Object.freeze({
  claude: { label: 'Claude Code', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultNickname: '小克',
    // 模型列表从本机 CLI 读（agent-models.mjs）；读不到时只给别名，别名总是指向最新版
    fallbackModels: ['opus', 'sonnet', 'fable', 'haiku'],
    accountRe: /^\.claude(-[A-Za-z0-9_-]+)?$/, accountHint: 'Claude 的配置目录，比如 ~/.claude-b；留空用默认账号' },
  // Codex 每个模型支持的档位不同（有的到 ultra），配置页按模型目录收窄；这里是允许的全集
  codex: { label: 'Codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultNickname: 'Codex',
    fallbackModels: [], accountRe: /^\.codex(-[A-Za-z0-9_-]+)?$/, accountHint: 'CODEX_HOME 目录；留空用默认账号' },
  // dsh 的思考强度只有 low、high、max（medium 会被当成 high）
  dsh: { label: 'dsh（DeepSeek）', efforts: ['low', 'high', 'max'], defaultNickname: 'DeepSeek',
    fallbackModels: [], accountRe: /^\.dsh$/,
    accountHint: 'DSH_HOME；留空用仓库里的 runtime/dsh/home，填 ~/.dsh 用桌面版配好的凭据' },
});

/** 会话选项：null 表示用驱动器默认值。 */
export const SESSION_OPTIONS = Object.freeze({
  idleMinutes: { flag: '-IdleMinutes', min: 0, max: 1440 },
  resumeWindowMin: { flag: '-ResumeWindowMin', min: 0, max: 1440 },
  rotateTokens: { flag: '-RotateTokens', min: 0, max: 2000000 },
  maxRestarts: { flag: '-MaxRestarts', min: 0, max: 100 },
});

/** 保护玩家（8h）：开关是布尔（默认开），数值 null 表示用默认值。 */
export const GUARD_OPTIONS = Object.freeze({
  guard: { flag: '-Guard', kind: 'switch' },
  guardRadius: { flag: '-GuardRadius', min: 3, max: 12 },
  guardLowHealth: { flag: '-GuardLowHealth', min: 4, max: 16 },
  guardBow: { flag: '-GuardBow', kind: 'switch' },
  guardShield: { flag: '-GuardShield', kind: 'switch' },
});

const KEYS = new Set(['id', 'label', 'agent', 'connectionFile', 'configDir', 'model', 'effort', 'nickname', 'memoryDir', 'nodePath',
  'credential', 'updatedAt', ...Object.keys(SESSION_OPTIONS), ...Object.keys(GUARD_OPTIONS)]);

const plainText = (v) => typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v);
export const expandHome = (v) => /^~(?=$|[\\/])/.test(v) ? path.join(os.homedir(), v.slice(1)) : v;

function checkPath(v, label, required = false) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${label}不能为空`);
    return '';
  }
  if (!plainText(v) || v.length > 400) throw new Error(`${label}格式不对`);
  const expanded = expandHome(v);
  if (!path.isAbsolute(expanded)) throw new Error(`${label}要填完整路径（可以用 ~ 开头）`);
  return path.normalize(expanded);
}

/** 校验并整理一份档案；不认识的字段（比如 apiKey）直接拒绝，避免明文凭据被存下来。 */
export function normalizeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('档案格式不对');
  for (const k of Object.keys(input)) if (!KEYS.has(k)) throw new Error(`不认识的字段：${k}`);
  const agent = AGENTS[input.agent] ? input.agent : null;
  if (!agent) throw new Error('Agent 只能是 claude、codex 或 dsh');
  const label = String(input.label ?? '').trim();
  if (!plainText(label) || !label || label.length > 40) throw new Error('名称要 1～40 个字');
  const effort = input.effort || 'low';
  if (!AGENTS[agent].efforts.includes(effort)) throw new Error(`${AGENTS[agent].label} 的思考强度只能是 ${AGENTS[agent].efforts.join('、')}`);
  const model = String(input.model ?? '').trim();
  if (model && !MODEL_RE.test(model)) throw new Error('模型名只能有字母、数字和 . _ - : / [ ]');
  const nickname = String(input.nickname ?? '').trim();
  if (nickname && (!plainText(nickname) || nickname.length > 16 || nickname.startsWith('-'))) throw new Error('昵称最多 16 个字，不能以 - 开头');
  const credential = input.credential ?? { kind: 'login' };
  if (credential?.kind !== 'login' || Object.keys(credential).length !== 1) throw new Error('凭据目前只支持「用本机已有登录」，API key 以后再做');
  const out = {
    id: input.id && ID_RE.test(input.id) ? input.id : crypto.randomBytes(4).toString('hex'),
    label, agent, effort, model, nickname,
    connectionFile: checkPath(input.connectionFile, '连接文件', true),
    configDir: checkPath(input.configDir, '账号目录'),
    memoryDir: checkPath(input.memoryDir, '记忆目录'),
    nodePath: checkPath(input.nodePath, 'Node 路径'),
    credential: { kind: 'login' },
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
  };
  for (const [k, o] of Object.entries(SESSION_OPTIONS)) {
    const v = input[k];
    if (v === undefined || v === null || v === '') { out[k] = null; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < o.min || n > o.max) throw new Error(`${k} 要是 ${o.min}～${o.max} 的整数`);
    out[k] = n;
  }
  for (const [k, o] of Object.entries(GUARD_OPTIONS)) {
    const v = input[k];
    if (o.kind === 'switch') {
      if (v !== undefined && v !== null && typeof v !== 'boolean') throw new Error(`${k} 要是开或关`);
      out[k] = v !== false; continue;
    }
    if (v === undefined || v === null || v === '') { out[k] = null; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < o.min || n > o.max) throw new Error(`${k} 要是 ${o.min}～${o.max} 的整数`);
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

/** 读连接文件，只返回角色名、世界和地址；和 start-server-play.ps1 一样只认本机 http 的 ServerBody。 */
export function inspectConnection(file) {
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? '连接文件不存在' : '连接文件读不了或不是 JSON' };
  }
  if (c?.protocol !== 2 || c?.backend !== 'server') return { ok: false, error: '不是协议 2 的 ServerBody 连接文件' };
  if (!NAME_RE.test(c.username || '') || !c.worldId || !c.token) return { ok: false, error: '连接文件缺少有效的 username、worldId 或令牌' };
  let endpoint;
  try { endpoint = new URL(c.endpoint); } catch { return { ok: false, error: '连接文件里的地址不对' }; }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) return { ok: false, error: '目前只支持本机 http 控制口' };
  return { ok: true, username: c.username, worldId: String(c.worldId), endpoint: endpoint.origin };
}

/** 本机用户目录里像账号目录的文件夹（只列名字，不读里面的东西）。 */
export function accountDirs(home = os.homedir()) {
  let names = [];
  try { names = fs.readdirSync(home, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* 没有就空着 */ }
  return Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, names.filter((n) => a.accountRe.test(n)).sort().map((n) => `~/${n}`)]));
}

/** 拼 start-server-play.ps1 的参数。每个值都是单独一项，不经过 shell；值不会以 - 开头（路径是绝对路径，其余已校验）。 */
export function launchArgs(profile, script = path.join(ROOT, 'start-server-play.ps1')) {
  const a = ['-NoProfile', '-NonInteractive', '-File', script, '-ConnectionFile', profile.connectionFile,
    '-Agent', profile.agent, '-Effort', profile.effort, '-Headless'];
  if (profile.nickname) a.push('-Nickname', profile.nickname);
  if (profile.configDir) a.push('-ConfigDir', profile.configDir);
  if (profile.memoryDir) a.push('-MemoryDir', profile.memoryDir);
  if (profile.model) a.push('-Model', profile.model);
  if (profile.nodePath) a.push('-NodePath', profile.nodePath);
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

/** 启动记录：同一个 WebUI 进程里启动过的，记下进程和退出码；脚本的输出写进 runtime/webui-launch-<角色>.log。 */
export function createLauncher({ runtime, isRunning, command = launchCommand(), spawnImpl = spawn }) {
  const launches = new Map();
  return {
    launch(profile) {
      const conn = inspectConnection(profile.connectionFile);
      if (!conn.ok) return conn;
      const name = conn.username;
      if (isRunning(name)) return { ok: false, error: `${name} 已经在托管了，先停止再启动` };
      const last = launches.get(name);
      if (last && last.exitCode === null && Date.now() - last.startedAt < 30000) return { ok: false, error: `${name} 正在启动` };
      fs.mkdirSync(runtime, { recursive: true });
      const logFile = path.join(runtime, `webui-launch-${name}.log`);
      const fd = fs.openSync(logFile, 'w');
      let child;
      try {
        // Windows 上 detached 的 pwsh 没有控制台，会什么都不做直接退出（实测退出码 0、没有输出）。
        // 不 detached 时关掉 WebUI 会结束 pwsh，但它启动的驱动器 node 不在同一个作业对象里，会继续托管（实测）。
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
      child.on('error', (e) => { rec.exitCode = -1; rec.error = e.message; });
      child.on('exit', (code) => { rec.exitCode = code ?? -1; });
      child.unref();
      return { ok: true, name, pid: child.pid };
    },
    /** 给网页看的状态：退出了就带上日志末尾，方便看为什么没起来。 */
    status(name) {
      const rec = launches.get(name);
      if (!rec) return null;
      return { profileId: rec.profileId, startedAt: rec.startedAt, exitCode: rec.exitCode,
        error: rec.error || '', log: rec.exitCode === null ? '' : tail(rec.logFile) };
    },
  };
}

/** 默认用 pwsh 跑启动脚本；测试用环境变量 MCBOT_WEBUI_LAUNCH_CMD（JSON 数组）替换。 */
export function launchCommand(env = process.env) {
  if (env.MCBOT_WEBUI_LAUNCH_CMD) {
    const cmd = JSON.parse(env.MCBOT_WEBUI_LAUNCH_CMD);
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((s) => typeof s === 'string')) throw new Error('MCBOT_WEBUI_LAUNCH_CMD 要是字符串数组');
    return cmd;
  }
  return ['pwsh'];
}
