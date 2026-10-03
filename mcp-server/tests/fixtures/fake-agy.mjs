// 独立模拟现有 agy 流协议，核验驱动器不会误发 Claude 消息格式。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';

const record = data => fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ pid: process.pid, ...data }) + '\n');
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
record({ kind: 'start', argv: process.argv.slice(2) });
const resumeAt = process.argv.indexOf('--conversation');
const sessionId = resumeAt >= 0 ? process.argv[resumeAt + 1] : `fake-agy-${process.pid}`;
emit({ event: 'init', conversation_id: sessionId });
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  assert.equal(message.event, 'user');
  assert.equal(message.type, undefined);
  assert.equal(message.message.role, undefined);
  record({ kind: 'turn', text: message.message.content });
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: '收到' } });
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: '了' } });
  emit({ event: 'result', result: { status: 'SUCCESS', usage: { total_tokens: 32 } } });
});
input.on('close', () => process.exit(0));
