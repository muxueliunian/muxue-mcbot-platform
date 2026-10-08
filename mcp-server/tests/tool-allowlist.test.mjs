// 工具允许名单与 client-runtime 实际注册的工具保持一致：新增服务器端工具忘了加白名单时这里会失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_SERVER_TOOLS } from '../../scripts/agents/codex-app-server.mjs';
import { isGameTool, gameToolName } from '../../scripts/agents/dsh-acp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(ROOT, 'client-runtime/src/mcp.ts'), 'utf8');

// register('name', ...) 与批量任务表里的 { name: 'xxx', description: ... } 都是对外工具。
export const registeredTools = [...new Set([
  ...[...source.matchAll(/register\('([a-z][a-z0-9-]*)'/g)].map(m => m[1]),
  ...[...source.matchAll(/\{ name: '([a-z][a-z0-9-]*)'(?: as const)?, (?:description|schema):/g)].map(m => m[1]),
])];

// 刻意不给 Codex 的服务器端工具：目前没有。要排除就写在这里并注明原因。
const CODEX_EXCLUDED = new Map([]);

test('mcp.ts 能提取到足够多的工具名（防止正则失效后测试空转）', () => {
  assert.ok(registeredTools.length >= 55, `只提取到 ${registeredTools.length} 个`);
  for (const name of ['emote', 'equip-item', 'use-item', 'interact-block', 'send-chat', 'fetch-and-give']) assert.ok(registeredTools.includes(name), name);
});

test('Codex 服务器端白名单覆盖 mcp.ts 注册的全部游戏工具', () => {
  const allowed = new Set(CODEX_SERVER_TOOLS);
  const missing = registeredTools.filter(name => !allowed.has(name) && !CODEX_EXCLUDED.has(name));
  assert.deepEqual(missing, [], `Codex 白名单缺少：${missing.join(', ')}`);
  for (const name of CODEX_EXCLUDED.keys()) assert.ok(registeredTools.includes(name), `排除列表里的 ${name} 已不存在`);
});

test('Codex 服务器端白名单没有重复项，也没有 mcp.ts 里不存在的工具', () => {
  assert.equal(new Set(CODEX_SERVER_TOOLS).size, CODEX_SERVER_TOOLS.length);
  const known = new Set(registeredTools);
  assert.deepEqual(CODEX_SERVER_TOOLS.filter(name => !known.has(name)), []);
});

test('dsh 与 Claude 按 MCP 服务器前缀整体放行，不维护逐个工具名单', () => {
  // dsh：只看 mcp__<server>__ 前缀，新工具自动可用；Claude：--allowedTools mcp__minecraft。
  for (const name of registeredTools) {
    assert.equal(isGameTool(`mcp__minecraft__${name}`), true, name);
  }
  assert.equal(isGameTool('Read'), false);
  assert.equal(gameToolName('mcp__minecraft__emote'), 'emote');
  const protocols = fs.readFileSync(path.join(ROOT, 'scripts/agents/process-protocols.mjs'), 'utf8');
  assert.match(protocols, /'--allowedTools', 'mcp__minecraft'/);
});