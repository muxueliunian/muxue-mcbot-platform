import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ContainerTasks } from '../dist/tasks.js';
import { ServerBody } from '../dist/server-body.js';
import { BodyError } from '../dist/body.js';
import { mockServerControl } from './mock-server-control.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';

const clone = value => structuredClone(value);
const empty = (slot, extra = {}) => ({ slot, id: 'minecraft:air', count: 0, components: {}, ...extra });
const components = { 'minecraft:custom_data': { type: 'compound', value: { amount: { type: 'long', value: '9007199254740993' } } } };
function fixture({ variant = false, unknownSource = false, full = false, blocked = false, approach = false, visibility, configureMenu } = {}) {
  const calls = [];
  const identity = { instanceId: 'instance', sessionId: 'session', worldId: 'world', dimension: 'minecraft:overworld', controlGeneration: 0 };
  const state = { ...identity, connected: true, username: 'Bot', source: 'server-observed', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, chat: [], chatCursor: 0, selectedSlot: 0,
    inventory: [empty(0), { slot: 1, id: 'minecraft:diamond', count: 8, components: {} }], entities: [{ id: approach ? 'acaa383e-29c8-437a-a092-48b9a5320be2' : 'Alex-id', type: 'minecraft:player', name: 'Alex', position: { x: 1, y: 64, z: 0 } }], container: null };
  const original = { id: 'menu', type: 'minecraft:generic_9x3', revision: 0, carried: { id: 'minecraft:air', count: 0, components: {} }, slots: [
    { slot: 0, id: 'minecraft:oak_log', count: 10, components, source: unknownSource ? 'unknown' : 'container' },
    empty(1, { source: 'container' }),
    full ? { slot: 2, id: 'minecraft:stone', count: 64, components: {}, source: 'player', playerSlot: 0 } : empty(2, { source: 'player', playerSlot: 0 }),
    { slot: 3, id: 'minecraft:diamond', count: 8, components: {}, source: 'player', playerSlot: 1 },
  ] };
  if (variant) original.slots[1] = { slot: 1, id: 'minecraft:oak_log', count: 10, components: { name: 'special' }, source: 'container' };
  configureMenu?.(original);
  let owner;
  const body = {
    hello: { ...identity, backend: 'server', capabilities: approach ? ['approach-container', 'approach-player'] : [], sessionId: 'session' }, pendingOperations: () => [],
    acquireTask: token => { if (owner) throw new BodyError('BUSY', 'busy'); owner = token; }, releaseTask: token => { if (owner === token) owner = undefined; },
    observe: async () => { await body.beforeObserve?.(); return clone(state); },
    nearbyBlocks: async args => ({ ...identity, center: { player: args.centerPlayer ?? 'Bot', position: clone(state.entities.find(entity => entity.name === args.centerPlayer)?.position ?? state.position) }, candidates: [{ position: { x: 1, y: 64, z: 0 }, id: 'minecraft:chest', properties: { facing: 'north', type: 'single', waterlogged: 'false' }, ...(approach ? { targetToken: '1cb1a1cf-95e8-4c1f-a631-ac46176acff2' } : {}), distance: 1, visibility: visibility ?? (blocked ? 'occluded' : 'visible') }] }),
    act: async (name, args, token) => {
      if (owner && owner !== token && name !== 'send-chat') throw new BodyError('BUSY', 'task lock');
      calls.push({ name, args: clone(args) });
      await body.beforeAct?.(name, args);
      let status = 'succeeded', result;
      if (name === 'approach-container') { state.position = { x: 1, y: 64, z: 1 }; result = { position: clone(state.position), targetToken: args.targetToken }; }
      if (name === 'approach-player') { assert.equal(args.expectedEntityId, state.entities[0].id); state.position = clone(state.entities[0].position); result = { position: clone(state.position), player: args.player, entityId: args.expectedEntityId }; }
      if (name === 'open-container') state.container = clone(original);
      if (name === 'click-slot') {
        const menu = state.container, stack = menu.slots.find(item => item.slot === args.slot);
        assert.equal(args.containerId, menu.id); assert.equal(args.expectedRevision, menu.revision);
        assert.equal(args.expectedItem, stack.id); assert.equal(args.expectedCount, stack.count); assert.deepEqual(args.expectedComponents, stack.components);
        assert.equal(args.expectedCarriedItem, menu.carried.id); assert.equal(args.expectedCarriedCount, menu.carried.count); assert.deepEqual(args.expectedCarriedComponents, menu.carried.components);
        const carried = menu.carried;
        if (carried.count === 0) { menu.carried = { id: stack.id, count: stack.count, components: clone(stack.components), ...(stack.maxStackSize !== undefined ? { maxStackSize: stack.maxStackSize } : {}) }; Object.assign(stack, empty(stack.slot, { source: stack.source, playerSlot: stack.playerSlot })); delete stack.maxStackSize; }
        else {
          const n = args.button === 1 ? 1 : carried.count;
          if (stack.count === 0) Object.assign(stack, { id: carried.id, count: 0, components: clone(carried.components), ...(carried.maxStackSize !== undefined ? { maxStackSize: carried.maxStackSize } : {}) });
          stack.count += n; carried.count -= n;
          if (carried.count === 0) menu.carried = { id: 'minecraft:air', count: 0, components: {} };
        }
        menu.revision++;
        const player = menu.slots.find(item => item.source === 'player' && item.playerSlot === 0);
        state.inventory[0] = { slot: 0, id: player.id, count: player.count, components: clone(player.components), ...(player.maxStackSize !== undefined ? { maxStackSize: player.maxStackSize } : {}) };
        result = { container: clone(menu) };
      }
      if (name === 'close-container') state.container = null;
      if (name === 'select-slot') state.selectedSlot = args.slot;
      if (name === 'drop-item') {
        if (args.recipient) { assert.equal(args.recipient, state.entities[0].name); assert.equal(args.expectedEntityId, state.entities[0].id); }
        const stack = state.inventory.find(item => item.slot === args.slot);
        assert.equal(state.selectedSlot, args.slot); assert.equal(args.expectedItem, stack.id); assert.equal(args.expectedCount, stack.count); assert.deepEqual(args.expectedComponents, stack.components);
        const count = body.partialDrop ?? args.count; stack.count -= count;
        if (stack.count === 0) Object.assign(stack, empty(stack.slot));
        status = body.partialDrop ? 'failed' : 'succeeded'; result = { droppedCount: count, removedCount: count };
      }
      if (body.unknownClick && name === 'click-slot') { status = 'unknown'; result = undefined; }
      return { operationId: randomUUID(), sessionId: identity.sessionId, controlGeneration: identity.controlGeneration, name, status, summary: name, result };
    },
  };
  const tasks = new ContainerTasks(body);
  return { body, tasks, calls, state, async ref() { return (await tasks.discover({ radius: 4, maxResults: 8, centerPlayer: 'Alex' })).candidates[0].containerRef; } };
}

test('one task opens, withdraws exact count with typed components, returns remainder, closes and drops once', async () => {
  const f = fixture(); const ref = await f.ref();
  const result = await f.tasks.run('fetch-and-give', { containerRef: ref, item: 'minecraft:oak_log', count: 3, player: 'Alex', say: '我看看旁边的箱子' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.withdrawnCount, 3); assert.equal(result.result.droppedCount, 3); assert.equal(result.result.heldCount, 0); assert.equal(result.result.pickup, 'unconfirmed');
  assert.equal(f.calls[0].name, 'send-chat'); assert.equal(f.state.container, null); assert.equal(f.calls.filter(call => call.name === 'drop-item').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 5);
  assert.deepEqual(f.calls.find(call => call.name === 'click-slot').args.expectedComponents, components);
});

test('container list excludes explicit player diamonds and separates same ID component variants', async () => {
  const f = fixture({ variant: true }); const op = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.items.length, 2);
  assert.deepEqual(op.result.items.map(item => item.item), ['minecraft:oak_log', 'minecraft:oak_log']); assert.equal(f.state.container, null);
  assert.ok(!JSON.stringify(op).includes('9007199254740993'));
});
test('actual maxStackSize survives carried receipts, resolves one stack and batches 99-item drops under atomic 64', async () => {
  for (const maxStackSize of [16, 64, 99]) {
    const f = fixture({ configureMenu: menu => { menu.slots[0].count = maxStackSize; menu.slots[0].maxStackSize = maxStackSize; } });
    const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', stacks: 1, player: 'Alex' });
    assert.equal(op.status, 'succeeded'); assert.equal(op.result.requestedCount, maxStackSize); assert.equal(op.result.maxStackSize, maxStackSize); assert.equal(op.result.droppedCount, maxStackSize);
    const drops = f.calls.filter(call => call.name === 'drop-item');
    assert.deepEqual(drops.map(call => call.args.count), maxStackSize === 99 ? [64, 35] : [maxStackSize]);
    assert.ok(drops.every(call => call.args.expectedMaxStackSize === maxStackSize));
    if (maxStackSize === 99) assert.deepEqual(drops.map(call => call.args.expectedCount), [99, 35]);
  }
});
test('container quantities reject omitted/ambiguous goals, unknown maxima, over-one-stack and oversized targets without truncation', async () => {
  for (const [request, max, code] of [[{}, 16, 'INVALID_ARGUMENT'], [{ count: 3, stacks: 1 }, 16, 'INVALID_ARGUMENT'], [{ stacks: 1 }, undefined, 'UNKNOWN_MAX_STACK'], [{ stacks: 2 }, 99, 'INSUFFICIENT_ITEMS'], [{ stacks: 3 }, 99, 'UNSUPPORTED']]) {
    const f = fixture({ configureMenu: menu => { menu.slots[0].count = 99; if (max !== undefined) menu.slots[0].maxStackSize = max; } });
    const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', ...request });
    assert.equal(op.result.code, code); assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
  }
});
test('upper limit changes before second native drop stop at the first confirmed 64 without retry', async () => {
  const f = fixture(); f.state.inventory[0] = { slot: 0, id: 'minecraft:oak_log', count: 99, components, maxStackSize: 99 };
  f.body.beforeObserve = () => { if (f.calls.some(call => call.name === 'drop-item')) f.state.inventory[0].maxStackSize = 64; };
  const op = await f.tasks.run('give-item', { item: 'minecraft:oak_log', stacks: 1, player: 'Alex' });
  assert.equal(op.status, 'failed'); assert.equal(op.result.droppedCount, 64); assert.equal(f.calls.filter(call => call.name === 'drop-item').length, 1);
});

test('component ambiguity, unknown slot source and full hotbar reject before any click', async () => {
  for (const [options, code] of [[{ variant: true }, 'AMBIGUOUS_ITEM'], [{ unknownSource: true }, 'UNSUPPORTED'], [{ full: true }, 'INVENTORY_FULL']]) {
    const f = fixture(options), op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
    assert.equal(op.result.code, code); assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
  }
});

test('own diamonds are never withdrawn from player slots as container contents', async () => {
  const f = fixture(), op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:diamond', count: 3 });
  assert.equal(op.result.code, 'INSUFFICIENT_ITEMS'); assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('unknown click stops subsequent clicks and drop without retry', async () => {
  const f = fixture(); f.body.unknownClick = true;
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'unknown'); assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 1); assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
});

test('partial native drop preserves withdrawn, held and dropped evidence and never repeats', async () => {
  const f = fixture(); f.body.partialDrop = 1;
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'failed'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.heldCount, 2); assert.equal(op.result.droppedCount, 1);
  assert.equal(f.calls.filter(call => call.name === 'drop-item').length, 1);
});

test('stop after confirmed withdrawal fences close/look/select/drop and old refs', async () => {
  const f = fixture(); let count = 0;
  f.body.beforeObserve = () => { if (f.state.inventory[0].count === 1 && ++count === 1) f.tasks.cancel(); };
  const ref = await f.ref(), op = await f.tasks.run('fetch-and-give', { containerRef: ref, item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'cancelled'); assert.equal(op.result.withdrawnCount, 1);
  assert.equal(op.result.heldCount, undefined); assert.equal(op.result.carriedCount, undefined); assert.equal(op.result.lastConfirmedHeldCount, 1);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 2); assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
  f.body.beforeObserve = undefined; f.state.container = null;
  const after = await f.tasks.run('container-list', { containerRef: ref }); assert.equal(after.result.code, 'STALE_REFERENCE');
});

test('context replacement and occluded targets never open or mutate', async () => {
  const f = fixture(), ref = await f.ref(); f.state.controlGeneration++;
  assert.equal((await f.tasks.run('container-list', { containerRef: ref })).result.code, 'WORLD_CHANGED'); assert.equal(f.calls.length, 0);
  const blocked = fixture({ blocked: true }); assert.equal((await blocked.tasks.run('container-list', { containerRef: await blocked.ref() })).result.code, 'NO_LINE_OF_SIGHT'); assert.equal(blocked.calls.length, 0);
});

test('task mutex rejects concurrent task and atomic writes, while cancel prevents later steps', async () => {
  const f = fixture(); let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  f.body.beforeAct = name => name === 'open-container' ? new Promise(resolve => { release = resolve; started(); }) : undefined;
  const pending = f.tasks.run('container-list', { containerRef: await f.ref() }); await entered;
  await assert.rejects(f.tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' }), { code: 'BUSY' });
  await assert.rejects(f.body.act('look-at', { x: 1, y: 64, z: 0 }), { code: 'BUSY' });
  f.tasks.cancel(); release(); assert.equal((await pending).status, 'cancelled'); assert.equal(f.calls.length, 1);
});

test('ServerBody validates nearby context, retains source mapping and enforces task token on direct atomic calls', async t => {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...hello().capabilities, 'nearby-blocks'] });
  mock.handlers['nearby-blocks'] = args => ({ instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 0,
    center: { player: args.centerPlayer, position: { x: 1, y: 64, z: 0 } }, candidates: [], truncated: false });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 }); t.after(() => body.close());
  assert.equal((await body.nearbyBlocks({ centerPlayer: 'Alex', radius: 4, maxResults: 8 })).center.player, 'Alex');
  body.acquireTask('task'); await assert.rejects(body.act('look-at', { x: 1, y: 64, z: 0 }), { code: 'BUSY' });
  assert.equal((await body.act('look-at', { x: 1, y: 64, z: 0 }, 'task')).status, 'succeeded');
  const internal = await body.act('move-to-position', { x: 1, y: 64, z: 0 }, 'task');
  assert.equal(internal.status, 'running'); assert.deepEqual(body.pendingOperations(), []); await body.stop();
  body.releaseTask('wrong-task'); await assert.rejects(body.act('look-at', { x: 1, y: 64, z: 0 }), { code: 'BUSY' }); body.releaseTask('task');
  assert.equal((await body.act('look-at', { x: 1, y: 64, z: 0 })).status, 'succeeded');
  mock.handlers['nearby-blocks'] = () => ({ instanceId: 'other', sessionId: 'server-session-1', worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 1, center: { player: 'Alex', position: { x: 1, y: 64, z: 0 } }, candidates: [] });
  await assert.rejects(body.nearbyBlocks({ radius: 4, maxResults: 8 }), { code: 'WORLD_CHANGED' });
});

test('task timeout stops native running operation before releasing task ownership', async () => {
  const f = fixture(); let clock = 0, stops = 0;
  const tasks = new ContainerTasks(f.body, () => clock += 20000);
  const originalAct = f.body.act;
  f.body.act = async (...args) => ({ ...await originalAct(...args), status: 'running' });
  f.body.stop = async () => { stops++; return { stopped: true }; };
  const ref = (await tasks.discover({ radius: 4, maxResults: 8 })).candidates[0].containerRef;
  const op = await tasks.run('container-list', { containerRef: ref });
  assert.equal(op.result.code, 'TASK_TIMEOUT'); assert.equal(op.status, 'unknown'); assert.equal(stops, 1); assert.equal(f.calls.length, 1);
});

test('recipient leaves after selection: withdrawn items stay held and nothing is dropped', async () => {
  const f = fixture(); f.body.beforeAct = name => { if (name === 'select-slot') f.state.entities[0].position.x = 10; };
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.result.code, 'OUT_OF_REACH'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.heldCount, 3); assert.equal(op.result.droppedCount, 0); assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
});

test('menu revision changes between clicks stops at last confirmed transfer', async () => {
  const f = fixture(); let changed = false;
  f.body.beforeObserve = () => { if (!changed && f.state.inventory[0].count === 1) { f.state.container.revision++; changed = true; } };
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.result.code, 'CONTAINER_CHANGED'); assert.equal(op.result.withdrawnCount, 1); assert.equal(op.result.carriedCount, 9);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 2); assert.equal(op.result.cleanup, 'carried_or_changed_menu_left_for_inspection');
});

test('explicit recipient line of sight rejection prevents drop even when entity is present', async () => {
  const f = fixture(); const nearby = f.body.nearbyBlocks;
  f.body.nearbyBlocks = async args => { if (args.radius === 1) throw new BodyError('NO_LINE_OF_SIGHT', 'player blocked'); return nearby(args); };
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.result.code, 'NO_LINE_OF_SIGHT'); assert.equal(op.result.heldCount, 3); assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
});

test('actual MCP task tools accept compact references without NBT and return one honest drop result', async t => {
  const f = fixture(); f.body.hello.capabilities = ['nearby-blocks', 'send-chat', 'open-container', 'click-slot', 'close-container', 'look-at', 'select-slot', 'drop-item'];
  const events = new EventJournal(), server = createMcpServer(f.body, events);
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'task-test', version: '1' });
  await server.connect(left); await client.connect(right); t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools, task = tools.find(tool => tool.name === 'fetch-and-give');
  assert.deepEqual(task.inputSchema.required.sort(), ['containerRef', 'item', 'player'].sort()); assert.equal('expectedComponents' in task.inputSchema.properties, false);
  assert.ok(task.inputSchema.properties.count); assert.ok(task.inputSchema.properties.stacks);
  const call = async (name, args) => { const reply = await client.callTool({ name, arguments: args }); assert.equal(reply.isError, undefined); return JSON.parse(reply.content[0].text); };
  const ref = (await call('discover-containers', { centerPlayer: 'Alex' })).candidates[0].containerRef;
  const op = await call('fetch-and-give', { containerRef: ref, item: 'minecraft:oak_log', count: 3, player: 'Alex', say: '我给你拿三个' });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.droppedCount, 3); assert.equal(op.result.pickup, 'unconfirmed');
  assert.ok(!JSON.stringify(op).includes('9007199254740993')); assert.deepEqual(events.since(0, ['task']), []);
  assert.equal((await call('get-operation', { operationId: op.operationId })).result.droppedCount, 3);
});

test('bounded task walks before token-guarded open, returns to UUID-bound recipient and drops once', async () => {
  const f = fixture({ approach: true, blocked: true });
  f.state.entities[0].position.x = 8;
  const discovered = await f.tasks.discover({ radius: 4, maxResults: 8 });
  assert.equal(discovered.candidates[0].targetToken, undefined);
  assert.equal(discovered.candidates[0].properties, undefined);
  const op = await f.tasks.run('fetch-and-give', { containerRef: discovered.candidates[0].containerRef, item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.containerProtection, 'instance-bound');
  assert.deepEqual(f.calls.slice(0, 2).map(call => call.name), ['approach-container', 'open-container']);
  const walking = f.calls.find(call => call.name === 'approach-container'), opening = f.calls.find(call => call.name === 'open-container');
  assert.equal(walking.args.timeoutMs, 20000); assert.equal(opening.args.targetToken, walking.args.targetToken);
  assert.ok(f.calls.findIndex(call => call.name === 'close-container') < f.calls.findIndex(call => call.name === 'approach-player'));
  const returning = f.calls.find(call => call.name === 'approach-player');
  assert.equal(returning.args.expectedEntityId, f.state.entities[0].id); assert.equal(returning.args.distance, 1.3);
  assert.equal(f.calls.find(call => call.name === 'drop-item').args.expectedEntityId, returning.args.expectedEntityId);
  assert.equal(op.result.pickup, 'unconfirmed');
});

test('older body remains near-range compatible and reports state-only container protection', async () => {
  const f = fixture(), discovered = await f.tasks.discover({ radius: 4, maxResults: 8 });
  assert.match(discovered.limitation, /不保证同位置容器替换/);
  const op = await f.tasks.run('container-list', { containerRef: discovered.candidates[0].containerRef });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.containerProtection, 'state-only');
  assert.equal(f.calls.some(call => call.name.startsWith('approach-')), false);
});

test('advertised approach without an instance token fails safe, and unknown visibility is explicit', async () => {
  const f = fixture(); f.body.hello.capabilities = ['approach-container'];
  const op = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(op.result.code, 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
  const unknown = fixture({ approach: true, visibility: 'unknown' });
  const result = await unknown.tasks.run('container-list', { containerRef: await unknown.ref() });
  assert.equal(result.result.code, 'UNKNOWN_TARGET'); assert.equal(unknown.calls.length, 0);
});

test('stop during container movement fences a late success so no open follows', async () => {
  const f = fixture({ approach: true }); let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.body.beforeAct = name => name === 'approach-container' ? new Promise(resolve => { release = resolve; started(); }) : undefined;
  const pending = f.tasks.run('container-list', { containerRef: await f.ref() }); await entered;
  await assert.rejects(f.body.act('look-at', { x: 0, y: 64, z: 0 }), { code: 'BUSY' });
  f.tasks.cancel(); release();
  assert.equal((await pending).status, 'cancelled'); assert.deepEqual(f.calls.map(call => call.name), ['approach-container']);
  f.body.beforeAct = undefined;
  assert.equal((await f.tasks.run('container-list', { containerRef: await f.ref() })).status, 'succeeded');
});

test('unknown movement never retries or opens; partial withdrawal stays held when return movement fails', async () => {
  const f = fixture({ approach: true }), act = f.body.act;
  f.body.act = async (...args) => ({ ...await act(...args), status: args[0] === 'approach-container' ? 'unknown' : 'succeeded' });
  const result = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(result.status, 'unknown'); assert.equal(result.result.stage, 'approaching-container'); assert.equal(f.calls.length, 1);
  const returning = fixture({ approach: true });
  returning.body.beforeAct = name => { if (name === 'approach-player') throw new BodyError('TARGET_MOVED', 'recipient moved'); };
  const partial = await returning.tasks.run('fetch-and-give', { containerRef: await returning.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(partial.status, 'failed'); assert.equal(partial.result.withdrawnCount, 3); assert.equal(partial.result.heldCount, 3);
  assert.equal(partial.result.droppedCount, 0); assert.equal(returning.calls.some(call => call.name === 'drop-item'), false);
});

test('UUID recipient is bound before fetch, so same-name replacement never receives items', async () => {
  const f = fixture({ approach: true });
  f.body.beforeAct = name => { if (name === 'close-container') f.state.entities[0].id = randomUUID(); };
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.result.code, 'STALE_TARGET'); assert.equal(op.result.heldCount, 3);
  assert.equal(f.calls.some(call => call.name === 'approach-player' || call.name === 'drop-item'), false);
});

test('stop after fetch during return movement prevents all look, select and drop', async () => {
  const f = fixture({ approach: true });
  f.body.beforeAct = name => { if (name === 'approach-player') f.tasks.cancel(); };
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'cancelled'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.lastConfirmedHeldCount, 3);
  assert.equal(f.calls.some(call => ['look-at', 'select-slot', 'drop-item'].includes(call.name)), false);
});

test('server token expiry after movement fails open without rediscovery or token extension', async () => {
  const f = fixture({ approach: true });
  f.body.beforeAct = name => { if (name === 'open-container') throw new BodyError('STALE_TARGET', 'expired'); };
  const op = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(op.status, 'failed'); assert.equal(op.result.code, 'STALE_TARGET');
  assert.deepEqual(f.calls.map(call => call.name), ['approach-container', 'open-container']);
});

test('movement waits its specified 20-second bound rather than the previous 15-second deadline', async () => {
  const f = fixture({ approach: true }); let clock = 0, stops = 0, polls = 0;
  const tasks = new ContainerTasks(f.body, () => clock), act = f.body.act;
  f.body.act = async (...args) => { const op = await act(...args); if (args[0] === 'approach-container') { clock = 16000; return { ...op, status: 'running' }; } return op; };
  f.body.operation = async operationId => { polls++; clock = 20000; return { operationId, sessionId: 'session', name: 'approach-container', status: 'succeeded', summary: 'arrived' }; };
  f.body.stop = async () => { stops++; return { stopped: true }; };
  const ref = (await tasks.discover({ radius: 4, maxResults: 8 })).candidates[0].containerRef;
  const op = await tasks.run('container-list', { containerRef: ref });
  assert.equal(op.status, 'succeeded'); assert.equal(stops, 0); assert.equal(polls, 1);
});

test('MCP approach uses only a local containerRef, hides private token in immediate and detailed receipts', async t => {
  const f = fixture({ approach: true }); f.body.hello.capabilities.push('nearby-blocks', 'open-container', 'close-container');
  let operation;
  const act = f.body.act;
  f.body.act = async (...args) => operation = await act(...args);
  f.body.operation = async () => operation;
  const events = new EventJournal(), server = createMcpServer(f.body, events);
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'approach-test', version: '1' });
  await server.connect(left); await client.connect(right); t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  const tool = tools.find(value => value.name === 'approach-container');
  assert.equal(tool.inputSchema.properties.targetToken, undefined); assert.deepEqual(tool.inputSchema.required, ['containerRef']);
  const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined); return JSON.parse(result.content[0].text); };
  const discovered = await call('discover-containers', {});
  assert.equal(discovered.candidates[0].targetToken, undefined);
  const result = await call('approach-container', { containerRef: discovered.candidates[0].containerRef });
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.targetToken, undefined);
  assert.equal((await call('get-operation', { operationId: result.operationId, details: true })).result.targetToken, undefined);
});

test('generic slot activity excludes hidden machine stacks without losing known visible contents', async () => {
  const f = fixture({ configureMenu: menu => {
    menu.type = 'example:machine';
    menu.slots[0].active = true;
    menu.slots[0].mayPickup = false;
    menu.slots[1] = { slot: 1, id: 'minecraft:diamond', count: 64, components: {}, source: 'container', active: false, mayPickup: true };
  } });
  const result = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result.items, [{ item: 'minecraft:oak_log', count: 10, variant: 1 }]);
  assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('mayPickup false rejects withdrawal before clicks and never combines unavailable counts', async () => {
  const f = fixture({ configureMenu: menu => {
    menu.slots[0].active = true; menu.slots[0].mayPickup = false;
    menu.slots[1] = { slot: 1, id: 'minecraft:oak_log', count: 2, components, source: 'container', active: true, mayPickup: true };
  } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.result.code, 'ITEM_NOT_PICKABLE'); assert.equal(op.result.withdrawnCount, 0);
  assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('inactive same-ID variants are not counted, selected or mistaken for component ambiguity', async () => {
  const f = fixture({ variant: true, configureMenu: menu => { menu.slots[1].active = false; } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.withdrawnCount, 3);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').some(call => call.args.slot === 1), false);
  const hidden = fixture({ configureMenu: menu => { menu.slots[0].active = false; } });
  const result = await hidden.tasks.run('container-withdraw', { containerRef: await hidden.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(result.result.code, 'INSUFFICIENT_ITEMS'); assert.equal(hidden.calls.some(call => call.name === 'click-slot'), false);
});

test('inactive empty player slots are never selected as withdrawal destinations', async () => {
  const f = fixture({ configureMenu: menu => { menu.slots[2].active = false; } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.result.code, 'INVENTORY_FULL'); assert.equal(op.result.withdrawnCount, 0);
  assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('inactive unknown-source slots cannot bypass rejection of an unverified menu', async () => {
  const f = fixture({ configureMenu: menu => { menu.slots[1].source = 'unknown'; menu.slots[1].active = false; } });
  const op = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(op.result.code, 'UNSUPPORTED'); assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('custom menus retain exact-stack-only policy while generic slot semantics allow exact withdrawal', async () => {
  const configureMenu = menu => { menu.type = 'example:machine'; menu.slots[0].count = 3; menu.slots[0].active = true; menu.slots[0].mayPickup = true; menu.slots[2].active = true; };
  const partial = fixture({ configureMenu });
  const refused = await partial.tasks.run('container-withdraw', { containerRef: await partial.ref(), item: 'minecraft:oak_log', count: 2 });
  assert.equal(refused.result.code, 'UNSUPPORTED'); assert.equal(partial.calls.some(call => call.name === 'click-slot'), false);
  const exact = fixture({ configureMenu });
  const op = await exact.tasks.run('container-withdraw', { containerRef: await exact.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.withdrawnCount, 3); assert.equal(exact.state.container, null);
});

test('custom output withdrawal deposits carried items into active empty player slots with mayPickup false', async () => {
  const f = fixture({ configureMenu: menu => {
    menu.type = 'example:machine';
    menu.slots[0].count = 3; menu.slots[0].active = true; menu.slots[0].mayPickup = true;
    menu.slots[2].active = true; menu.slots[2].mayPickup = false;
  } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.heldCount, 3);
  assert.equal(f.state.container, null); assert.deepEqual(f.state.inventory[0].components, components);
  const clicks = f.calls.filter(call => call.name === 'click-slot');
  assert.equal(clicks.length, 4); assert.equal(clicks[0].args.slot, 0);
  assert.equal(clicks[1].args.slot, 2); assert.equal(clicks[1].args.expectedItem, 'minecraft:air');
  assert.equal(clicks[1].args.expectedCount, 0); assert.deepEqual(clicks[1].args.expectedComponents, {});
  assert.equal(clicks[1].args.expectedCarriedCount, 3); assert.deepEqual(clicks[1].args.expectedCarriedComponents, components);
  assert.deepEqual(clicks.slice(1).map(call => call.args.expectedCarriedCount), [3, 2, 1]);
});

test('activity fields remain in full-menu guards: changed activity stops before a second click', async () => {
  const f = fixture({ configureMenu: menu => { menu.slots[0].active = true; menu.slots[0].mayPickup = true; menu.slots[2].active = true; } });
  let changed = false;
  f.body.beforeObserve = () => { if (!changed && f.state.container?.carried.count > 0) { f.state.container.slots[2].active = false; changed = true; } };
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.result.code, 'CONTAINER_CHANGED'); assert.equal(op.result.withdrawnCount, 0);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 1);
});
