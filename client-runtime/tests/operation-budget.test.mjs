import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerBody } from '../dist/server-body.js';
import { summarizeObservation, summarizeOperation } from '../dist/model-view.js';
import { mockServerControl } from './mock-server-control.mjs';

const budget = used => ({ used, remaining: 4096 - used, limit: 4096, exhausted: used === 4096 });
async function setup(t, overrides = {}) {
  const mock = await mockServerControl(overrides);
  t.after(() => mock.close());
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { mock, body };
}

test('lease budget survives HTTP parsing and compact status/action projection without becoming authority', async t => {
  const { mock, body } = await setup(t);
  for (const used of [0, 4095, 4096]) {
    const actual = budget(used);
    mock.setState({ operationBudget: actual });
    const state = await body.observe();
    assert.deepEqual(state.operationBudget, actual);
    assert.deepEqual(summarizeObservation(state).operationBudget, actual);
  }
  const act = mock.handlers.act;
  mock.handlers.act = (params, context) => ({ ...act(params, context), operationBudget: budget(17) });
  const operation = await body.act('look-at', { x: 1, y: 64, z: 0 });
  assert.deepEqual(operation.operationBudget, budget(17));
  assert.deepEqual(summarizeOperation(operation).operationBudget, budget(17));
  // An operation query reports the current lease budget, not the operation's historical cost.
  const query = mock.handlers.operation;
  mock.handlers.operation = (params, context) => ({ ...query(params, context), operationBudget: budget(18) });
  assert.deepEqual((await body.operation(operation.operationId)).operationBudget, budget(18));
  const sent = mock.calls.filter(call => call.method === 'act');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.operationBudget, undefined);
});

test('operation admission exhaustion leaves diagnostics and independent stop usable without re-claim or retry', async t => {
  const { mock, body } = await setup(t);
  mock.setState({ operationBudget: budget(4096) });
  mock.handlers.act = () => { throw Object.assign(new Error('All 4096 IDs used; release and explicitly claim again'), { code: 'OPERATION_LIMIT' }); };
  await assert.rejects(body.act('look-at', { x: 1, y: 64, z: 0 }), error => error.code === 'OPERATION_LIMIT' && error.message.includes('明确释放并重新接管'));
  assert.deepEqual((await body.observe()).operationBudget, budget(4096));
  assert.deepEqual(await body.stop(), { stopped: true });
  const state = await body.observe();
  assert.equal(state.controlGeneration, 1);
  assert.deepEqual(state.operationBudget, budget(4096));
  assert.equal(body.isBusy(), false);
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'release').length, 0);
});

test('older server observations without budget stay compatible and do not invent remaining capacity', async t => {
  const { body } = await setup(t);
  const state = await body.observe();
  assert.equal(state.operationBudget, undefined);
  assert.equal('operationBudget' in summarizeObservation(state), false);
  const operation = await body.act('look-at', { x: 1, y: 64, z: 0 });
  assert.equal('operationBudget' in summarizeOperation(operation), false);
});

for (const invalid of [
  { ...budget(10), used: -1 }, { ...budget(10), used: 1.5 },
  { ...budget(10), remaining: 4087 }, { ...budget(4096), exhausted: false },
  { used: 0, remaining: 0, limit: 0, exhausted: true },
]) test(`inconsistent budget is rejected rather than reported to the agent: ${JSON.stringify(invalid)}`, async t => {
  const { mock, body } = await setup(t);
  mock.setState({ operationBudget: invalid });
  await assert.rejects(body.observe(), { code: 'INVALID_RESPONSE' });
});

test('compact survival reads retain operation budget without requiring full inventory', async t => {
  const { mock, body } = await setup(t, {
    hello: () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
      capabilities: ['survival-state'], platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: 'test' } }),
    'survival-state': () => ({ instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 0,
      serverTick: 10, observedAt: 1000, health: 20, maxHealth: 20, food: 20, saturation: 5, selectedSlot: 0, foods: [], operationBudget: budget(4095) }),
  });
  const state = await body.survivalState({ details: false });
  assert.deepEqual(state.operationBudget, budget(4095));
  assert.equal(state.inventory, undefined);
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 0);
});
