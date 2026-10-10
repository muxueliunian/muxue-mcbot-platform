// 从本机 Agent CLI 读可用模型（WebUI 配置页用）。都不发对话消息、不消耗额度：
// - Claude Code：stream-json 模式只发 initialize 控制请求，返回里带 models（含每个模型支持的思考强度）；关掉 hooks，不挂 MCP 和工具。
// - Codex：`codex debug models` 输出本地模型目录。
// - dsh：ACP initialize 加一个空的 session/new（不挂 MCP），读 configOptions 里的 model 和 reasoning_effort。会在 DSH_HOME 里留一条空会话记录。
// 结果只保留模型名、说明和思考强度；Claude 返回里的账号信息等字段不往外传。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexCommand } from './agents/codex-app-server.mjs';
import { dshCommand, writeDshPatch } from './agents/dsh-acp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 45000;
const MAX_OUTPUT = 8 * 1024 * 1024;

/** 起一个子进程，逐行把 stdout 交给 onLine；onLine 返回非 undefined 就结束并把它作为结果。 */
function runLines(cmd, args, { env, onStart, onLine, onExit, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { reject(e); return; }
    let buf = '', err = '', size = 0, done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { child.stdin.end(); } catch { /* 已关 */ } child.kill(); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error(`${path.basename(cmd)} 超过 ${timeoutMs / 1000} 秒未返回`)), timeoutMs);
    child.on('error', (e) => finish(reject, e));
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_OUTPUT) return finish(reject, new Error('输出过大'));
      buf += d;
      if (!onLine) return;
      let i;
      while (!done && (i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        try { const r = onLine(msg, (m) => child.stdin.write(JSON.stringify(m) + '\n')); if (r !== undefined) finish(resolve, r); } catch (e) { finish(reject, e); }
      }
    });
    child.on('exit', (code) => {
      if (done) return;
      if (onExit) { try { finish(resolve, onExit(buf, code)); } catch (e) { finish(reject, e); } return; }
      finish(reject, new Error(`进程提前退出（${code}）${err ? '：' + err.trim().split('\n').pop() : ''}`));
    });
    onStart?.((m) => child.stdin.write(JSON.stringify(m) + '\n'));
  });
}

export function claudeModelsFrom(response) {
  return (response?.models ?? []).filter((m) => m?.value && m.value !== 'default').map((m) => ({
    value: String(m.value),
    label: String(m.displayName || m.value),
    desc: [m.resolvedModel && m.resolvedModel !== m.value ? m.resolvedModel : '', m.description || ''].filter(Boolean).join(' · '),
    efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [],
  }));
}

async function claudeModels(configDir) {
  const env = { ...process.env, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) };
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--settings', JSON.stringify({ disableAllHooks: true })];
  return runLines('claude', args, {
    env,
    onStart: (send) => send({ type: 'control_request', request_id: 'mcbot-models', request: { subtype: 'initialize' } }),
    onLine: (msg) => {
      if (msg.type !== 'control_response') return undefined;
      const r = msg.response;
      if (r?.subtype === 'error') throw new Error(r.error || 'Claude CLI 返回错误');
      return claudeModelsFrom(r?.response ?? r);
    },
  });
}

export function codexModelsFrom(catalog) {
  return (catalog?.models ?? []).filter((m) => m?.slug && m.visibility !== 'hide').map((m) => ({
    value: String(m.slug),
    label: String(m.display_name || m.slug),
    desc: String(m.description || ''),
    efforts: (m.supported_reasoning_levels ?? []).map((l) => String(l.effort)).filter(Boolean),
    defaultEffort: m.default_reasoning_level || '',
  }));
}

async function codexModels(configDir) {
  const { cmd, a } = codexCommand();
  const args = [...a.slice(0, a.indexOf('app-server')), 'debug', 'models'];
  const env = { ...process.env, ...(configDir ? { CODEX_HOME: configDir } : {}) };
  return runLines(cmd, args, { env, onExit: (out, code) => {
    if (code !== 0) throw new Error(`codex debug models 退出码 ${code}`);
    return codexModelsFrom(JSON.parse(out));
  } });
}

const flat = (option) => (option?.options ?? []).flatMap((o) => Array.isArray(o.options) ? o.options : [o]);
// dsh 的思考档位 off/low/high/max，配置页只给 low、high、max（和驱动器的映射一致）
export function dshModelsFrom(configOptions) {
  const model = configOptions?.find((o) => o.id === 'model');
  const reasoning = configOptions?.find((o) => o.id === 'reasoning_effort');
  const efforts = flat(reasoning).map((o) => String(o.value)).filter((v) => ['low', 'high', 'max'].includes(v));
  const seen = new Set();
  return flat(model).filter((o) => o?.name && !seen.has(o.name) && seen.add(o.name)).map((o) => ({
    value: String(o.name), label: String(o.name), desc: String(o.description || ''), efforts,
  }));
}

async function dshModels(configDir) {
  const patchFile = writeDshPatch(path.join(ROOT, 'runtime', 'webui-dsh-probe.dsh-patch.yml'));
  const { cmd, a } = dshCommand({ root: ROOT, patchFile });
  const env = { ...process.env, DSH_HOME: configDir || process.env.DSH_HOME || path.join(ROOT, 'runtime', 'dsh', 'home'), ELECTRON_RUN_AS_NODE: '1' };
  return runLines(cmd, a, {
    env,
    onStart: (send) => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1,
      clientInfo: { name: 'mcbot_webui', version: '0.1.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } }),
    onLine: (msg, send) => {
      if (msg.id === 1) {
        if (msg.error) throw new Error(msg.error.message || 'dsh initialize 失败');
        send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: ROOT, mcpServers: [] } });
        return undefined;
      }
      if (msg.id === 2) {
        if (msg.error) throw new Error(msg.error.message || 'dsh session/new 失败');
        return dshModelsFrom(msg.result?.configOptions);
      }
      // dsh 发来的请求一律拒绝，免得它等
      if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } });
      return undefined;
    },
  });
}

const SOURCES = { claude: { label: 'Claude CLI', fetch: claudeModels }, codex: { label: 'Codex CLI', fetch: codexModels }, dsh: { label: 'dsh', fetch: dshModels } };

/** 带缓存的读取：同一个 Agent 和账号目录 1 小时内用缓存（refresh 时重读）；正在读的请求合并。 */
export function createModelCatalog({ runtime, fetchers = {}, ttlMs = 3600000 }) {
  const file = path.join(runtime, 'webui-models.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* 没有缓存 */ }
  const pending = new Map();
  const save = () => { try { fs.mkdirSync(runtime, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache, null, 1)); } catch { /* 缓存写不了不影响 */ } };
  return {
    async get(agent, configDir = '', refresh = false) {
      const source = SOURCES[agent];
      if (!source) return { ok: false, error: '不支持的 Agent' };
      const key = `${agent}|${configDir}`;
      const hit = cache[key];
      if (!refresh && hit && Date.now() - hit.fetchedAt < ttlMs) return { ok: true, source: source.label, cached: true, ...hit };
      if (!pending.has(key)) {
        pending.set(key, (fetchers[agent] || source.fetch)(configDir).then((models) => {
          cache[key] = { fetchedAt: Date.now(), models };
          save();
          return { ok: true, source: source.label, cached: false, ...cache[key] };
        }, (e) => ({ ok: false, source: source.label, error: e.message, ...(hit ? { stale: true, ...hit } : {}) })).finally(() => pending.delete(key)));
      }
      return pending.get(key);
    },
  };
}
