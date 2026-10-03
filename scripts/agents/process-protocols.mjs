// 现有常驻 CLI 的协议适配。只做命令/消息转换，不持有进程、游戏状态或记忆。
// 这是 AgentAdapter 的第一块：完整的连接、取消与工具配置接口随后由真实接入推动。
// decodeMessage 返回有序事件：session、request_started、request_completed、usage、text、tool、completed。
// completed 只表示 Agent 本轮结束，不表示其中每个游戏动作成功。
import { codexCommand, createCodexConnection } from './codex-app-server.mjs';

export function claudeContextTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
}

// With no built-in tools, load Minecraft's schemas directly instead of requiring
// ToolSearch. Account selection stays with the host; this does not change auth.
export function claudeGameEnvironment(env) {
  return { ...env, ENABLE_TOOL_SEARCH: 'false' };
}

const claude = Object.freeze({
  provider: 'claude-code',
  tracksContextTokens: true,
  command({ hostedConfigFile, model, effort, conversationId, body, gameInstructions }) {
    const gameOnly = body === 'server';
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', hostedConfigFile, '--strict-mcp-config',
      '--permission-mode', gameOnly ? 'dontAsk' : 'acceptEdits', '--permission-prompts', 'none'];
    if (gameOnly) {
      // allowedTools only controls automatic approval. --tools removes the
      // built-ins themselves, including Read/Edit/Write, shells and subagents.
      // Restricted mode also excludes inherited local settings/code tools.
      a.push('--tools', '', '--restricted', '--disable-slash-commands',
        '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }));
      if (gameInstructions) a.push('--append-system-prompt', gameInstructions);
    }
    if (effort) a.push('--effort', effort);
    if (model) a.push('--model', model);
    if (conversationId) a.push('--resume', conversationId);
    // 可变长度参数保持在最后，避免吞掉后续选项。
    a.push('--allowedTools', 'mcp__minecraft', ...(gameOnly ? [] : ['Read', 'Edit', 'Write', 'Glob', 'Grep']));
    return { cmd: 'claude', a };
  },
  encodeTurn(text) {
    return { type: 'user', message: { role: 'user', content: text } };
  },
  decodeMessage(msg) {
    if (msg?.type === 'system' && msg.subtype === 'init') {
      return [{ type: 'session', id: msg.session_id }];
    }
    if (msg?.type === 'user') return [{ type: 'request_started' }];
    if (msg?.type === 'assistant') {
      const events = [];
      const contextTokens = claudeContextTokens(msg.message?.usage);
      if (contextTokens) events.push({ type: 'usage', contextTokens }, { type: 'request_completed' });
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text') events.push({ type: 'text', text: block.text, done: true });
        else if (block.type === 'tool_use') events.push({
          type: 'tool', name: String(block.name).replace(/^mcp__minecraft__/, ''), input: block.input ?? {},
        });
      }
      return events;
    }
    if (msg?.type === 'result') return [{
      type: 'completed',
      error: msg.is_error ? String(msg.result || msg.subtype || '未知错误') : '',
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
    }];
    return [];
  },
});

const antigravity = Object.freeze({
  // 保留旧 provider 标识，避免已有会话状态被不必要地作废。
  provider: 'agy',
  tracksContextTokens: false,
  command({ root, model, effort, conversationId }) {
    const a = ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--dangerously-skip-permissions', '--print-timeout', '720h', '--add-dir', root];
    if (effort) a.push('--effort', effort);
    if (model) a.push('--model', model);
    if (conversationId) a.push('--conversation', conversationId);
    a.push('-p=');
    return { cmd: 'agy', a };
  },
  encodeTurn(text) {
    return { event: 'user', message: { content: text } };
  },
  decodeMessage(msg) {
    if (msg?.event === 'init') return [{ type: 'session', id: msg.conversation_id }];
    if (msg?.event === 'step_update') {
      const step = msg.step_update;
      if (step?.step_type === 'agent_response') return [{
        type: 'text', text: step.text_delta, done: step.state === 'DONE',
      }];
      if (step?.step_type === 'tool' && step.state === 'ACTIVE') {
        const params = step.tool_info?.parameters ?? {};
        return [{ type: 'tool', name: params.ToolName || step.tool_name,
          input: params.ToolName ? params.Arguments ?? {} : params }];
      }
    }
    if (msg?.event === 'result' && msg.result) {
      const result = msg.result;
      const events = result.status === 'SUCCESS' ? [{ type: 'request_completed' }] : [];
      // totalTokens 是整轮计数，不冒充最近一次请求的上下文大小。
      events.push({ type: 'completed', error: result.status === 'SUCCESS' ? '' : String(result.error || result.status || '未知错误'),
        totalTokens: result.usage?.total_tokens });
      return events;
    }
    return [];
  },
});

const codex = Object.freeze({
  provider: 'codex', tracksContextTokens: true,
  defaultEffort: 'low',
  command: () => codexCommand(),
  createConnection: createCodexConnection,
});

const protocols = new Map([['claude', claude], ['gemini', antigravity], ['codex', codex]]);

export function getAgentProtocol(name) {
  const protocol = protocols.get(name);
  if (!protocol) throw new Error(`尚未实现 Agent 协议：${name}（当前可用：${[...protocols.keys()].join(', ')}）`);
  return protocol;
}
