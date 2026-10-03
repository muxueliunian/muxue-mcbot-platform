import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CompanionMode } from '../dist/companion-mode.js';
import { ContainerTasks } from '../dist/tasks.js';
import { ServerBody } from '../dist/server-body.js';
import { BodyError } from '../dist/body.js';
import { createMcpServer } from '../dist/mcp.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl } from './mock-server-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
async function fixture(t) {
  const playerId = randomUUID();
  const mock = await mockServerControl();
  mock.setState({ entities: [{ id: playerId, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'follow-companion', 'nearby-blocks'] });
  const act = mock.handlers.act;
  mock.handlers.act = (params, ctx) => {
    const op = act(params, ctx);
    if (params.name !== 'follow-companion') return op;
    const following = { ...op, status: 'running', result: { ...params.args, distance: params.args.distance ?? 2.5, state: 'following', position: { x: 0, y: 64, z: 0 } } };
    ctx.operations.set(op.operationId, following); return following;
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const events = new EventJournal();
  const mode = new CompanionMode(body, events);
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: () => {} });
  t.after(async () => { monitor.stop(); await body.close(); await mock.close(); });
  return { mock, body, events, mode, monitor, playerId, follow: async () => {
    const accepted = await mode.request({ action: 'follow', player: 'Alex' });
    await until(() => mode.snapshot().stage === 'active'); return accepted;
  } };
}
test('persistent follow returns accepted, owns shared task lock, allows chat/read and is never replayed by background refresh', async t => {
  const f = await fixture(t);
  const accepted = await f.follow();
  assert.equal(accepted.state, 'following'); assert.equal(accepted.stage, 'starting');
  assert.equal(f.body.hello.capabilities.includes('follow-companion'), true);
  assert.equal(f.body.pendingOperations().length, 0, 'internal mode action is monitored by the shared mode');
  await assert.rejects(f.body.act('look-at', { x: 1, y: 64, z: 0 }), { code: 'BUSY' });
  assert.throws(() => f.body.acquireTask('finite'), { code: 'BUSY' });
  assert.equal((await f.body.act('send-chat', { message: '聊天不中断陪伴' })).status, 'succeeded');
  assert.equal((await f.body.observe()).connected, true);
  const op = f.mock.operations.get(f.mode.snapshot().operationId);
  for (const state of ['waiting', 'following', 'waiting']) {
    f.mock.operations.set(op.operationId, { ...op, result: { ...op.result, state } });
    await f.monitor.tick(); assert.equal(f.mode.snapshot().state, state);
  }
  assert.equal(f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').length, 1);
  assert.equal(f.events.since(0, ['companion']).length, 0);
  assert.equal(f.events.since(0, ['task']).length, 0);
  assert.equal(f.events.since(0, ['companion_state']).length, 1);
});
test('wait confirms old follow stopped and keeps write lock; pause releases and explicit resume rechecks identity', async t => {
  const f = await fixture(t); await f.follow();
  const id = f.mode.snapshot().operationId;
  assert.equal((await f.mode.request({ action: 'wait' })).state, 'waiting');
  assert.equal(f.mock.operations.get(id).status, 'cancelled');
  assert.equal(f.mock.calls.filter(call => call.method === 'stop').length, 1);
  assert.throws(() => f.body.acquireTask('finite'), { code: 'BUSY' });
  assert.equal((await f.mode.request({ action: 'pause', say: '我先停在这里' })).state, 'paused');
  assert.equal(f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'send-chat').at(-1).params.args.message, '我先停在这里');
  f.body.acquireTask('finite');
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'BUSY' });
  assert.equal(f.mode.snapshot().state, 'paused', 'a refused lock cannot consume paused intent');
  f.body.releaseTask('finite');
  assert.equal((await f.mode.request({ action: 'resume' })).state, 'waiting');
  await f.mode.stop(); await f.follow(); await f.mode.request({ action: 'pause' });
  f.mock.setState({ entities: [{ id: randomUUID(), name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  const before = f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').length;
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'STALE_TARGET' });
  assert.equal(f.mode.snapshot().state, 'blocked');
  assert.equal(f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').length, before);
});
test('pause allows finite tasks and new atomic work; stopped mode never resumes', async t => {
  const f = await fixture(t); await f.follow(); await f.mode.request({ action: 'pause' });
  const tasks = new ContainerTasks(f.body);
  const finite = await tasks.run('give-item', { item: 'example:custom_block', count: 1, player: 'missing' });
  assert.equal(finite.result.code, 'PLAYER_NOT_VISIBLE');
  assert.equal((await f.body.act('look-at', { x: 1, y: 64, z: 0 })).status, 'succeeded');
  await f.mode.request({ action: 'resume' }); await until(() => f.mode.snapshot().stage === 'active');
  await f.mode.stop();
  assert.deepEqual(f.mode.snapshot(), { state: 'stopped' });
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
  assert.equal((await f.body.act('look-at', { x: 1, y: 64, z: 0 })).status, 'succeeded');
});
test('explicit follow replacement stops the old operation before a new one; failed replacement cannot restore the old intent', async t => {
  const f = await fixture(t); await f.follow();
  const first = f.mode.snapshot().operationId;
  await f.mode.request({ action: 'follow', player: 'Alex', distance: 4 });
  await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.mock.operations.get(first).status, 'cancelled');
  assert.equal(f.mode.snapshot().distance, 4);
  const writes = f.mock.calls.filter(call => call.method === 'stop' || (call.method === 'act' && call.params.name === 'follow-companion'));
  assert.deepEqual(writes.map(call => call.method), ['act', 'stop', 'act']);
  await assert.rejects(f.mode.request({ action: 'follow', player: 'Missing' }), { code: 'PLAYER_NOT_VISIBLE' });
  assert.equal(f.mode.snapshot().state, 'blocked'); assert.equal(f.mode.snapshot().intent, undefined);
  await f.monitor.tick();
  assert.equal((await f.body.observe()).connected, true, 'a failed replacement does not poison the control lease');
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
});
test('blocked background follow emits one notification and resumes only on an explicit checked request', async t => {
  const f = await fixture(t); await f.follow();
  const id = f.mode.snapshot().operationId, old = f.mock.operations.get(id);
  f.mock.operations.set(id, { ...old, status: 'failed', summary: '路径受阻', result: { ...old.result, code: 'NO_PATH' } });
  await f.monitor.tick(); await f.monitor.tick(); await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'blocked'); assert.equal(f.mode.snapshot().code, 'NO_PATH');
  assert.equal(f.events.since(0, ['companion']).length, 1);
  assert.equal(f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').length, 1);
  await f.mode.request({ action: 'resume' }); await until(() => f.mode.snapshot().stage === 'active');
  assert.notEqual(f.mode.snapshot().operationId, id);
  assert.equal(f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').length, 2);
});
test('terminal companion results delivered before or after monitor notification never wake twice', async t => {
  for (const pollFirst of [true, false]) {
    const f = await fixture(t); await f.follow();
    const id = f.mode.snapshot().operationId, old = f.mock.operations.get(id);
    f.mock.operations.set(id, { ...old, status: 'failed', summary: '路径受阻', result: { ...old.result, code: 'NO_PATH' } });
    if (pollFirst) f.events.deliverOperation(await f.body.operation(id));
    await f.monitor.tick();
    const notifications = f.events.since(0, ['companion']);
    assert.equal(notifications.length, pollFirst ? 0 : 1);
    if (!pollFirst) assert.equal(notifications[0].operationId, id);
    assert.equal(f.mode.read().state, 'blocked');
    assert.equal(f.events.since(0, ['companion']).length, 0, 'a read-only state tool delivers the terminal fact');
    await f.monitor.tick(); assert.equal(f.events.since(0, ['companion']).length, 0);
  }
});
test('host loss while paused discards intent once; session or generation changes forbid resurrection', async t => {
  const f = await fixture(t); await f.follow(); await f.mode.request({ action: 'pause' });
  f.mode.fail(new BodyError('HOST_LOST', '宿主已离线')); f.mode.fail(new BodyError('HOST_LOST', '宿主已离线'));
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().intent, undefined);
  assert.equal(f.events.since(0, ['companion']).length, 1);
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
  for (const field of ['sessionId', 'controlGeneration']) {
    const other = await fixture(t); await other.follow(); await other.mode.request({ action: 'pause' });
    if (field === 'sessionId') other.mock.setState({ sessionId: 'new-session' }); else other.mock.setGeneration(99);
    await assert.rejects(other.mode.request({ action: 'resume' }), { code: field === 'sessionId' ? 'WORLD_CHANGED' : 'STALE_CONTROL' });
    assert.equal(other.mode.snapshot().intent, undefined);
    assert.equal(other.mode.snapshot().state, 'stopped');
  }
});
test('a monitor observation begun before pause cannot invalidate the new paused generation', async t => {
  const f = await fixture(t); await f.follow();
  const observe = f.mock.handlers.observe;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  let first = true;
  f.mock.handlers.observe = async params => {
    const old = observe(params);
    if (first) { first = false; entered(); await gate; }
    return old;
  };
  const tick = f.monitor.tick(); await seen;
  await f.mode.request({ action: 'pause' });
  assert.equal(f.mode.snapshot().state, 'paused');
  release(); await tick;
  assert.equal(f.mode.snapshot().state, 'paused');
  assert.equal(f.events.since(0, ['companion']).length, 0);
  assert.equal((await f.body.observe()).connected, true);
  await f.mode.request({ action: 'resume' }); await until(() => f.mode.snapshot().stage === 'active');
});
test('fatal monitor errors discard paused intent even for a transport code outside normal companion failures', async t => {
  const f = await fixture(t); await f.follow(); await f.mode.request({ action: 'pause' });
  f.mock.handlers.observe = () => { throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }); };
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().intent, undefined);
  assert.equal(f.mode.snapshot().code, 'FORBIDDEN');
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
});
test('monitor skips starting an observation while pause is waiting for stop confirmation', async t => {
  const f = await fixture(t); await f.follow();
  const stop = f.mock.handlers.stop;
  let releaseStop, entered;
  const gate = new Promise(resolve => { releaseStop = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  f.mock.handlers.stop = async params => { entered(); await gate; return stop(params); };
  const pausing = f.mode.request({ action: 'pause' }); await seen;
  const reads = f.mock.calls.filter(call => call.method === 'observe').length;
  await f.monitor.tick();
  const skipped = f.mock.calls.filter(call => call.method === 'observe').length === reads;
  releaseStop(); await pausing;
  assert.equal(skipped, true, 'a transition has no stable observation token');
  assert.equal(f.mode.snapshot().state, 'paused');
  await f.monitor.tick();
  assert.ok(f.mock.calls.filter(call => call.method === 'observe').length > reads);
  assert.equal((await f.body.observe()).connected, true);
});
test('a Body observation started during an own stop cannot lose the lease when its old-generation reply arrives after confirmation', async t => {
  const f = await fixture(t); await f.follow();
  const stop = f.mock.handlers.stop, observe = f.mock.handlers.observe;
  let releaseStop, releaseRead, enteredStop, enteredRead;
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const stopSeen = new Promise(resolve => { enteredStop = resolve; });
  const readSeen = new Promise(resolve => { enteredRead = resolve; });
  f.mock.handlers.stop = async params => { enteredStop(); await stopGate; return stop(params); };
  let first = true;
  f.mock.handlers.observe = async params => {
    const old = observe(params);
    if (first) { first = false; enteredRead(); await readGate; }
    return old;
  };
  const stopping = f.body.stop(); await stopSeen;
  // Attach failure handling before the old read is released, even in the intentionally failing version.
  const reading = f.body.observe().then(value => ({ value }), error => ({ error })); await readSeen;
  releaseStop(); await stopping;
  releaseRead(); const result = await reading;
  assert.equal(result.error, undefined);
  assert.equal(result.value.controlGeneration, 0, 'this is explicitly the old read, not an adopted generation');
  assert.equal((await f.body.observe()).controlGeneration, 1);
  assert.equal((await f.body.act('send-chat', { message: '停止后仍可聊天' })).status, 'succeeded');
});
test('stop fences an in-flight follow receipt and prevents delayed action from restoring old mode', async t => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  const act = f.mock.handlers.act;
  f.mock.handlers.act = async (params, ctx) => {
    if (params.name !== 'follow-companion') return act(params, ctx);
    const op = act(params, ctx); entered(); await gate; return op;
  };
  await f.mode.request({ action: 'follow', player: 'Alex' }); await seen;
  await f.mode.stop();
  assert.deepEqual(f.mode.snapshot(), { state: 'stopped' });
  assert.equal(f.mock.operations.values().next().value.status, 'cancelled');
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
  // The stop generation already fences the delayed act; a new intent need not wait for its HTTP receipt.
  const accepted = await f.mode.request({ action: 'follow', player: 'Alex' });
  assert.equal(accepted.stage, 'starting');
  await until(() => f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').length === 2);
  release(); await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.mode.snapshot().state, 'following');
  assert.equal(f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').length, 2);
});
test('stop during initial observation sends no late follow and release waits for cancellation', async t => {
  const f = await fixture(t);
  const observe = f.body.observe.bind(f.body);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  let first = true;
  f.body.observe = async (...args) => { const state = await observe(...args); if (first) { first = false; entered(); await gate; } return state; };
  const request = f.mode.request({ action: 'follow', player: 'Alex' });
  // Attach the rejection handler before allowing the cancelled request to settle.
  const rejected = assert.rejects(request, { code: 'CANCELLED' });
  await seen; await f.mode.stop(); release(); await rejected;
  assert.equal(f.mock.calls.filter(call => call.method === 'act').length, 0);
  await f.follow();
});
test('HTTP follow guard requires UUID and distance bounds and forbids timeout-based fallback', async t => {
  const f = await fixture(t);
  for (const args of [{ player: 'Alex' }, { player: 'Alex', expectedEntityId: 'wrong' }, { player: 'Alex', expectedEntityId: f.playerId, distance: 1 }, { player: 'Alex', expectedEntityId: f.playerId, distance: 7 }, { player: 'Alex', expectedEntityId: f.playerId, timeoutMs: 60000 }]) {
    await assert.rejects(f.body.act('follow-companion', args), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(f.mock.calls.filter(call => call.method === 'act').length, 0);
});
test('MCP advertises exactly two companion tools with new cap, queries are read-only and stop clears intent', async t => {
  const f = await fixture(t);
  const server = createMcpServer(f.body, f.events, { companion: f.mode });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'companion-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('companion-mode')); assert.ok(names.includes('get-companion-mode')); assert.ok(!names.includes('follow-companion'));
  const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  assert.deepEqual(await call('get-companion-mode'), { state: 'idle' });
  assert.equal((await call('companion-mode', { action: 'follow', player: 'Alex', say: '我跟着你' })).stage, 'starting');
  await until(() => f.mode.snapshot().stage === 'active');
  const before = f.mock.calls.filter(call => call.method === 'act').length;
  assert.equal((await call('get-status')).companionMode.intent, 'follow');
  assert.equal((await call('get-companion-mode')).intent, 'follow');
  assert.equal(f.mock.calls.filter(call => call.method === 'act').length, before);
  assert.equal((await client.callTool({ name: 'look-at', arguments: { x: 1, y: 64, z: 0 } })).isError, true);
  assert.equal((await client.callTool({ name: 'send-chat', arguments: { message: '仍可聊天' } })).isError, undefined);
  assert.deepEqual(await call('stop-action'), { stopped: true });
  assert.deepEqual(await call('get-companion-mode'), { state: 'stopped' });
  assert.equal((await client.callTool({ name: 'companion-mode', arguments: { action: 'resume' } })).isError, true);
  f.body.hello.capabilities = f.body.hello.capabilities.filter(cap => cap !== 'follow-companion');
  const legacy = createMcpServer(f.body, new EventJournal());
  const [legacyLeft, legacyRight] = InMemoryTransport.createLinkedPair();
  const legacyClient = new Client({ name: 'legacy-test', version: '1' });
  await legacy.connect(legacyLeft); await legacyClient.connect(legacyRight);
  t.after(async () => { await legacyClient.close(); await legacy.close(); });
  assert.ok(!(await legacyClient.listTools()).tools.some(tool => ['companion-mode', 'get-companion-mode'].includes(tool.name)));
});
