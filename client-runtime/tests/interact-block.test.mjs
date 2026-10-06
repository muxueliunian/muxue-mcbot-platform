import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { interactBlock } from '../dist/interactions.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

const seeds = { slot: 2, id: 'minecraft:wheat_seeds', count: 5, components: {}, maxStackSize: 64 };
const stored = { slot: 12, id: 'minecraft:bone_meal', count: 3, components: {}, maxStackSize: 64 };
const composter = { position: { x: 1, y: 64, z: 0 }, state: 'loaded', id: 'minecraft:composter', properties: { level: '2' } };

async function setup(t, { interactions = ['minecraft:composter/add'], capabilities = ['use-item-on-block'], inventory = [seeds, stored] } = {}) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities], interactions });
  const observe = mock.handlers.observe;
  mock.handlers.observe = params => ({ ...observe(params), ...(params.block ? { block: composter } : {}) });
  mock.setState({ selectedSlot: 0, inventory });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { body, mock, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
async function client(t, body) {
  const server = createMcpServer(body, new EventJournal());
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'interact-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return c;
}
const call = async (c, args) => JSON.parse((await c.callTool({ name: 'interact-block', arguments: args })).content[0].text);

test('interact-block is published only with the capability and registered interaction IDs', async t => {
  const { body } = await setup(t);
  const tools = (await (await client(t, body)).listTools()).tools;
  const tool = tools.find(item => item.name === 'interact-block');
  assert.ok(tool && tool.description.includes('minecraft:composter/add'));
  assert.ok(!tools.some(item => item.name === 'use-item-on-block' || item.name === 'use-item'), 'raw interaction actions are not model tools');
  assert.deepEqual(body.hello.interactions, ['minecraft:composter/add']);
});

test('without registered interactions the capability is dropped and no tool is published', async t => {
  const { body } = await setup(t, { interactions: [] });
  assert.ok(!body.hello.capabilities.includes('use-item-on-block'));
  const tools = (await (await client(t, body)).listTools()).tools.map(item => item.name);
  assert.ok(!tools.includes('interact-block'));
});

test('interact-block guards the observed block and the hotbar stack, never asking the model for slots', async t => {
  const { body, acts } = await setup(t);
  const result = await call(await client(t, body), { x: 1, y: 64, z: 0, interaction: 'minecraft:composter/add', item: 'minecraft:wheat_seeds' });
  assert.equal(result.status, 'succeeded');
  const [act] = acts();
  assert.equal(act.name, 'use-item-on-block');
  assert.deepEqual(act.args, { x: 1, y: 64, z: 0, interaction: 'minecraft:composter/add', expectedBlock: 'minecraft:composter', expectedProperties: { level: '2' },
    slot: 2, expectedItem: 'minecraft:wheat_seeds', expectedCount: 5, expectedComponents: {} });
});

test('items outside the hotbar, missing items and ambiguous hands are refused before any act', async t => {
  const { body, acts } = await setup(t);
  const c = await client(t, body);
  assert.equal((await call(c, { x: 1, y: 64, z: 0, interaction: 'minecraft:composter/add', item: 'minecraft:bone_meal' })).code, 'NOT_IN_HOTBAR');
  assert.equal((await call(c, { x: 1, y: 64, z: 0, interaction: 'minecraft:composter/add', item: 'minecraft:apple' })).code, 'MISSING_ITEM');
  assert.equal((await call(c, { x: 1, y: 64, z: 0, interaction: 'minecraft:composter/add' })).code, 'INVALID_ARGUMENT');
  assert.equal((await call(c, { x: 1, y: 64, z: 0, interaction: 'minecraft:composter/add', item: 'minecraft:wheat_seeds', emptyHand: true })).code, 'INVALID_ARGUMENT');
  assert.equal(acts().length, 0);
});

test('ServerBody rejects unregistered interaction IDs and malformed guards locally', async t => {
  const { body, acts } = await setup(t);
  await assert.rejects(interactBlock(body, { x: 1, y: 64, z: 0, interaction: 'example:pot/add', item: 'minecraft:wheat_seeds' }), { code: 'UNSUPPORTED' });
  const guards = { x: 1, y: 64, z: 0, expectedBlock: 'minecraft:composter', expectedProperties: { level: '2' } };
  await assert.rejects(body.act('use-item-on-block', { ...guards, interaction: 'example:pot/add', slot: 2, expectedItem: 'minecraft:wheat_seeds', expectedCount: 5, expectedComponents: {} }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('use-item-on-block', { ...guards, interaction: 'minecraft:composter/add', emptyHand: true, slot: 2 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('use-item-on-block', { ...guards, interaction: 'minecraft:composter/add', slot: 2, expectedItem: 'minecraft:wheat_seeds', expectedCount: 0, expectedComponents: {} }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('use-item', { interaction: 'minecraft:composter/add', slot: 2, expectedItem: 'minecraft:wheat_seeds', expectedCount: 5, expectedComponents: {} }), { code: 'UNSUPPORTED' }, 'use-item is not advertised without item interactions');
  assert.equal(acts().length, 0);
});

test('empty-hand requests are forwarded without a slot for the server to choose and verify', async t => {
  const { body, acts } = await setup(t, { interactions: ['minecraft:composter/add', 'example:pot/remove'] });
  await interactBlock(body, { x: 1, y: 64, z: 0, interaction: 'example:pot/remove', emptyHand: true });
  const [act] = acts();
  assert.equal(act.args.emptyHand, true); assert.ok(!('slot' in act.args));
});
