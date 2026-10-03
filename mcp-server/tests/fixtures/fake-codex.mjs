// Codex app-server stdio 的离线替身。只模拟 RPC，不启动 MCP 或连接模型／游戏。
// FAKE_AGENT_LOG 记录收到的请求；FAKE_CODEX_CONTROL 用 JSONL 注入指定轮次的完成通知。
import fs from 'node:fs';
import readline from 'node:readline';

const logFile = process.env.FAKE_AGENT_LOG;
const controlFile = process.env.FAKE_CODEX_CONTROL;
const record = (value) => fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...value }) + '\n');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => emit({ id, result });
const notify = (method, params) => emit({ method, params });
let initialized = false;
let threadId = '';
let activeTurn = null;
let following = false;
let stopCalls = 0;
let nextTurn = 0;
let controlOffset = 0;

record({ kind: 'start', argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME });

function finish(turnId, selectedThreadId = threadId, status = 'completed') {
  record({ kind: 'completed', threadId: selectedThreadId, turnId, status });
  if (activeTurn?.id === turnId && selectedThreadId === threadId) activeTurn = null;
  notify('turn/completed', {
    threadId: selectedThreadId,
    turn: { id: turnId, status, items: [], error: status === 'failed' ? { message: 'fake turn failed', codexErrorInfo: 'other', additionalDetails: null } : null },
  });
}

const controls = setInterval(() => {
  if (!controlFile || !fs.existsSync(controlFile)) return;
  const lines = fs.readFileSync(controlFile, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(controlOffset)) {
    controlOffset += 1;
    const control = JSON.parse(line);
    if (control.action === 'complete') finish(control.turnId ?? activeTurn?.id, control.threadId ?? threadId, control.status ?? 'completed');
  }
}, 40);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  record({ kind: 'request', ...request });
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    setTimeout(() => reply(id, { userAgent: 'fake-codex/1', platformFamily: 'windows', platformOs: 'windows' }), Number(process.env.FAKE_CODEX_INIT_DELAY_MS) || 0);
    return;
  }
  if (method === 'initialized') {
    initialized = true;
    return;
  }
  if (!initialized) {
    record({ kind: 'violation', text: `${method} before initialized` });
    emit({ id, error: { code: -32002, message: 'not initialized' } });
    return;
  }
  if (method === 'account/read') {
    reply(id, { account: { type: 'chatgpt', email: 'fake@example.invalid', planType: 'pro' }, requiresOpenaiAuth: false });
    return;
  }
  if (method === 'config/read') {
    reply(id, { config: { mcp_servers: { inherited: { command: 'never-run', enabled: true } } }, origins: {}, layers: null });
    return;
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    threadId = params.threadId ?? `fake-codex-${process.pid}`;
    const thread = { id: threadId, turns: [], status: { type: 'idle' }, preview: '', ephemeral: false, modelProvider: 'openai', cwd: params.cwd, createdAt: 1, updatedAt: 1 };
    reply(id, { thread, model: 'fake-model', modelProvider: 'openai', cwd: params.cwd, approvalPolicy: 'never', sandbox: { type: 'readOnly' }, reasoningEffort: 'low' });
    notify('thread/started', { thread });
    return;
  }
  if (method === 'mcpServer/tool/call') {
    if (params.threadId !== threadId || params.server !== 'minecraft'
      || !['stop-action', 'send-chat'].includes(params.tool)
      || !params.arguments || typeof params.arguments !== 'object'
      || (params.tool === 'send-chat' && typeof params.arguments.message !== 'string')) {
      record({ kind: 'violation', text: 'invalid host MCP tool call' });
      emit({ id, error: { code: -32602, message: 'invalid host MCP tool call' } });
      return;
    }
    if (params.tool === 'stop-action') {
      stopCalls += 1;
      if (stopCalls === Number(process.env.FAKE_CODEX_STOP_ERROR_CALL)) {
        record({ kind: 'host_tool_error', threadId, tool: params.tool, following });
        reply(id, { content: [{ type: 'text', text: 'fake stop-action failed' }], isError: true });
        return;
      }
      following = false;
    }
    record({ kind: 'host_tool', threadId, tool: params.tool, arguments: params.arguments, following });
    reply(id, { content: [{ type: 'text', text: params.tool === 'stop-action' ? '已停止所有动作' : '消息已发送' }], isError: false });
    return;
  }
  if (method === 'turn/start') {
    const text = (params.input ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    const turnId = `turn-${process.pid}-${++nextTurn}`;
    record({ kind: 'turn', threadId: params.threadId, turnId, text });
    if (params.threadId !== threadId || activeTurn) {
      record({ kind: 'violation', text: activeTurn ? 'overlapping turns' : 'wrong thread' });
      emit({ id, error: { code: -32000, message: 'invalid turn start' } });
      return;
    }
    if (text.includes('[rpc-error]')) {
      emit({ id, error: { code: -32000, message: 'fake turn RPC failed' } });
      return;
    }
    activeTurn = { id: turnId, status: 'inProgress', items: [], error: null };
    reply(id, { turn: activeTurn });
    notify('turn/started', { threadId, turn: activeTurn });
    if (text.includes('[crash-once]') && !fs.existsSync(`${logFile}.crashed`)) {
      fs.writeFileSync(`${logFile}.crashed`, 'accepted');
      record({ kind: 'crash', turnId, text });
      process.exit(17);
    }
    if (text.includes('[hold]')) return;
    if (text.includes('[follow]')) {
      following = true;
      record({ kind: 'following', threadId, turnId, following });
    }
    if (text.includes('[fail]')) {
      finish(turnId, threadId, 'failed');
      return;
    }
    notify('item/agentMessage/delta', { threadId, turnId, itemId: `message-${turnId}`, delta: '收到' });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: `message-${turnId}`, delta: '了' });
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `message-${turnId}`, text: '收到了', phase: 'final_answer' } });
    finish(turnId);
    return;
  }
  if (method === 'turn/interrupt') {
    reply(id, {});
    if (process.env.FAKE_CODEX_MANUAL_INTERRUPT !== '1') finish(params.turnId, params.threadId, 'interrupted');
    return;
  }
  if (id !== undefined) emit({ id, error: { code: -32601, message: `unknown method ${method}` } });
});

rl.on('close', () => {
  record({ kind: 'stdin_closed' });
  clearInterval(controls);
  process.exit(0);
});
