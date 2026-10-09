import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

// 8b：模组机器的通用物品槽适配。工具只在服务端支持且服主开了至少一个 Mod 时出现，参数原样转给服务端。
async function setup(t, { capabilities = ['machine-items'], itemHandlerMods = ['examplemod'] } = {}) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities], ...(itemHandlerMods ? { itemHandlerMods } : {}) });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { body, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
async function client(t, body) {
  const server = createMcpServer(body, new EventJournal());
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'machine-items-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return c;
}
const names = async c => (await c.listTools()).tools.map(tool => tool.name);

test('machine-items is published only when the server supports it and some mod is enabled, naming the mods', async t => {
  const { body } = await setup(t);
  const c = await client(t, body);
  const tool = (await c.listTools()).tools.find(entry => entry.name === 'machine-items');
  assert.ok(tool, 'published');
  assert.match(tool.description, /examplemod/);
  const { body: none } = await setup(t, { itemHandlerMods: [] });
  assert.ok(!(await names(await client(t, none))).includes('machine-items'), 'no enabled mod, no tool');
  const { body: old } = await setup(t, { capabilities: [], itemHandlerMods: undefined });
  assert.ok(!(await names(await client(t, old))).includes('machine-items'), 'an older server without the action');
});

test('machine-items forwards its arguments; incomplete insert or extract never reaches the server', async t => {
  const { body, acts } = await setup(t);
  const c = await client(t, body);
  await c.callTool({ name: 'machine-items', arguments: { x: 1, y: 64, z: 2, mode: 'list', side: 'up' } });
  await c.callTool({ name: 'machine-items', arguments: { x: 1, y: 64, z: 2, mode: 'insert', item: 'examplemod:ore', count: 8, say: '放矿' } });
  await c.callTool({ name: 'machine-items', arguments: { x: 1, y: 64, z: 2, mode: 'extract', slot: 2 } });
  assert.deepEqual(acts().map(act => [act.name, act.args]), [
    ['machine-items', { x: 1, y: 64, z: 2, mode: 'list', side: 'up' }],
    ['send-chat', { message: '放矿' }],
    ['machine-items', { x: 1, y: 64, z: 2, mode: 'insert', item: 'examplemod:ore', count: 8 }],
    ['machine-items', { x: 1, y: 64, z: 2, mode: 'extract', slot: 2 }],
  ]);
  await assert.rejects(body.act('machine-items', { x: 1, y: 64, z: 2, mode: 'insert', item: 'examplemod:ore' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('machine-items', { x: 1, y: 64, z: 2, mode: 'extract' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('machine-items', { x: 1, y: 64, z: 2, mode: 'list', side: 'top' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 4);
});
