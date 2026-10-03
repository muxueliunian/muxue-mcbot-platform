#!/usr/bin/env node
// Explicit opt-in, real local CLI, simulated loopback model only. Not part of npm test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getAgentProtocol, claudeGameEnvironment } from './agents/process-protocols.mjs';

const SELF = fileURLToPath(import.meta.url);
const HOST_TOOLS = new Set(['Read', 'Edit', 'Write', 'Bash', 'PowerShell', 'Agent', 'Task', 'Glob', 'Grep', 'REPL', 'WebFetch']);
const GAME_TOOL = 'mcp__minecraft__get-status';
const allowedName = name => name === GAME_TOOL || name === 'EndConversation';
const flags = new Set(process.argv.slice(2));

function assertion(name, pass, tools) {
  console.log(JSON.stringify({ assertion: name, passed: Boolean(pass), ...(tools ? { tools } : {}) }));
  assert.ok(pass, name);
}

function fixture() {
  const log = process.env.MCBOT_PERMISSION_PROBE_AUDIT;
  const owner = process.env.MCBOT_PERMISSION_PROBE_OWNER;
  const root = process.env.MCBOT_PERMISSION_PROBE_ROOT;
  if (!root || !owner || !log || path.resolve(log) !== path.join(path.resolve(root), 'mcp-audit.jsonl') || !path.basename(root).startsWith('mcbot-claude-permissions-')) throw new Error('Invalid controlled fixture directory');
  const record = value => fs.appendFileSync(log, JSON.stringify({ owner, ...value }) + '\n');
  record({ type: 'start', pid: process.pid });
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.id === undefined) return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'minecraft-permission-fixture', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'get-status', description: 'Offline fixture status, no Minecraft connection.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
    else if (request.method === 'tools/call' && request.params.name === 'get-status') {
      record({ type: 'tool', name: 'get-status' });
      result = { content: [{ type: 'text', text: JSON.stringify({ connected: true, source: 'offline-permission-fixture' }) }] };
    } else if (request.method === 'resources/list') result = { resources: [] };
    else if (request.method === 'prompts/list') result = { prompts: [] };
    else if (request.method === 'ping') result = {};
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unavailable fixture method' } }) + '\n'); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  });
  input.on('close', () => { record({ type: 'close' }); process.exit(0); });
}

function cleanEnvironment(root, endpoint) {
  // Start from an OS launch allowlist; OAuth/API/provider/plugin/Node injection variables are not inherited.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)) env[key] = value;
  }
  const clean = claudeGameEnvironment({ ...env,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
    ANTHROPIC_API_KEY: 'sk-ant-api03-offline-permission-probe-fake-not-an-account-key',
    ANTHROPIC_BASE_URL: endpoint,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  });
  assert.equal(clean.ENABLE_TOOL_SEARCH, 'false');
  assert.ok(!Object.keys(clean).some(key => /OAUTH|AUTH_TOKEN|BEDROCK|VERTEX|FOUNDRY|AWS_|AZURE_|GOOGLE_|NODE_OPTIONS/i.test(key)));
  return clean;
}

function response(response, body, content, stopReason) {
  const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    send('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    send('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    send('content_block_stop', { index });
  }
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } });
  send('message_stop', {}); response.end();
}

async function probe() {
  if (!flags.has('--allow-local-cli')) {
    console.log('需要显式 --allow-local-cli；仅运行本机真实CLI与模拟API，不使用账号或真实模型。');
    process.exitCode = 2; return;
  }
  const legacy = flags.has('--inspect-legacy');
  const tmpParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tmpParent, 'mcbot-claude-permissions-'));
  const owner = randomUUID(), audit = path.join(root, 'mcp-audit.jsonl');
  const work = path.join(root, 'workspace'), config = path.join(root, 'mcp.json'), sentinel = path.join(work, 'sentinel.txt');
  fs.mkdirSync(work); fs.mkdirSync(path.join(root, 'claude-config'));
  const before = Buffer.concat([Buffer.from('MCBOT-PROBE-ORIGINAL\n'), Buffer.from([0, 1, 255, 128])]);
  fs.writeFileSync(sentinel, before);
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [SELF, '--mcp-fixture'], env: { MCBOT_PERMISSION_PROBE_ROOT: root, MCBOT_PERMISSION_PROBE_AUDIT: audit, MCBOT_PERMISSION_PROBE_OWNER: owner } } } }));
  let child, timer, server, unsafe = false, init;
  const messages = [], schemas = [], toolResults = new Map();
  const injected = [
    { type: 'tool_use', id: 'probe_write', name: 'Write', input: { file_path: sentinel, content: 'ATTACK_WRITE' } },
    { type: 'tool_use', id: 'probe_edit', name: 'Edit', input: { file_path: sentinel, old_string: 'MCBOT-PROBE-ORIGINAL', new_string: 'ATTACK_EDIT' } },
    { type: 'tool_use', id: 'probe_bash', name: 'Bash', input: { command: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ATTACK_BASH')`)}` } },
    { type: 'tool_use', id: 'probe_powershell', name: 'PowerShell', input: { command: `Set-Content -LiteralPath '${sentinel.replaceAll("'", "''")}' -Value 'ATTACK_POWERSHELL'` } },
    { type: 'tool_use', id: 'probe_game', name: GAME_TOOL, input: {} },
  ];
  try {
    server = http.createServer(async (request, res) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (pathname.endsWith('/messages/count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
      if (!pathname.endsWith('/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
      const names = (body.tools ?? []).map(tool => tool.name);
      schemas.push(names);
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'tool_result') toolResults.set(block.tool_use_id, { isError: block.is_error === true, text: JSON.stringify(block.content) });
      if (schemas.length === 1) {
        unsafe = names.some(name => !allowedName(name));
        // Never inject executable/write requests into the old command or an unexpectedly exposed schema.
        if (!legacy && !unsafe && names.includes(GAME_TOOL)) response(res, body, injected, 'tool_use');
        else response(res, body, [{ type: 'text', text: 'Tool inventory inspection complete.' }], 'end_turn');
      } else response(res, body, [{ type: 'text', text: 'Offline permission probe complete.' }], 'end_turn');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const env = cleanEnvironment(root, endpoint);
    const command = getAgentProtocol('claude').command({ body: legacy ? 'mineflayer' : 'server', hostedConfigFile: config, model: 'claude-sonnet-4-6', effort: 'low' });
    child = spawn(command.cmd, command.a, { cwd: work, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume(); // Never print full diagnostic buffers or prompts.
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', line => {
      try {
        const value = JSON.parse(line); messages.push(value);
        if (value.type === 'system' && value.subtype === 'init') init = value;
      } catch {}
    });
    const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    timer = setTimeout(() => { child.kill(); }, 60000);
    child.stdin.end(JSON.stringify(getAgentProtocol('claude').encodeTurn('Execute the mock tool requests, then finish the offline probe.')) + '\n');
    const code = await finished; clearTimeout(timer);
    assertion('真实CLI完成本机模拟会话', code === 0 && !!init && schemas.length > 0);
    assertion('临时哨兵实际字节未改变', fs.readFileSync(sentinel).equals(before));
    const initNames = init.tools ?? [];
    console.log(JSON.stringify({ tools: { init: initNames, api: schemas } }));
    if (legacy) {
      assertion('旧命令只做清单检查，未注入宿主写入／命令调用', !messages.some(message => message.type === 'assistant' && message.message?.content?.some(block => block.type === 'tool_use')));
      assertion('旧命令暴露宿主工具的red证据', [...initNames, ...schemas.flat()].some(name => HOST_TOOLS.has(name)));
      return;
    }
    assertion('实际init只包含minecraft工具及可保留的EndConversation', initNames.includes(GAME_TOOL) && initNames.every(allowedName), initNames);
    assertion('所有模型API工具schema只包含minecraft及EndConversation', !unsafe && schemas.every(names => names.includes(GAME_TOOL) && names.every(allowedName)), schemas.flat());
    for (const tool of injected.slice(0, 4)) {
      const result = toolResults.get(tool.id);
      assertion(`模拟模型强行调用${tool.name}被真实CLI拒绝`, !!result && result.isError && /tool|unavailable|not|unknown|error/i.test(result.text));
    }
    const fixtureRecords = fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse) : [];
    assertion('正常minecraft/get-status实际经MCP执行', fixtureRecords.some(record => record.owner === owner && record.type === 'tool' && record.name === 'get-status') && toolResults.get('probe_game')?.isError === false);
    assertion('拒绝后哨兵仍逐字节一致', fs.readFileSync(sentinel).equals(before));
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill();
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    const owned = fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(record => record.owner === owner && record.type === 'start') : [];
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
    // Only inspect fixture PIDs from our nonce-bound audit; never enumerate or kill user Claude sessions.
    for (let i = 0; i < 30 && owned.some(record => alive(record.pid)); i++) await new Promise(resolve => setTimeout(resolve, 50));
    const fixturesStopped = owned.every(record => !alive(record.pid));
    // Only the exact mkdtemp-owned directory may be removed; no user/account/workspace paths.
    assert.equal(fs.realpathSync(root), root);
    assert.equal(path.dirname(root), tmpParent);
    assert.ok(path.basename(root).startsWith('mcbot-claude-permissions-'));
    fs.rmSync(root, { recursive: true, force: true });
    assertion('自身临时MCP夹具已退出且临时目录已清理', fixturesStopped && !fs.existsSync(root));
  }
}

if (flags.has('--mcp-fixture')) fixture();
else await probe().catch(() => { console.error(JSON.stringify({ assertion: '离线真实CLI权限探针完成', passed: false, limitation: '检查未通过；未打印凭据、完整提示词或CLI诊断。' })); process.exitCode = 1; });
