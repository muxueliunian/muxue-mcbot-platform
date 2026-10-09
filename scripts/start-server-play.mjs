#!/usr/bin/env node
// 接入已启动的 ServerBody 控制口并启动托管；Agent 默认在本机现有登录环境运行。
// 只要 Node，不需要 PowerShell：WebUI 和绿色版都用这个；start-server-play.ps1 只是把参数转过来。
// 用法：node scripts/start-server-play.mjs --connection-file <connection.json> [--agent claude|codex|dsh] [--effort low] [--prepare-only] ...
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = ['claude', 'codex', 'dsh'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const ON_OFF = ['on', 'off'];
const NICKNAMES = { claude: '小克', dsh: 'DeepSeek', codex: 'Codex' };
// 会话选项，-1（或不填）表示用驱动器的默认值（见 scripts/companion.mjs 开头的说明）
const SESSION = { 'idle-minutes': 1440, 'resume-window-min': 1440, 'rotate-tokens': 2000000, 'max-restarts': 100 };
const VALUE_FLAGS = ['connection-file', 'agent', 'nickname', 'config-dir', 'memory-dir', 'model', 'node-path', 'effort',
  'guard', 'guard-radius', 'guard-low-health', 'guard-bow', 'guard-shield', 'appearance', 'blueprint-dir', ...Object.keys(SESSION)];
const SWITCHES = ['headless', 'prepare-only'];

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`不认识的参数：${flag}`);
    const key = flag.slice(2);
    if (SWITCHES.includes(key)) { o[key] = true; continue; }
    if (!VALUE_FLAGS.includes(key)) throw new Error(`不认识的参数：${flag}`);
    if (i + 1 >= argv.length) throw new Error(`${flag} 后面要有值`);
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
  if (!/^-?\d+$/.test(String(value))) throw new Error(`${name} 要是整数`);
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
  if (!prepareOnly && !fs.existsSync(entry)) throw new Error('找不到运行端：请先在 client-runtime 目录运行 npm install 和 npm run build');
  // dsh 用 DeepSeek Harness 桌面版自带的，或 runtime/dsh 的锁定安装（见 docs/dev.md）；DeepSeek 凭据用 DEEPSEEK_API_KEY 或 dsh 自己的凭据配置提供，这里不读取。
  if (agent === 'dsh' && !prepareOnly && !env.MCBOT_DSH_BIN) {
    const dshBin = path.join(root, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const desktop = env.MCBOT_DSH_DESKTOP || path.join(env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
    if (!fs.existsSync(dshBin) && !fs.existsSync(path.join(desktop, 'DeepSeek Harness.exe'))) {
      throw new Error('找不到 dsh：请安装 DeepSeek Harness 桌面版，或在 runtime/dsh 里运行 npm install --save-exact @deepseek-ai/dsh@0.2.0-rc.2');
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
  const lines = [`ServerBody 配置：${configFile}`, `角色：${name}；世界：${worldId}；Agent：${agent}；思考：${effort}`,
    `默认沿用本机现有 Agent 登录。停止托管：在 WebUI 点「停止托管」（从仓库运行时也可用 stop-companion.ps1 ${name}），角色保留`,
    `叫停后，请用角色名或昵称明确提出新任务，例如：${nickname}，查询状态。`];
  return { name, worldId, configFile, nodePath, driverArgs, lines, prepareOnly };
}

async function main() {
  let prepared;
  try { prepared = prepareServerPlay(parseArgs(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(2); }
  for (const line of prepared.lines) console.log(line);
  if (prepared.prepareOnly) return;
  const child = spawn(prepared.nodePath, prepared.driverArgs, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  child.on('error', (e) => { console.error(`驱动器没能启动：${e.message}`); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
