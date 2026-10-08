import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

const backpack = { slot: 3, id: 'sophisticatedbackpacks:backpack', count: 1, components: { 'sophisticatedcore:storage_uuid': 'u' }, maxStackSize: 1 };
const spare = { slot: 20, id: 'sophisticatedbackpacks:iron_backpack', count: 1, components: {}, maxStackSize: 1 };
const OPEN = 'sophisticatedbackpacks:backpack/open';

async function setup(t, { interactions = ['minecraft:composter/add', OPEN], itemInteractions = [OPEN], capabilities = ['use-item-on-block', 'use-item'], inventory = [backpack, spare] } = {}) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities], interactions, itemInteractions });
  mock.setState({ selectedSlot: 0, inventory });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const server = createMcpServer(body, new EventJournal());
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'use-item-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return { body, c, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
const call = async (c, args) => (await c.callTool({ name: 'use-item', arguments: args })).content[0].text;

test('use-item lists only in-air interactions and interact-block only block ones', async t => {
  const { c } = await setup(t);
  const tools = (await c.listTools()).tools;
  const use = tools.find(item => item.name === 'use-item'), block = tools.find(item => item.name === 'interact-block');
  assert.ok(use && use.description.includes(OPEN) && !use.description.includes('composter'));
  assert.ok(block && block.description.includes('minecraft:composter/add') && !block.description.includes(OPEN));
});

test('without in-air interactions no use-item tool is published', async t => {
  const { c } = await setup(t, { interactions: ['minecraft:composter/add'], itemInteractions: [], capabilities: ['use-item-on-block'] });
  assert.ok(!(await c.listTools()).tools.some(item => item.name === 'use-item'));
});

test('use-item guards the observed hotbar stack', async t => {
  const { c, acts } = await setup(t);
  const result = JSON.parse(await call(c, { interaction: OPEN, item: 'sophisticatedbackpacks:backpack' }));
  assert.equal(result.status, 'succeeded');
  const [act] = acts();
  assert.equal(act.name, 'use-item');
  assert.deepEqual(act.args, { interaction: OPEN, slot: 3, expectedItem: 'sophisticatedbackpacks:backpack', expectedCount: 1, expectedComponents: { 'sophisticatedcore:storage_uuid': 'u' } });
});

test('use-item refuses items outside the hotbar or missing before any act', async t => {
  const { c, acts } = await setup(t);
  assert.match(await call(c, { interaction: OPEN, item: 'sophisticatedbackpacks:iron_backpack' }), /NOT_IN_HOTBAR/);
  assert.match(await call(c, { interaction: OPEN, item: 'sophisticatedbackpacks:gold_backpack' }), /MISSING_ITEM/);
  assert.equal(acts().length, 0);
});

const chestplate = { slot: 4, id: 'minecraft:netherite_chestplate', count: 1, components: { 'minecraft:damage': 3 }, maxStackSize: 1 };
const worn = { slot: 38, id: 'minecraft:iron_chestplate', count: 1, components: {}, maxStackSize: 1 };
const equip = async (c, args) => (await c.callTool({ name: 'equip-item', arguments: args })).content[0].text;

test('equip-item is published with its capability and guards the observed inventory stack', async t => {
  const { c, acts } = await setup(t, { capabilities: ['equip-item'], inventory: [chestplate, worn] });
  assert.ok((await c.listTools()).tools.some(item => item.name === 'equip-item'));
  assert.equal(JSON.parse(await equip(c, { item: 'minecraft:netherite_chestplate' })).status, 'succeeded');
  assert.deepEqual(acts()[0], { ...acts()[0], name: 'equip-item', args: { slot: 4, expectedItem: 'minecraft:netherite_chestplate', expectedCount: 1, expectedComponents: { 'minecraft:damage': 3 } } });
});

test('equip-item refuses what is only worn already or missing, and is absent without the capability', async t => {
  const { c, acts } = await setup(t, { capabilities: ['equip-item'], inventory: [chestplate, worn] });
  assert.match(await equip(c, { item: 'minecraft:iron_chestplate' }), /MISSING_ITEM/);
  assert.match(await equip(c, { item: 'minecraft:diamond_boots' }), /MISSING_ITEM/);
  assert.equal(acts().length, 0);
  const without = await setup(t, { capabilities: [] });
  assert.ok(!(await without.c.listTools()).tools.some(item => item.name === 'equip-item'));
});