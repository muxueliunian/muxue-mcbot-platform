import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { summarizeOperation } from '../dist/model-view.js';
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
  await c.callTool({ name: 'machine-items', arguments: { x: 1, y: 64, z: 2, mode: 'extract', slot: 2, expectedBlock: 'examplemod:mill' } });
  assert.deepEqual(acts().map(act => [act.name, act.args]), [
    ['machine-items', { x: 1, y: 64, z: 2, mode: 'list', side: 'up' }],
    ['send-chat', { message: '放矿' }],
    ['machine-items', { x: 1, y: 64, z: 2, mode: 'insert', item: 'examplemod:ore', count: 8 }],
    ['machine-items', { x: 1, y: 64, z: 2, mode: 'extract', slot: 2, expectedBlock: 'examplemod:mill' }],
  ]);
  await assert.rejects(body.act('machine-items', { x: 1, y: 64, z: 2, mode: 'insert', item: 'examplemod:ore' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('machine-items', { x: 1, y: 64, z: 2, mode: 'extract' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('machine-items', { x: 1, y: 64, z: 2, mode: 'list', side: 'top' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 4);
});

test('the read-only machine-status capability survives the hello filter', async t => {
  const { body } = await setup(t, { capabilities: ['machine-items', 'machine-status'] });
  assert.ok(body.hello.capabilities.includes('machine-status'));
  assert.equal(typeof body.machineStatus, 'function');
});

test('the model sees the slots, sides and contents after a move, not only the counts', () => {
  const slots = [{ slot: 0, item: 'examplemod:ore', count: 3, limit: 64 }, { slot: 1, item: null, count: 0, limit: 64 }];
  const listed = summarizeOperation({ operationId: 'o1', name: 'machine-items', status: 'succeeded', summary: 'read', result: { block: { id: 'examplemod:mill' }, side: null, size: 2, sides: [{ side: null, slots: 2 }, { side: 'up', slots: 1 }], slots } });
  assert.deepEqual(listed.result.slots, slots);
  assert.deepEqual(listed.result.sides, [{ side: null, slots: 2 }, { side: 'up', slots: 1 }]);
  const moved = summarizeOperation({ operationId: 'o2', name: 'machine-items', status: 'failed', summary: 'only 1', result: { moved: 1, code: 'PARTIAL', slots: [{ slot: 0, count: 1 }], after: slots } });
  assert.equal(moved.result.code, 'PARTIAL');
  assert.deepEqual(moved.result.after, slots);
});
