import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerBody } from '../dist/server-body.js';
import { summarizeObservation } from '../dist/model-view.js';
import { mockServerControl } from './mock-server-control.mjs';
import { randomUUID } from 'node:crypto';
const identity = { instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 0 };
const food = { slot: 12, id: 'minecraft:bread', count: 3, nutrition: 5, saturationModifier: 0.6, eatDurationTicks: 32, safe: true };
const survival = () => ({ ...identity, serverTick: 20, observedAt: 1000, health: 20, maxHealth: 20, food: 10, saturation: 0, selectedSlot: 0, foods: [food] });
async function setup(t) {
  const mock = await mockServerControl(); const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['look-at', 'send-chat', 'survival-state', 'assess-tool', 'swap-inventory', 'eat-item'] });
  mock.handlers['survival-state'] = () => survival();
  t.after(() => mock.close());
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close()); return { body, mock };
}
test('compact survival and explicit incomplete inventory are readable without weakening write guards', async t => {
  const { body, mock } = await setup(t);
  assert.equal((await body.survivalState({ details: false })).foods[0].slot, 12);
  const opaque = { slot: 12, id: 'example:opaque', count: 1, componentsComplete: false, componentError: 'UNSUPPORTED' };
  mock.setState({ inventory: [opaque] });
  const state = await body.observe(); assert.deepEqual(state.inventory, [opaque]);
  assert.equal(summarizeObservation(state).inventory[0].actionable, false);
  await assert.rejects(body.act('eat-item', { slot: 0, expectedItem: opaque.id, expectedCount: 1 }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await body.act('send-chat', { message: 'still usable' })).status, 'succeeded');
  assert.equal(mock.calls.filter(call => call.method === 'act' && call.params.name === 'eat-item').length, 0);
});
test('opaque components cannot be disguised as an empty guard object', async t => {
  const { body, mock } = await setup(t);
  mock.setState({ inventory: [{ slot: 0, id: 'example:opaque', count: 1, componentsComplete: false, components: {} }] });
  await assert.rejects(body.observe(), { code: 'INVALID_RESPONSE' });
});
test('late survival observation across stop is rejected without losing the new usable generation', async t => {
  const { body, mock } = await setup(t); let resolve, entered;
  const started = new Promise(r => { entered = r; });
  mock.handlers['survival-state'] = () => { entered(); return new Promise(r => { resolve = r; }); };
  const observed = body.survivalState(); const rejected = assert.rejects(observed, { code: 'CANCELLED' });
  await started; await body.stop(); resolve(survival()); await rejected;
  assert.equal((await body.act('send-chat', { message: 'new generation' })).status, 'succeeded');
});
test('tool assessment accepts explicit unknown speed and expected lookup rejection preserves control', async t => {
  const { body, mock } = await setup(t);
  mock.handlers['assess-tool'] = () => ({ ...identity, position: { x: 1, y: 64, z: 1 }, blockId: 'example:ore', properties: {}, requiresCorrectTool: true, notes: ['unknown mod hook'], candidates: [{ slot: 0, id: 'example:tool', count: 1, componentsComplete: false, eligible: null, baseSpeed: null, estimatedTicks: null, remainingDurability: null, estimate: 'unknown' }] });
  assert.equal((await body.assessTool({ x: 1, y: 64, z: 1 })).candidates[0].eligible, null);
  for (const code of ['UNLOADED', 'STALE_BLOCK']) {
    mock.handlers['assess-tool'] = () => { throw Object.assign(new Error('refused'), { code }); };
    await assert.rejects(body.assessTool({ x: 1, y: 64, z: 1 }), { code });
    assert.equal((await body.act('send-chat', { message: 'continue' })).status, 'succeeded');
  }
});

test('threat parser preserves native hostility and explicit unavailable facts without inventing safe values', async t => {
  const { body, mock } = await setup(t);
  const facts = { ...survival(), threats: { radius: 8, serverTick: 20, complete: false, nearby: [
    { entityId: randomUUID(), type: 'minecraft:zombie', classification: 'hostile', hostilitySource: 'vanilla_hostile_allowlist', targetingSelf: false, distance: 2, lineOfSight: true, alive: true, explosionPreparing: false, defenseEligible: true, defenseReason: null, factsAvailable: true },
    { entityId: randomUUID(), type: null, classification: 'unknown', hostilitySource: 'unknown', targetingSelf: null, distance: null, lineOfSight: null, alive: null, explosionPreparing: null, defenseEligible: false, defenseReason: 'NATIVE_FACTS_UNAVAILABLE', factsAvailable: false }
  ] } };
  mock.handlers['survival-state'] = () => facts;
  const read = await body.survivalState(); assert.deepEqual(read.threats, facts.threats); assert.equal(read.threats.nearby[1].distance, null);
});
