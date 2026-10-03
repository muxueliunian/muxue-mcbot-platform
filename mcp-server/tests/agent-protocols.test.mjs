import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAgentProtocol } from '../../scripts/agents/process-protocols.mjs';

test('未知 Agent 不会静默使用 Claude 协议，既有会话 provider 标识保留', () => {
  assert.throws(() => getAgentProtocol('unknown-agent'), /尚未实现/);
  assert.equal(getAgentProtocol('claude').provider, 'claude-code');
  assert.equal(getAgentProtocol('gemini').provider, 'agy');
});

test('恢复会话和带空格配置作为独立参数传递，Claude 可变参数保持最后', () => {
  const config = { root: 'G:/test root', hostedConfigFile: 'G:/test root/mcp.json',
    model: 'chosen-model', effort: 'high', conversationId: 'saved-session' };
  const claude = getAgentProtocol('claude').command(config);
  const agy = getAgentProtocol('gemini').command(config);
  assert.equal(claude.a[claude.a.indexOf('--mcp-config') + 1], config.hostedConfigFile);
  assert.equal(claude.a[claude.a.indexOf('--resume') + 1], config.conversationId);
  assert.equal(claude.a.at(-7), '--allowedTools');
  assert.equal(agy.a[agy.a.indexOf('--conversation') + 1], config.conversationId);
  assert.equal(agy.a[agy.a.indexOf('--add-dir') + 1], config.root);
  assert.equal(agy.a.at(-1), '-p=');
  assert.ok(!agy.a.includes('--resume'));
  assert.ok(!claude.a.includes('--conversation'));
});

test('Claude 工具结果启动新请求，输出与工具活动不能提前结束回合', () => {
  const adapter = getAgentProtocol('claude');
  assert.deepEqual(adapter.decodeMessage({ type: 'user', message: { content: [] } }), [{ type: 'request_started' }]);
  const events = adapter.decodeMessage({ type: 'assistant', message: {
    usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 3, output_tokens: 4 },
    content: [{ type: 'text', text: '我去看看' },
      { type: 'tool_use', name: 'mcp__minecraft__get-status', input: {} }],
  } });
  assert.deepEqual(events.map(e => e.type), ['usage', 'request_completed', 'text', 'tool']);
  assert.equal(events[0].contextTokens, 109);
  assert.equal(events.at(-1).name, 'get-status');
  assert.deepEqual(adapter.decodeMessage({ type: 'result', is_error: true, result: 'quota exceeded' }),
    [{ type: 'completed', error: 'quota exceeded', costUsd: undefined }]);
});

test('agy 文本分片保留结束标志，MCP 封装后的工具参数归一化', () => {
  const adapter = getAgentProtocol('gemini');
  const active = adapter.decodeMessage({ event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: '我在', state: 'ACTIVE',
  } });
  const done = adapter.decodeMessage({ event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: '这里', state: 'DONE',
  } });
  assert.deepEqual(active, [{ type: 'text', text: '我在', done: false }]);
  assert.deepEqual(done, [{ type: 'text', text: '这里', done: true }]);
  assert.deepEqual(adapter.decodeMessage({ event: 'step_update', step_update: {
    step_type: 'tool', state: 'ACTIVE', tool_name: 'mcp_wrapper',
    tool_info: { parameters: { ToolName: 'send-chat', Arguments: { message: '你好' } } },
  } }), [{ type: 'tool', name: 'send-chat', input: { message: '你好' } }]);
});

test('agy 失败不刷新成功请求时间，整轮 token 不作为上下文大小', () => {
  const adapter = getAgentProtocol('gemini');
  const failure = adapter.decodeMessage({ event: 'result', result: {
    status: 'ERROR', error: 'unauthorized', usage: { total_tokens: 250000 },
  } });
  assert.deepEqual(failure, [{ type: 'completed', error: 'unauthorized', totalTokens: 250000 }]);
  assert.equal(adapter.tracksContextTokens, false);
  assert.deepEqual(adapter.decodeMessage({ event: 'result', result: { status: 'SUCCESS' } }), [
    { type: 'request_completed' }, { type: 'completed', error: '', totalTokens: undefined },
  ]);
  assert.deepEqual(adapter.decodeMessage({ event: 'future-notification' }), []);
});
