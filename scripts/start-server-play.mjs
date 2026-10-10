#!/usr/bin/env node
// 接入已启动的 ServerBody 控制口并启动托管；Agent 默认在本机现有登录环境运行。
// 只要 Node，不需要 PowerShell：WebUI 和绿色版都用这个；start-server-play.ps1 只是把参数转过来。
// 用法：node scripts/start-server-play.mjs --connection-file <connection.json> [--agent claude|codex|dsh] [--effort low] [--prepare-only] ...
// --wait（WebUI 用）：世界没开、没对局域网开放、游戏暂停时一直等，能接管了再启动托管；角色断开（游戏关了、退出世界、
// 死了）就回去等，能连上时自动接上，死了的先原生复活。--username <名字> 是配置里的 Bot 名，世界里的名字不一样时等玩家重进世界；
// 等待期间 runtime/companion-<名字>.stop 一样能停。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { respawnIfDead } from './server-body-control.mjs';
import { RECONNECT_EXIT } from './companion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = ['claude', 'codex', 'dsh'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const ON_OFF = ['on', 'off'];
const NICKNAMES = { claude: '小克', dsh: 'DeepSeek', codex: 'Codex' };
// 会话选项，-1（或不填）表示用驱动器的默认值（见 scripts/companion.mjs 开头的说明）
const SESSION = { 'idle-minutes': 1440, 'resume-window-min': 1440, 'rotate-tokens': 2000000, 'max-restarts': 100 };
const VALUE_FLAGS = ['connection-file', 'agent', 'nickname', 'config-dir', 'memory-dir', 'model', 'node-path', 'effort',
  'guard', 'guard-radius', 'guard-low-health', 'guard-bow', 'guard-shield', 'appearance', 'blueprint-dir', 'username', ...Object.keys(SESSION)];
const SWITCHES = ['headless', 'prepare-only', 'wait'];

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`不支持的参数：${flag}`);
    const key = flag.slice(2);
    if (SWITCHES.includes(key)) { o[key] = true; continue; }
    if (!VALUE_FLAGS.includes(key)) throw new Error(`不支持的参数：${flag}`);
    if (i + 1 >= argv.length) throw new Error(`${flag} 缺少参数值`);
    o[key] = argv[++i];
  }
  return o;
}

const oneOf = (value, allowed, name, fallback) => {
  const v = value ?? fallback;
  if (!allowed.includes(v)) throw new Error(`${name} 应为 ${allowed.join('/')}`);
  return v;
};
const intIn = (value, lo, hi, name) => {
  if (value === undefined || value === '') return undefined;
  if (!/^-?\d+$/.test(String(value))) throw new Error(`${name} 须为整数`);
  const n = Number(value);
  if (n < lo || n > hi) throw new Error(`${name} 应为 ${lo}..${hi}`);
  return n;
};
const full = (p) => path.resolve(p);

/** 读连接文件、检查参数、写 runtime/server-play/<角色>/mcp.json；返回驱动器的启动参数。不读也不写令牌以外的凭据，令牌不进 mcp.json。 */
export function prepareServerPlay(options, { root = ROOT, env = process.env, execPath = process.execPath } = {}) {
  if (!options['connection-file']) throw new Error('请提供服务端生成的 config/mcbot-server-control/connection.json（--connection-file）');
  const connectionPath = full(options['connection-file']);
  if (!fs.existsSync(connectionPath) || !fs.statSync(connectionPath).isFile()) throw new Error('请提供服务端生成的 config/mcbot-server-control/connection.json');
  const connection = JSON.parse(fs.readFileSync(connectionPath, 'utf8').replace(/^﻿/, ''));
  if (connection.protocol !== 2 || connection.backend !== 'server' || !/^[A-Za-z0-9_]{1,16}$/.test(String(connection.username ?? ''))
    || !String(connection.worldId ?? '').trim() || !String(connection.token ?? '').trim()) {
    throw new Error('连接文件必须是协议 2 的 ServerBody，并包含有效的 username/worldId');
  }
  let endpoint;
  try { endpoint = new URL(connection.endpoint); } catch { throw new Error('连接文件的 endpoint 不是有效地址'); }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.pathname !== '/v2'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('当前仅支持本机 http 控制口 /v2；远程部署需后续独立验收');
  }
  const agent = oneOf(options.agent, AGENTS, 'agent', 'claude');
  const effort = oneOf(options.effort, EFFORTS, 'effort', 'low');
  const guard = oneOf(options.guard, ON_OFF, 'guard', 'on');
  const guardBow = oneOf(options['guard-bow'], ON_OFF, 'guard-bow', 'on');
  const guardShield = oneOf(options['guard-shield'], ON_OFF, 'guard-shield', 'on');
  // 保护玩家（8h）：半径 3..12、撤退血量 4..16；0 表示用默认 8
  const guardRadius = intIn(options['guard-radius'], 0, 12, 'guard-radius');
  const guardLowHealth = intIn(options['guard-low-health'], 0, 16, 'guard-low-health');
  if (guardRadius > 0 && guardRadius < 3) throw new Error('guard-radius 应为 3..12（0 表示默认）');
  if (guardLowHealth > 0 && guardLowHealth < 4) throw new Error('guard-low-health 应为 4..16（0 表示默认）');
  const session = {};
  for (const [flag, hi] of Object.entries(SESSION)) session[flag] = intIn(options[flag], -1, hi, flag);
  let nodePath = execPath;
  if (options['node-path']) {
    nodePath = full(options['node-path']);
    if (!fs.existsSync(nodePath) || !fs.statSync(nodePath).isFile()) throw new Error('node-path 必须指向可用的 Node 可执行文件');
  }
  const appearance = options.appearance || '';
  // 外观：<来源>=<选项>（WebUI 从服务器的列表里选，比如 yes_steve_model:model=ds_whale.ysm），每次接管时套用
  if (appearance && !/^[a-z0-9_.-]+:[a-z0-9_/.-]+=[^"\\\x00-\x1f\x7f]{1,128}$/.test(appearance)) throw new Error('appearance 应为 <来源>=<选项>');
  const name = String(connection.username);
  const worldId = String(connection.worldId);
  const nickname = options.nickname || NICKNAMES[agent];
  const entry = path.join(root, 'client-runtime', 'dist', 'main.js');
  const prepareOnly = !!options['prepare-only'];
  if (!prepareOnly && !fs.existsSync(entry)) throw new Error('未找到运行端：请先在 client-runtime 目录运行 npm install 和 npm run build');
  // dsh 用 DeepSeek Harness 桌面版自带的，或 runtime/dsh 的锁定安装（见 docs/dev.md）；DeepSeek 凭据用 DEEPSEEK_API_KEY 或 dsh 自己的凭据配置提供，这里不读取。
  if (agent === 'dsh' && !prepareOnly && !env.MCBOT_DSH_BIN) {
    const dshBin = path.join(root, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const desktop = env.MCBOT_DSH_DESKTOP || path.join(env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
    if (!fs.existsSync(dshBin) && !fs.existsSync(path.join(desktop, 'DeepSeek Harness.exe'))) {
      throw new Error('未找到 dsh：请安装 DeepSeek Harness 桌面版，或在 runtime/dsh 中运行 npm install --save-exact @deepseek-ai/dsh@0.2.0-rc.2');
    }
  }
  const playDir = path.join(root, 'runtime', 'server-play', name);
  fs.mkdirSync(playDir, { recursive: true });
  const configFile = path.join(playDir, 'mcp.json');
  const mcpArgs = [entry, '--body', 'server', '--connection-file', connectionPath, '--username', name, '--nickname', nickname,
    '--world-id', worldId, '--guard', guard, '--guard-bow', guardBow, '--guard-shield', guardShield];
  if (guardRadius > 0) mcpArgs.push('--guard-radius', String(guardRadius));
  if (guardLowHealth > 0) mcpArgs.push('--guard-low-health', String(guardLowHealth));
  if (options['blueprint-dir']) mcpArgs.push('--blueprint-dir', full(options['blueprint-dir']));
  if (appearance) mcpArgs.push('--appearance', appearance);
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { minecraft: { command: nodePath, args: mcpArgs } } }, null, 2));
  const driverArgs = [path.join(root, 'scripts', 'companion.mjs'), '--agent', agent, '--body', 'server', '--name', name,
    '--nickname', nickname, '--mcp-config', configFile, '--effort', effort];
  if (options['config-dir']) driverArgs.push('--config-dir', full(options['config-dir']));
  if (options['memory-dir']) driverArgs.push('--memory-dir', full(options['memory-dir']));
  if (options.model) driverArgs.push('--model', options.model);
  for (const [flag, value] of Object.entries(session)) if (value !== undefined && value >= 0) driverArgs.push(`--${flag}`, String(value));
  if (options.headless) driverArgs.push('--headless');
  if (options.wait) driverArgs.push('--reconnect');
  const lines = [`ServerBody 配置：${configFile}`, `角色：${name}；世界：${worldId}；Agent：${agent}；思考：${effort}`,
    `默认使用本机现有的 Agent 登录。停止托管：在 WebUI 中点击「停止托管」（从仓库运行时也可使用 stop-companion.ps1 ${name}），角色将保留`,
    `叫停后，请使用角色名或昵称明确提出新任务，例如：${nickname}，查询状态。`];
  return { name, worldId, configFile, nodePath, driverArgs, lines, prepareOnly };
}

const WAIT_TEXT = {
  closed: '等待世界打开：请进入游戏打开世界（单人模式还需按 Esc 选择「对局域网开放」），或启动服务器',
  SINGLEPLAYER_NOT_LAN: '世界已打开：请按 Esc 选择「对局域网开放」',
  GAME_PAUSED: '游戏已暂停：请返回游戏',
};

/**
 * 现在能不能接管：每次重新读连接文件（模组每次开世界都换令牌），问一次 respawn——服务端在接管前检查
 * 单人有没有开局域网、是不是暂停，死了的角色顺便原生复活，活着的回 INVALID_ARGUMENT（当作 alive）。
 */
export async function readiness(connectionPath, expected = '', { respawn = respawnIfDead } = {}) {
  let c = null;
  try { c = JSON.parse(fs.readFileSync(connectionPath, 'utf8').replace(/^﻿/, '')); } catch { return { ok: false, wait: WAIT_TEXT.closed, code: 'NO_CONNECTION_FILE' }; }
  const username = String(c?.username ?? ''), worldId = String(c?.worldId ?? '');
  if (expected && username && username !== expected) {
    return { ok: false, code: 'NAME_PENDING', wait: `世界中的 Bot 名称仍为 ${username}，配置中为 ${expected}：退出并重新进入世界（服务器需重启）后改为新名称` };
  }
  const outcome = await respawn({ connectionFile: connectionPath, username, worldId });
  if (outcome === 'alive') return { ok: true, respawned: false };
  if (outcome === 'respawned') return { ok: true, respawned: true };
  return { ok: false, code: outcome, wait: WAIT_TEXT[outcome] || WAIT_TEXT.closed };
}

function runDriver(prepared, respawned) {
  return new Promise((resolve) => {
    const child = spawn(prepared.nodePath, prepared.driverArgs, { cwd: ROOT, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, ...(respawned ? { MCBOT_RESPAWNED: '1' } : {}) } });
    child.on('error', (e) => { console.error(`驱动器启动失败：${e.message}`); resolve(1); });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** --wait：等到能接管再启动托管，断开了回去等；返回最后的退出码。 */
export async function supervise(options, { runtime = process.env.COMPANION_RUNTIME_DIR ? path.resolve(process.env.COMPANION_RUNTIME_DIR) : path.join(ROOT, 'runtime'),
  check = readiness, prepare = prepareServerPlay, run = runDriver, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, now = Date.now, pollMs = 2000 } = {}) {
  if (!options['connection-file']) throw new Error('请提供游戏目录中的 config/mcbot-server-control/connection.json（--connection-file）');
  const connectionPath = full(options['connection-file']);
  const expected = options.username || '';
  if (expected && !/^[A-Za-z0-9_]{1,16}$/.test(expected)) throw new Error('--username 必须是 1～16 位英文、数字或下划线');
  const stopFile = expected ? path.join(runtime, `companion-${expected}.stop`) : '';
  const stopRequested = () => {
    if (!stopFile || !fs.existsSync(stopFile)) return false;
    try { fs.rmSync(stopFile, { force: true }); } catch { /* 下一轮还会看到 */ }
    return true;
  };
  let said = '', quickExits = 0;
  for (;;) {
    if (stopRequested()) { log('已收到停止请求，停止等待'); return 0; }
    const state = await check(connectionPath, expected);
    if (!state.ok) {
      if (state.wait !== said) { log(`[等待] ${state.wait}`); said = state.wait; }
      await sleep(pollMs);
      continue;
    }
    said = '';
    // 每次连上都重新准备：世界可能换了（worldId 跟着连接文件走）
    const prepared = prepare(options);
    for (const line of prepared.lines) log(line);
    if (state.respawned) log('角色此前已死亡，现已原生复活（有床时在床边，否则在世界出生点）');
    const started = now();
    const code = await run(prepared, state.respawned);
    if (code !== RECONNECT_EXIT) return code;
    // 一连上就断的（比如身份对不上）别连得太勤
    quickExits = now() - started < 30000 ? quickExits + 1 : 0;
    log('[等待] 角色已断开，可连接时将自动恢复');
    said = '';
    await sleep(quickExits ? Math.min(60000, 5000 * quickExits) : 1000);
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (options.wait && !options['prepare-only']) {
    try { process.exit(await supervise(options)); } catch (e) { console.error(e.message); process.exit(2); }
  }
  let prepared;
  try { prepared = prepareServerPlay(options); } catch (e) { console.error(e.message); process.exit(2); }
  for (const line of prepared.lines) console.log(line);
  if (prepared.prepareOnly) return;
  const child = spawn(prepared.nodePath, prepared.driverArgs, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  child.on('error', (e) => { console.error(`驱动器启动失败：${e.message}`); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
