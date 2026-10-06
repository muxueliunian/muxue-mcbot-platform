import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePillarBlock, pillarRank, pillarUp, pillarDown } from '../dist/pillar.js';

const slot = (slot, id, count) => ({ slot, id, count, components: {}, ...(count ? { maxStackSize: 64 } : {}) });
const inventory = items => { const all = Array.from({ length: 36 }, (_, i) => slot(i, 'minecraft:air', 0)); for (const item of items) all[item.slot] = item; return all; };

test('pillar blocks: logs first when chopping, otherwise soft blocks, stone last, never gravity or odd blocks', () => {
  assert.equal(pillarRank('minecraft:oak_log', 'log'), 0);
  assert.equal(pillarRank('minecraft:oak_log', 'other'), 1);
  assert.equal(pillarRank('minecraft:dirt', 'other'), 1);
  assert.equal(pillarRank('minecraft:oak_planks', 'log'), 1);
  assert.equal(pillarRank('minecraft:cobblestone', 'other'), 2);
  for (const id of ['minecraft:sand', 'minecraft:gravel', 'minecraft:oak_slab', 'minecraft:chest', 'minecraft:torch', 'minecraft:diamond_block']) assert.equal(pillarRank(id, 'other'), undefined, id);
  const state = { selectedSlot: 0, inventory: inventory([slot(0, 'minecraft:iron_pickaxe', 1), slot(2, 'minecraft:cobblestone', 64), slot(12, 'minecraft:dirt', 5), slot(20, 'minecraft:birch_log', 3), slot(4, 'minecraft:sand', 64)]) };
  assert.equal(choosePillarBlock(state, 'other').id, 'minecraft:dirt');
  assert.equal(choosePillarBlock(state, 'log').id, 'minecraft:birch_log');
  assert.equal(choosePillarBlock({ selectedSlot: 0, inventory: inventory([slot(2, 'minecraft:cobblestone', 64)]) }, 'other').id, 'minecraft:cobblestone');
  assert.equal(choosePillarBlock({ selectedSlot: 0, inventory: inventory([slot(2, 'minecraft:sand', 64)]) }, 'other'), undefined);
});

test('pillarUp moves a backpack block into a free hotbar slot without touching the held tool, then rises', async () => {
  const state = { position: { x: 0.5, y: 64, z: 0.5 }, selectedSlot: 0, inventory: inventory([slot(0, 'minecraft:iron_axe', 1), slot(12, 'minecraft:dirt', 5)]) };
  const calls = [];
  const host = {
    observe: async () => structuredClone(state),
    run: async (name, args) => {
      calls.push({ name, args });
      if (name === 'swap-inventory') { const a = state.inventory[args.sourceSlot], b = state.inventory[args.hotbarSlot]; state.inventory[args.sourceSlot] = { ...b, slot: args.sourceSlot }; state.inventory[args.hotbarSlot] = { ...a, slot: args.hotbarSlot }; return {}; }
      state.inventory[args.slot].count--; state.position.y++;
      return { block: { position: { x: 0, y: 64, z: 0 }, id: 'minecraft:dirt' } };
    },
  };
  const placed = await pillarUp(host, 'other');
  assert.deepEqual(calls.map(call => call.name), ['swap-inventory', 'pillar-up']);
  assert.equal(calls[0].args.hotbarSlot, 1);
  assert.deepEqual(calls[1].args, { slot: 1, expectedItem: 'minecraft:dirt', expectedCount: 5, expectedComponents: {} });
  assert.deepEqual(placed, { position: { x: 0, y: 64, z: 0 }, id: 'minecraft:dirt', item: 'minecraft:dirt' });
  await assert.rejects(pillarUp({ observe: async () => ({ selectedSlot: 0, inventory: inventory([]) }), run: async () => assert.fail('no action without blocks') }, 'other'), { code: 'NO_PILLAR_BLOCKS' });
});

test('pillarDown only digs the block it placed while standing on it, then waits to land one lower', async () => {
  const block = { position: { x: 0, y: 64, z: 0 }, id: 'minecraft:dirt', item: 'minecraft:dirt' };
  let y = 65; const calls = [];
  const host = {
    observe: async at => ({ position: { x: 0.5, y, z: 0.5 }, ...(at ? { block: { position: at, state: 'loaded', id: 'minecraft:dirt', properties: {} } } : {}) }),
    run: async (name, args) => { calls.push({ name, args }); y = 64; return {}; },
  };
  await pillarDown(host, block);
  assert.deepEqual(calls[0], { name: 'dig-block', args: { x: 0, y: 64, z: 0, expectedBlock: 'minecraft:dirt', expectedProperties: {}, timeoutMs: 15000 } });
  y = 70;
  await assert.rejects(pillarDown(host, block), { code: 'STALE_TARGET' });
  y = 65;
  const other = { ...host, observe: async at => ({ position: { x: 0.5, y, z: 0.5 }, block: { position: at, state: 'loaded', id: 'minecraft:oak_planks', properties: {} } }) };
  await assert.rejects(pillarDown(other, block), { code: 'STALE_BLOCK' });
});
