import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientBody, parseConnection } from '../dist/client-body.js';
import { mockControl, observation } from './mock-control.mjs';

async function setup(t, overrides, options = {}) {
  const mock = await mockControl(overrides);
  t.after(() => mock.close());
  const body = await ClientBody.connect({ connection: mock.connection, username: 'ClientBot', worldId: 'test-world', heartbeatIntervalMs: 60000, ...options });
  t.after(() => body.close());
  return { mock, body };
}
test('connection rejects remote hosts, redirects, userinfo and alternate paths', () => {
  for (const endpoint of ['https://127.0.0.1/v1', 'http://example.com/v1', 'http://localhost/v1', 'http://127.0.0.1/v2', 'http://user@127.0.0.1/v1', 'http://127.0.0.1/v1?secret=x']) {
    assert.throws(() => parseConnection({ protocol: 1, endpoint, token: '1234567890123456' }));
  }
});
test('real HTTP handshake authenticates, protects namespace IDs and excludes concurrent body actions', async t => {
  const { mock, body } = await setup(t);
  assert.equal((await body.observe()).inventory[0].id, 'example:custom_block');
  const running = await body.act('follow-player', { player: 'Alex' });
  assert.equal(running.status, 'running');
  await assert.rejects(body.act('move-to-position', { x: 1, y: 64, z: 0 }), { code: 'BUSY' });
  assert.equal((await body.act('send-chat', { message: 'hello' })).status, 'succeeded');
  await body.stop();
  assert.equal((await body.operation(running.operationId)).status, 'cancelled');
  assert.equal((await body.act('look-at', { x: 1, y: 65, z: 0 })).status, 'succeeded');
  assert.ok(mock.calls.every(call => call.authorization === `Bearer ${mock.connection.token}`));
  assert.equal(mock.calls.filter(call => call.method === 'act' && call.params.name === 'move-to-position').length, 0);
});
test('stop bypasses pending action, fences its late receipt, and keeps the lease', async t => {
  let resolveAction;
  const order = [];
  const { mock, body } = await setup(t, {
    act: params => new Promise(resolve => { order.push('act'); resolveAction = () => resolve({ operationId: params.operationId, sessionId: params.sessionId, name: params.name, status: 'running', summary: 'late ack' }); }),
    stop: () => { order.push('stop'); return { stopped: true }; },
  });
  const action = body.act('follow-player', { player: 'Alex' });
  while (!resolveAction) await new Promise(resolve => setTimeout(resolve, 5));
  const stopping = body.stop();
  while (!order.includes('stop')) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(body.act('look-at', { x: 1, y: 2, z: 3 }), { code: 'BUSY' });
  resolveAction(); await action; await stopping;
  assert.deepEqual(order, ['act', 'stop', 'stop']);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
  await body.observe();
});
test('a severed mutation returns unknown, sends no retry and makes lease loss terminal', async t => {
  const losses = [];
  const { mock, body } = await setup(t, { act: (_params, { response }) => { response.destroy(); } }, { onLost: error => losses.push(error.code) });
  const result = await body.act('dig-block', { x: 1, y: 64, z: 0, expectedBlock: 'minecraft:stone' });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(losses, ['TRANSPORT_LOST']);
  await assert.rejects(body.act('look-at', { x: 0, y: 0, z: 0 }), { code: 'TRANSPORT_LOST' });
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
});
test('lease expiry rejects locally before mutation and does not silently renew', async t => {
  let now = 1000;
  const { mock, body } = await setup(t, undefined, { now: () => now });
  now += 10001;
  await assert.rejects(body.act('send-chat', { message: 'late' }), { code: 'LEASE_EXPIRED' });
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 0);
  await body.heartbeat();
  assert.equal(mock.calls.filter(call => call.method === 'heartbeat').length, 0);
});
test('changed world generation invalidates old handles and never reclaims', async t => {
  const { mock, body } = await setup(t);
  const operation = await body.act('follow-player', { player: 'Alex' });
  mock.setState(observation({ sessionId: 'world-session-2' }));
  await assert.rejects(body.observe(), { code: 'WORLD_CHANGED' });
  await assert.rejects(body.operation(operation.operationId), { code: 'WORLD_CHANGED' });
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
});
test('heartbeat transport loss ends control without replay', async t => {
  const { mock, body } = await setup(t, { heartbeat: (_params, { response }) => response.destroy() });
  await body.heartbeat();
  await assert.rejects(body.observe(), { code: 'TRANSPORT_LOST' });
  assert.equal(mock.calls.filter(call => call.method === 'heartbeat').length, 1);
});
test('explicit LEASE_BUSY may wait for old lease, but timed out claim is never retried', async t => {
  let attempts = 0;
  const first = await setup(t, { claim: () => { if (++attempts === 1) throw Object.assign(new Error('busy'), { code: 'LEASE_BUSY' }); return { leaseId: 'lease', ttlMs: 10000 }; } });
  assert.equal(attempts, 2); await first.body.close();
  const mock = await mockControl({ claim: (_params, { response }) => response.destroy() });
  t.after(() => mock.close());
  await assert.rejects(ClientBody.connect({ connection: mock.connection, username: 'ClientBot', worldId: 'test-world' }), { code: 'TRANSPORT_LOST' });
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
});
test('normal chat rejects commands locally, terminal results preserve unknown rather than success', async t => {
  const { mock, body } = await setup(t, { act: params => ({ operationId: params.operationId, sessionId: params.sessionId, name: params.name, status: 'unknown', summary: 'client predicted; server confirmation unavailable' }) });
  await assert.rejects(body.act('send-chat', { message: '/op ClientBot' }), { code: 'INVALID_ARGUMENT' });
  const result = await body.act('place-block', { x: 1, y: 64, z: 0, face: 'up', slot: 0, expectedItem: 'example:custom_block', expectedBlock: 'minecraft:stone' });
  assert.equal(result.status, 'unknown');
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 1);
});
