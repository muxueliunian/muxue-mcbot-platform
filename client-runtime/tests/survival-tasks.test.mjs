import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SurvivalTasks, selectFood } from '../dist/survival-tasks.js';
import { BodyError } from '../dist/body.js';

const clone = structuredClone, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
async function until(check) { for (let n = 0; n < 200; n++) { if (check()) return; await wait(5); } assert.fail('observable condition timed out'); }
const item = (id, count = 1, maxStackSize = 64, components = {}) => ({ id: 'minecraft:' + id, count, maxStackSize, components });
const value = stack => ({ id: stack.id, count: stack.count, components: clone(stack.components), ...(stack.maxStackSize !== undefined ? { maxStackSize: stack.maxStackSize } : {}) });
function fixture() {
  const state = { instanceId: 'instance', sessionId: 'session', worldId: 'world', dimension: 'minecraft:overworld', controlGeneration: 0,
    serverTick: 1, observedAt: Date.now(), health: 20, maxHealth: 20, food: 14, saturation: 0, selectedSlot: 0,
    inventory: Array.from({ length: 36 }, (_, slot) => ({ slot, id: 'minecraft:air', count: 0, components: {} })), foods: [] };
  state.inventory[0] = { slot: 0, ...item('iron_pickaxe', 1, 1, { 'minecraft:damage': 9 }) };
  const catalog = new Map([
    ['minecraft:bread', { nutrition: 5, saturationModifier: 0.6, eatDurationTicks: 32, safe: true }],
    ['minecraft:apple', { nutrition: 4, saturationModifier: 0.3, eatDurationTicks: 32, safe: true }],
    ['minecraft:cooked_beef', { nutrition: 8, saturationModifier: 0.8, eatDurationTicks: 32, safe: true }],
    ['minecraft:golden_apple', { nutrition: 4, saturationModifier: 1.2, eatDurationTicks: 32, safe: true, precious: true }],
    ['minecraft:enchanted_golden_apple', { nutrition: 4, saturationModifier: 1.2, eatDurationTicks: 32, safe: true, precious: true }],
    ['minecraft:rotten_flesh', { nutrition: 4, saturationModifier: 0.1, eatDurationTicks: 32, safe: false, reason: 'FOOD_EFFECTS_NOT_ALLOWED' }],
    ['minecraft:golden_carrot', { nutrition: 6, saturationModifier: 1.2, eatDurationTicks: 32, safe: true }],
    ['minecraft:pufferfish', { nutrition: 1, saturationModifier: 0.1, eatDurationTicks: 32, safe: false, reason: 'negative effects' }],
    ['minecraft:mushroom_stew', { nutrition: 6, saturationModifier: 0.6, eatDurationTicks: 32, safe: true }],
  ]);
  let owner;
  const calls = [], releases = [], ops = new Map(), results = [];
  const snapshot = () => {
    const result = clone(state); result.foods = result.inventory.filter(stack => catalog.has(stack.id)).map(stack => ({ slot: stack.slot, id: stack.id, count: stack.count, ...catalog.get(stack.id) })); return result;
  };
  const consume = args => {
    const current = state.inventory[args.slot]; assert.equal(current.id, args.expectedItem); assert.equal(current.count, args.expectedCount); assert.deepEqual(current.components, args.expectedComponents);
    const nutrition = catalog.get(current.id).nutrition;
    if (current.id === 'minecraft:mushroom_stew') state.inventory[args.slot] = { slot: args.slot, ...item('bowl') };
    else if (--current.count === 0) state.inventory[args.slot] = { slot: args.slot, id: 'minecraft:air', count: 0, components: {} };
    state.food = Math.min(20, state.food + nutrition); state.saturation += nutrition; state.serverTick++;
  };
  const body = {
    hello: { protocol: 2, backend: 'server', sessionId: state.sessionId, worldId: state.worldId, connected: true, username: 'Bot', capabilities: ['swap-inventory', 'select-slot', 'eat-item'], platform: {} },
    acquireTask: token => { if (owner) throw new BodyError('BUSY', 'owner exists'); owner = token; },
    releaseTask: token => { releases.push(token); if (owner === token) owner = undefined; },
    survivalState: async options => { calls.push({ name: 'state', options }); await body.beforeState?.(); return body.overrideState ? body.overrideState() : snapshot(); },
    observe: async () => ({ ...snapshot(), connected: true, container: null }),
    pendingOperations: () => [], close: async () => {},
    operation: async id => { await body.beforeOperation?.(id); return clone(ops.get(id)); },
    stop: async () => { calls.push({ name: 'stop' }); if (body.stopFails) throw new BodyError('TRANSPORT_LOST', 'stop unavailable'); state.controlGeneration++; for (const [id, op] of ops) if (op.status === 'running') ops.set(id, { ...op, status: 'cancelled' }); return { stopped: true }; },
    act: async (name, args, token) => {
      if (token !== owner) throw new BodyError('BUSY', 'shared token mismatch');
      calls.push({ name, args: clone(args), token });
      const generation = state.controlGeneration;
      await body.beforeAct?.(name, args);
      const operation = { operationId: randomUUID(), sessionId: state.sessionId, controlGeneration: generation, name, summary: name, status: 'succeeded', result: {} };
      if (generation !== state.controlGeneration) operation.status = 'cancelled';
      else if (body.failAction === name) { operation.status = 'failed'; operation.result = { code: 'FORBIDDEN' }; }
      else if (body.runningAction === name) operation.status = 'running';
      else {
        if (name === 'swap-inventory') {
          const source = state.inventory[args.sourceSlot], target = state.inventory[args.hotbarSlot];
          assert(isDeepStrictEqual(value(source), args.expectedSource)); assert(isDeepStrictEqual(value(target), args.expectedTarget));
          state.inventory[args.sourceSlot] = { ...clone(target), slot: args.sourceSlot };
          state.inventory[args.hotbarSlot] = { ...clone(source), slot: args.hotbarSlot }; state.serverTick++;
        }
        if (name === 'select-slot') { const current = state.inventory[args.slot]; assert.equal(current.id, args.expectedItem); assert.deepEqual(current.components, args.expectedComponents); state.selectedSlot = args.slot; }
        if (name === 'eat-item') { consume(args); operation.result = { consumedCount: 1, consumption: 'confirmed' }; }
      }
      if (body.unknownAction === name) { operation.status = 'unknown'; operation.result = { lastConfirmedConsumedCount: name === 'eat-item' ? 1 : undefined }; }
      await body.afterAct?.(name, args, operation); ops.set(operation.operationId, clone(operation)); return operation;
    },
  };
  const tasks = new SurvivalTasks(body, () => body.clock ?? Date.now(), operation => results.push(operation));
  return { state, body, tasks, calls, releases, results, ops, snapshot, consume, owner: () => owner,
    set: (slot, stack) => { state.inventory[slot] = { slot, ...clone(stack) }; },
    borrow: token => { body.acquireTask(token); return { taskToken: token, context: { instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration }, check: () => {} }; } };
}

test('compact food selector uses authority safety/quantity, deficit and saturation without inventing components', () => {
  const f = fixture(); f.set(9, item('bread')); f.set(10, item('cooked_beef')); f.set(11, item('golden_carrot')); f.set(12, item('pufferfish'));
  const compact = f.snapshot(); delete compact.inventory;
  assert.equal(selectFood(compact).slot, 9);
  compact.food = 19; assert.equal(selectFood(compact).reason, 'WAIT_FOR_DEFICIT');
  compact.health = 10; compact.food = 17; assert.equal(selectFood(compact).slot, 9);
  compact.food = 6; assert.equal(selectFood(compact).slot, 10);
  compact.food = 20; assert.equal(selectFood(compact).reason, 'FULL');
});
test('selector ignores incomplete guards when full inventory exists and preserves current slot on exact food ties', () => {
  const f = fixture(); f.set(1, item('bread')); f.set(2, item('bread')); f.state.selectedSlot = 2;
  f.set(9, { ...item('cooked_beef'), componentsComplete: false }); delete f.state.inventory[9].components;
  f.state.food = 10; assert.equal(selectFood(f.snapshot()).slot, 2);
  f.state.inventory[2].componentsComplete = false; assert.equal(selectFood(f.snapshot()).slot, 1);
  assert.equal(selectFood(f.snapshot(), { protectedItems: ['minecraft:bread'] }).reason, 'NO_SAFE_FOOD');
});
test('ordinary deficit ranking picks most nutrition fitting and highest saturation on ties', () => {
  const f = fixture(); f.set(1, item('apple')); f.set(2, item('bread')); f.set(3, item('bread'));
  const state = f.snapshot(); state.foods.find(food => food.slot === 3).saturationModifier = 0.9;
  assert.equal(selectFood(state).slot, 3);
  state.food = 16; assert.equal(selectFood(state).slot, 1);
});
test('prepare swaps complete component/max guarded stack to empty hotbar and selects it', async () => {
  const f = fixture(), source = item('diamond_pickaxe', 1, 99, { damage: 5, mod: { nested: ['x', 3] } }); f.set(18, source);
  const operation = await f.tasks.prepareItem({ slot: 18, expected: source });
  assert.equal(operation.status, 'succeeded'); assert.equal(operation.result.hotbarSlot, 1); assert.equal(f.state.selectedSlot, 1);
  assert.deepEqual(f.calls.find(call => call.name === 'swap-inventory').args.expectedSource, source);
  assert.equal(f.state.inventory[18].id, 'minecraft:air'); assert.equal(f.owner(), undefined); assert.equal(f.results.length, 1);
});
test('prepare full hotbar requires explicit target and performs true guarded swap without losing displaced stack', async () => {
  const f = fixture(); for (let slot = 1; slot < 9; slot++) f.set(slot, item('stone', 32)); f.set(18, item('bread', 3));
  assert.equal((await f.tasks.prepareItem({ slot: 18 })).result.code, 'HOTBAR_FULL');
  assert.equal(f.calls.some(call => call.name === 'swap-inventory'), false);
  const target = clone(f.state.inventory[0]); assert.equal((await f.tasks.prepareItem({ slot: 18, targetSlot: 0 })).status, 'succeeded');
  assert.deepEqual(value(f.state.inventory[18]), value(target)); assert.equal(f.state.inventory[0].id, 'minecraft:bread');
});
test('assessed expected stack changed in count, components or effective maximum cannot be silently prepared', async () => {
  for (const change of [value => { value.count++; }, value => { value.components.named = true; }, value => { value.maxStackSize = 99; }]) {
    const f = fixture(), expected = item('bread', 4); f.set(18, expected); change(f.state.inventory[18]);
    const result = await f.tasks.prepareItem({ slot: 18, expected }); assert.equal(result.result.code, 'ITEM_CHANGED');
    assert.equal(f.calls.some(call => call.name === 'swap-inventory' || call.name === 'select-slot'), false);
  }
});
test('R6 unrelated incomplete inventory is tolerated, selected source/target missing guards are rejected', async () => {
  const f = fixture(); f.set(18, item('bread')); f.set(35, { ...item('unknown'), componentsComplete: false, componentError: 'codec unavailable' }); delete f.state.inventory[35].components;
  assert.equal((await f.tasks.prepareItem({ slot: 18 })).status, 'succeeded');
  assert.equal((await f.tasks.prepareItem({ slot: 35 })).result.code, 'INCOMPLETE_GUARD');
  const second = fixture(); second.set(18, item('bread')); second.state.inventory[1].componentsComplete = false;
  const result = await second.tasks.prepareItem({ slot: 18 }); assert.equal(result.result.code, 'INCOMPLETE_GUARD'); assert.equal(second.calls.some(call => call.name === 'swap-inventory'), false);
});
test('automatic eating fills selected hotbar when all slots occupied and never restores old tool', async () => {
  const f = fixture(); for (let slot = 1; slot < 9; slot++) f.set(slot, item('stone', 32)); f.set(18, item('bread', 3));
  const oldTool = value(f.state.inventory[0]), operation = await f.tasks.eat();
  assert.equal(operation.status, 'succeeded'); assert.equal(operation.result.consumedCount, 1); assert.equal(operation.result.consumption, 'confirmed');
  assert.equal(f.state.inventory[0].count, 2); assert.deepEqual(value(f.state.inventory[18]), oldTool);
  assert.equal(f.calls.filter(call => call.name === 'swap-inventory').length, 1); assert.equal(f.state.selectedSlot, 0);
});
test('explicit safe precious food can be eaten, unsafe or unknown native food still refused', async () => {
  const f = fixture(); f.set(1, item('golden_apple'));
  assert.equal((await f.tasks.eat()).result.code, 'ONLY_PRECIOUS_FOOD'); assert.equal((await f.tasks.eat({ slot: 1 })).status, 'succeeded');
  f.set(2, item('pufferfish')); assert.equal((await f.tasks.eat({ slot: 2 })).result.code, 'UNSAFE_FOOD');
  f.set(3, item('unknown_mod_food')); assert.equal((await f.tasks.eat({ slot: 3 })).result.code, 'UNSAFE_FOOD');
  assert.equal(f.calls.filter(call => call.name === 'eat-item').length, 1);
});
test('food consumption is established by native receipt including container return, not inventory/hunger net change', async () => {
  const f = fixture(); f.set(1, item('mushroom_stew', 1, 1)); f.state.food = 10;
  const result = await f.tasks.eat({ slot: 1 }); assert.equal(result.status, 'succeeded'); assert.equal(result.result.consumedCount, 1); assert.equal(f.state.inventory[1].id, 'minecraft:bowl');
  const invalid = fixture(); invalid.set(1, item('bread'));
  invalid.body.afterAct = (name, _args, op) => { if (name === 'eat-item') op.result = { foodAfter: 19 }; };
  const unknown = await invalid.tasks.eat({ slot: 1 }); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.result.consumedCount, 0);
  assert(invalid.owner()); assert.equal(invalid.tasks.read().state, 'blocked');
});
test('native unknown preserves confirmed lower bound and holds owned lock until explicit matching stop', async () => {
  const f = fixture(); f.set(1, item('bread')); f.body.unknownAction = 'eat-item';
  const unknown = await f.tasks.eat({ slot: 1 }); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.result.lastConfirmedConsumedCount, 1);
  await assert.rejects(f.tasks.prepareItem({ slot: 0 }), error => error.code === 'BUSY');
  const handle = f.tasks.cancel(); f.body.stopFails = true; await assert.rejects(f.body.stop());
  assert(f.owner()); assert.equal(f.tasks.read().state, 'stopping');
  f.body.stopFails = false; await f.body.stop(); assert.equal(f.tasks.stopped(handle), true); assert.equal(f.owner(), undefined);
});
test('native confirmed consumption is retained before a subsequent authority read failure', async () => {
  const f = fixture(); f.set(0, item('bread', 3));
  f.body.afterAct = name => { if (name === 'eat-item') f.body.beforeState = () => { throw Error('read unavailable'); }; };
  const operation = await f.tasks.eat({ slot: 0 }); assert.equal(operation.status, 'unknown'); assert.equal(operation.result.consumedCount, 1);
  assert.equal(operation.result.consumption, 'confirmed'); assert(f.owner()); assert.equal(f.calls.filter(call => call.name === 'eat-item').length, 1);
});
test('confirmed swap is retained before read failure with no inverse restoration or subsequent eating', async () => {
  const f = fixture(); f.set(18, item('bread', 3));
  f.body.afterAct = name => { if (name === 'swap-inventory') f.body.beforeState = () => { throw Error('lost observation'); }; };
  const operation = await f.tasks.eat({ slot: 18 }); assert.equal(operation.status, 'unknown'); assert.equal(operation.result.swapped, true);
  assert.equal(f.calls.filter(call => call.name === 'swap-inventory').length, 1); assert.equal(f.calls.some(call => call.name === 'eat-item'), false);
});
test('borrowed prepare/eat never reacquire, release or stop parent token even on unknown', async () => {
  const f = fixture(); f.set(18, item('bread', 3)); const owner = f.borrow('outer'); let checks = 0; owner.check = () => { checks++; };
  const prepared = await f.tasks.prepareItem({ slot: 18 }, owner); assert.equal(prepared.status, 'succeeded'); assert.equal(f.owner(), 'outer'); assert.equal(f.releases.length, 0);
  f.body.unknownAction = 'eat-item'; const result = await f.tasks.eat({ slot: 1 }, owner); assert.equal(result.status, 'unknown');
  assert(checks >= 8); assert.equal(f.owner(), 'outer'); assert.equal(f.releases.length, 0); assert.equal(f.calls.some(call => call.name === 'stop'), false);
  const handle = f.tasks.cancel(); await f.body.stop(); f.tasks.stopped(handle); assert.equal(f.owner(), 'outer');
});
test('borrowed owner cancellation during initial state read prevents first write', async () => {
  const f = fixture(); f.set(18, item('bread')); const owner = f.borrow('outer'), pending = gate(); let cancelled = false;
  owner.check = () => { if (cancelled) throw new BodyError('CANCELLED', 'parent cancelled'); };
  f.body.beforeState = () => pending.promise;
  const result = f.tasks.eat({ slot: 18 }, owner); await until(() => f.calls.some(call => call.name === 'state')); cancelled = true; pending.resolve();
  assert.equal((await result).status, 'cancelled'); assert.equal(f.calls.some(call => call.name === 'swap-inventory'), false); assert.equal(f.owner(), 'outer');
});
test('cancel while initial read is in flight retains owned barrier until ACK, then first new task survives old finally', async () => {
  const f = fixture(), oldGate = gate(); let reads = 0;
  f.body.beforeState = () => { if (++reads === 1) return oldGate.promise; };
  const old = f.tasks.prepareItem({ slot: 0 }); await until(() => reads === 1);
  const handle = f.tasks.cancel(); await assert.rejects(f.tasks.prepareItem({ slot: 0 }), error => error.code === 'BUSY');
  await f.body.stop(); f.tasks.stopped(handle);
  const newGate = gate(); f.body.beforeState = () => newGate.promise;
  const replacement = f.tasks.prepareItem({ slot: 0 }); const newOwner = f.owner(); oldGate.resolve();
  assert.equal((await old).status, 'cancelled'); assert.equal(f.owner(), newOwner);
  await assert.rejects(f.tasks.prepareItem({ slot: 0 }), error => error.code === 'BUSY');
  newGate.resolve(); assert.equal((await replacement).status, 'succeeded'); assert.equal(f.tasks.read().lastResult.operationId, (await replacement).operationId);
});
test('cancel during native swap blocks late eat/select and cannot release a replacement task', async () => {
  const f = fixture(); f.set(18, item('bread')); const hold = gate();
  f.body.beforeAct = name => name === 'swap-inventory' ? hold.promise : undefined;
  const old = f.tasks.eat({ slot: 18 }); await until(() => f.calls.some(call => call.name === 'swap-inventory'));
  const first = f.tasks.cancel(), second = f.tasks.cancel(); assert.equal(f.tasks.stopped(first), false); assert(f.owner());
  await f.body.stop(); f.tasks.stopped(second);
  const replacementGate = gate(); f.body.beforeState = () => replacementGate.promise;
  const replacement = f.tasks.prepareItem({ slot: 0 }), owner = f.owner(); hold.resolve();
  assert.equal((await old).status, 'cancelled'); assert.equal(f.owner(), owner); assert.equal(f.calls.some(call => call.name === 'eat-item'), false);
  replacementGate.resolve(); assert.equal((await replacement).status, 'succeeded');
});
test('session, world, dimension and generation changes across authority reads prevent further writes', async () => {
  for (const change of [state => { state.sessionId = 'other'; }, state => { state.worldId = 'other'; }, state => { state.dimension = 'minecraft:the_nether'; }, state => { state.controlGeneration++; }]) {
    const f = fixture(); f.set(18, item('bread')); f.body.afterAct = name => { if (name === 'swap-inventory') change(f.state); };
    const operation = await f.tasks.eat({ slot: 18 }); assert.equal(operation.status, 'unknown'); assert.equal(operation.result.code, 'WORLD_CHANGED');
    assert.equal(f.calls.some(call => call.name === 'eat-item' || call.name === 'select-slot'), false); assert(f.owner());
  }
});
test('eat binds full component/count/max source before preparation rather than eating a changed same-slot variant', async () => {
  const f = fixture(); f.set(0, item('bread', 3)); let reads = 0;
  f.body.beforeState = () => { if (++reads === 2) f.state.inventory[0].components.named = 'changed'; };
  const operation = await f.tasks.eat({ slot: 0 }); assert.equal(operation.result.code, 'ITEM_CHANGED'); assert.equal(f.calls.some(call => call.name === 'eat-item'), false);
});
test('pending native consumption completes once through operation polling, no second act', async () => {
  const f = fixture(); f.set(0, item('bread', 3)); f.body.runningAction = 'eat-item';
  f.body.beforeOperation = id => { const op = f.ops.get(id); f.consume(f.calls.find(call => call.name === 'eat-item').args); f.ops.set(id, { ...op, status: 'succeeded', result: { consumedCount: 1, consumption: 'confirmed' } }); };
  const operation = await f.tasks.eat({ slot: 0 }); assert.equal(operation.status, 'succeeded'); assert.equal(f.calls.filter(call => call.name === 'eat-item').length, 1);
});
test('pending operation lookup errors are unknown and keep write barrier', async () => {
  const f = fixture(); f.set(0, item('bread')); f.body.runningAction = 'eat-item'; f.body.beforeOperation = () => { throw new BodyError('OPERATION_NOT_FOUND', 'lost native operation'); };
  const operation = await f.tasks.eat({ slot: 0 }); assert.equal(operation.status, 'unknown'); assert(f.owner());
});
test('independent native timeout confirms stop before releasing; failed stop retains barrier', async () => {
  for (const stopFails of [false, true]) {
    const f = fixture(); f.body.clock = 0; f.set(0, item('bread')); f.body.runningAction = 'eat-item'; f.body.stopFails = stopFails;
    f.body.afterAct = name => { if (name === 'eat-item') f.body.clock = 501; };
    const operation = await f.tasks.eat({ slot: 0, timeoutMs: 500 }); assert.equal(operation.status, 'unknown');
    assert.equal(f.calls.filter(call => call.name === 'stop').length, 1); assert.equal(!!f.owner(), stopFails);
    if (stopFails) { assert.equal(operation.result.code, 'STOP_UNCONFIRMED'); await assert.rejects(f.tasks.prepareItem({ slot: 0 }), error => error.code === 'BUSY'); }
  }
});
test('borrowed timeout returns uncertain result without stopping/releasing parent', async () => {
  const f = fixture(); f.body.clock = 0; f.set(0, item('bread')); const owner = f.borrow('outer'); f.body.runningAction = 'eat-item';
  f.body.afterAct = name => { if (name === 'eat-item') f.body.clock = 501; };
  const operation = await f.tasks.eat({ slot: 0, timeoutMs: 500 }, owner); assert.equal(operation.status, 'unknown'); assert.equal(f.owner(), 'outer');
  assert.equal(f.calls.some(call => call.name === 'stop'), false); assert.equal(f.releases.length, 0);
});
test('old late terminal result cannot overwrite newer result summary', async () => {
  const f = fixture(), hold = gate(); f.body.beforeState = () => hold.promise;
  const old = f.tasks.prepareItem({ slot: 0 }); await until(() => f.calls.length > 0); const handle = f.tasks.cancel(); await f.body.stop(); f.tasks.stopped(handle);
  f.body.beforeState = undefined; const latest = await f.tasks.prepareItem({ slot: 0 }); hold.resolve(); assert.equal((await old).status, 'cancelled');
  assert.equal(f.tasks.read().lastResult.operationId, latest.operationId); assert.equal(f.tasks.stopped(handle), false);
});
test('missing capability/full details and invalid slot are refused without native writes', async () => {
  const f = fixture(); f.set(18, item('bread')); f.body.hello.capabilities = ['eat-item', 'select-slot'];
  assert.equal((await f.tasks.prepareItem({ slot: 18 })).result.code, 'UNSUPPORTED');
  f.body.overrideState = () => { const state = f.snapshot(); delete state.inventory; return state; };
  assert.equal((await f.tasks.eat()).result.code, 'INCOMPLETE_GUARD');
  await assert.rejects(f.tasks.prepareItem({ slot: 36 }), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(f.tasks.eat({ targetSlot: 9 }), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(f.calls.some(call => call.name === 'swap-inventory' || call.name === 'eat-item'), false);
});
test('eat total deadline includes initial read/preparation rather than granting a second full deadline', async () => {
  const f = fixture(); f.set(0, item('bread')); f.body.clock = 0; f.body.runningAction = 'eat-item';
  f.body.beforeState = () => { f.body.clock = 450; };
  f.body.afterAct = name => { if (name === 'eat-item') f.body.clock = 501; };
  const operation = await f.tasks.eat({ slot: 0, timeoutMs: 500 }); assert.equal(operation.status, 'unknown');
  assert.equal(f.calls.filter(call => call.name === 'stop').length, 1); assert.equal(f.owner(), undefined);
});
test('swap receipt followed by unserializable target is uncertain and retains confirmed swap without restoring', async () => {
  const f = fixture(); f.set(18, item('bread'));
  f.body.afterAct = name => { if (name === 'swap-inventory') { f.state.inventory[1].componentsComplete = false; delete f.state.inventory[1].components; } };
  const operation = await f.tasks.prepareItem({ slot: 18 }); assert.equal(operation.status, 'unknown'); assert.equal(operation.result.swapped, true);
  assert(f.owner()); assert.equal(f.calls.filter(call => call.name === 'swap-inventory').length, 1);
});
test('polling cannot accept a different operation UUID even if its consumption fields look valid', async () => {
  const f = fixture(); f.set(0, item('bread')); f.body.runningAction = 'eat-item';
  f.body.beforeOperation = id => { const op = f.ops.get(id); f.ops.set(id, { ...op, operationId: randomUUID(), status: 'succeeded', result: { consumedCount: 1, consumption: 'confirmed' } }); };
  const operation = await f.tasks.eat({ slot: 0 }); assert.equal(operation.status, 'unknown'); assert.equal(operation.result.consumedCount, 0); assert(f.owner());
});
test('confirmed native consumption arriving after stop is historical partial evidence and cannot clear new ownership', async () => {
  const f = fixture(); f.set(0, item('bread', 3)); const delayedReply = gate();
  f.body.afterAct = name => name === 'eat-item' ? delayedReply.promise : undefined;
  const old = f.tasks.eat({ slot: 0 }); await until(() => f.state.inventory[0].count === 2);
  const handle = f.tasks.cancel(); await f.body.stop(); f.tasks.stopped(handle);
  const delayedNewRead = gate(); f.body.beforeState = () => delayedNewRead.promise;
  const replacement = f.tasks.prepareItem({ slot: 0 }), owner = f.owner(); delayedReply.resolve();
  const cancelled = await old; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result.lastConfirmedConsumedCount, 1); assert.equal(cancelled.result.consumedCount, 1);
  assert.equal(f.owner(), owner); assert.equal(f.calls.filter(call => call.name === 'eat-item').length, 1);
  delayedNewRead.resolve(); assert.equal((await replacement).status, 'succeeded');
});
test('consumption receipt beyond deadline preserves real consumed count while timing out and stopping once', async () => {
  const f = fixture(); f.set(0, item('bread', 3)); f.body.clock = 0;
  f.body.afterAct = name => { if (name === 'eat-item') f.body.clock = 501; };
  const operation = await f.tasks.eat({ slot: 0, timeoutMs: 500 }); assert.equal(operation.status, 'unknown'); assert.equal(operation.result.consumedCount, 1);
  assert.equal(f.calls.filter(call => call.name === 'stop').length, 1); assert.equal(f.calls.filter(call => call.name === 'eat-item').length, 1); assert.equal(f.owner(), undefined);
});

test('precious food: never auto-eaten normally, ordinary food wins, emergency eats golden apple before enchanted', () => {
  const f = fixture(); f.set(1, item('enchanted_golden_apple')); f.set(2, item('golden_apple')); f.set(3, item('rotten_flesh'));
  let state = f.snapshot(); state.food = 4;
  assert.equal(selectFood(state).reason, 'ONLY_PRECIOUS_FOOD'); assert.equal(selectFood(state).slot, undefined);
  state.health = 9; assert.equal(selectFood(state, { lowHealth: 8 }).reason, 'ONLY_PRECIOUS_FOOD');
  state.health = 8; const pick = selectFood(state, { lowHealth: 8 });
  assert.equal(pick.slot, 2); assert.equal(pick.reason, 'EMERGENCY_PRECIOUS_FOOD'); assert.equal(pick.urgent, true);
  f.set(2, item('air', 0)); f.state.inventory[2] = { slot: 2, id: 'minecraft:air', count: 0, components: {} };
  state = f.snapshot(); state.food = 4; state.health = 3; assert.equal(selectFood(state).slot, 1);
  f.set(4, item('bread')); state = f.snapshot(); state.food = 4; state.health = 3; assert.equal(selectFood(state).slot, 4);
  state.food = 20; assert.equal(selectFood(state).reason, 'FULL');
  const rotten = fixture(); rotten.set(3, item('rotten_flesh')); const rs = rotten.snapshot(); rs.health = 2; rs.food = 2;
  assert.equal(selectFood(rs).reason, 'NO_SAFE_FOOD');
});
test('automatic eat() with only precious food and low health eats it; explicit rotten flesh is refused', async () => {
  const f = fixture(); f.set(1, item('golden_apple')); f.state.health = 5; f.state.food = 3;
  assert.equal((await f.tasks.eat({ policy: { lowHealth: 8 } })).status, 'succeeded');
  f.set(2, item('rotten_flesh')); assert.equal((await f.tasks.eat({ slot: 2 })).result.code, 'UNSAFE_FOOD');
  const g = fixture(); g.set(1, item('enchanted_golden_apple'));
  assert.equal((await g.tasks.eat({ policy: { lowHealth: 8 } })).result.code, 'ONLY_PRECIOUS_FOOD');
  assert.equal((await g.tasks.eat({ slot: 1 })).status, 'succeeded');
});

test('eating leaves the selection to eat-item: a guard re-selecting its bow in between does not fail the meal', async () => {
  const f = fixture(); f.set(2, item('bow', 1, 1)); f.set(18, item('cooked_beef', 5));
  // The guard takes the hand back (selects its bow) right after the food reaches the hotbar.
  f.body.afterAct = name => { if (name === 'swap-inventory') f.state.selectedSlot = 2; };
  const operation = await f.tasks.eat({ slot: 18 });
  assert.equal(operation.status, 'succeeded'); assert.equal(operation.result.consumedCount, 1);
  assert.ok(!f.calls.some(call => call.name === 'select-slot'), 'no separate select-slot step for eating');
  const eat = f.calls.find(call => call.name === 'eat-item'); assert.equal(eat.args.slot, 1); assert.equal(eat.args.expectedItem, 'minecraft:cooked_beef');
});
