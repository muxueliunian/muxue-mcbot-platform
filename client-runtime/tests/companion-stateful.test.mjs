import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CompanionMode } from '../dist/companion-mode.js';
import { ContainerTasks } from '../dist/tasks.js';
import { GatherTasks } from '../dist/gather-tasks.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { companionReflexHooks, createActionStop } from '../dist/action-stop.js';
import { mockServerControl } from './mock-server-control.mjs';

// Following is a state, not a task: tools that use the body make it step aside (paused + suspendedFor) and it picks up again by itself.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
const idleGuard = { state: 'idle', hits: 0, kills: 0, shots: 0, retreats: 0, damage: 0 };
async function fixture(t, { guard = true } = {}) {
  const mock = await mockServerControl();
  const player = { id: randomUUID(), name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } };
  mock.setState({ entities: [player] });
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'follow-companion', 'nearby-blocks', ...(guard ? ['companion-guard'] : [])] });
  const act = mock.handlers.act;
  mock.handlers.act = (params, ctx) => {
    const op = act(params, ctx);
    if (params.name !== 'follow-companion') return op;
    const { guard: options, ...args } = params.args;
    const following = { ...op, status: 'running', result: { ...args, distance: args.distance ?? 2.5, state: 'following', position: { x: 0, y: 64, z: 0 }, ...(options ? { guard: { ...idleGuard, options } } : {}) } };
    ctx.operations.set(op.operationId, following); return following;
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const events = new EventJournal();
  const mode = new CompanionMode(body, events);
  mode.resumeDelayMs = 0;
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: () => {} });
  const server = createMcpServer(body, events, { companion: mode });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'stateful-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { monitor.stop(); await client.close(); await server.close(); await body.close(); await mock.close(); });
  const sent = () => mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').map(call => call.params.args);
  const stops = () => mock.calls.filter(call => call.method === 'stop').length;
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); const text = result.content[0].text; let parsed; try { parsed = JSON.parse(text); } catch { parsed = { message: text }; } return { isError: result.isError, ...parsed }; };
  /** Ends the walk the mock keeps "running" until told otherwise; the monitor then notices on its next polls. */
  const finishMove = () => { for (const [id, op] of mock.operations) if (op.name === 'move-to-position' && op.status === 'running') mock.operations.set(id, { ...op, status: 'succeeded' }); };
  const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await monitor.tick(); };
  const follow = async request => { await mode.request({ action: 'follow', player: 'Alex', ...request }); await until(() => mode.snapshot().stage === 'active'); };
  return { mock, body, events, mode, monitor, client, player, sent, stops, call, finishMove, ticks, follow };
}
const moveTo = { x: 1, y: 64, z: 0 };

test('a tool that uses the body makes the follow step aside, and it picks up again by itself once the walk ends', async t => {
  const f = await fixture(t); await f.follow();
  assert.equal(f.mode.snapshot().guardEnabled, true);
  const moved = await f.call('move-to-position', moveTo);
  assert.equal(moved.isError, undefined, 'a body tool is not refused while following');
  let snapshot = f.mode.snapshot();
  assert.deepEqual([snapshot.state, snapshot.intent, snapshot.player, snapshot.suspendedFor, snapshot.guardEnabled], ['paused', 'follow', 'Alex', 'move-to-position', true]);
  assert.match(snapshot.reason, /自动接着跟/);
  assert.equal((await f.call('get-companion-mode')).suspendedFor, 'move-to-position');
  assert.equal((await f.call('get-status')).companionMode.suspendedFor, 'move-to-position');
  await f.ticks(); assert.equal(f.mode.snapshot().state, 'paused', 'a walk that is still running keeps the follow aside');
  assert.equal(f.sent().length, 1);
  f.finishMove(); await f.ticks();
  await until(() => f.mode.snapshot().stage === 'active');
  snapshot = f.mode.snapshot();
  assert.deepEqual([snapshot.state, snapshot.suspendedFor, snapshot.guardEnabled], ['following', undefined, true]);
  assert.equal(f.sent().length, 2, 'the same follow intent is submitted once more');
  assert.deepEqual(f.sent()[1], f.sent()[0], 'with the same player, distance and guard');
  const states = f.events.since(0, ['companion_state']).map(event => JSON.parse(event.text));
  assert.ok(states.some(state => state.state === 'paused' && state.suspendedFor === 'move-to-position'), 'the step-aside is in the companion_state events');
  assert.equal(states.at(-1).state, 'following');
});

test('a refused call does not move the follow, and quick calls in a row wait for the grace period before it walks off again', async t => {
  const f = await fixture(t); await f.follow();
  assert.equal((await f.call('move-to-position', { x: 'oops', y: 64, z: 0 })).isError, true);
  assert.equal(f.mode.snapshot().state, 'following');
  f.mode.resumeDelayMs = 60000;
  assert.equal((await f.call('look-at', moveTo)).isError, undefined);
  await f.ticks();
  assert.equal(f.mode.snapshot().state, 'paused', 'inside the grace period');
  assert.equal(f.mode.snapshot().suspendedFor, 'look-at');
  assert.equal((await f.call('look-at', moveTo)).isError, undefined, 'the next tool call just keeps it aside');
  assert.equal(f.sent().length, 1);
});

test('stop-action ends the follow for good: nothing picks it up when the walk ends', async t => {
  const f = await fixture(t); await f.follow();
  await f.call('move-to-position', moveTo);
  assert.deepEqual(await f.call('stop-action'), { isError: undefined, stopped: true });
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().intent, undefined);
  f.finishMove(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.sent().length, 1);
});

test('a manual pause stays paused until resume, also across other tools and when made while stepping aside', async t => {
  const f = await fixture(t); await f.follow();
  await f.mode.request({ action: 'pause' });
  assert.equal(f.mode.snapshot().suspendedFor, undefined);
  await f.call('move-to-position', moveTo); f.finishMove(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.mode.snapshot().suspendedFor, undefined); assert.equal(f.sent().length, 1);
  await f.mode.request({ action: 'resume' }); await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.sent().length, 2);
  // pause while a tool has it stepping aside: now the model owns the decision
  await f.call('move-to-position', moveTo);
  assert.equal(f.mode.snapshot().suspendedFor, 'move-to-position');
  await f.mode.request({ action: 'pause' });
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.mode.snapshot().suspendedFor, undefined);
  f.finishMove(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.sent().length, 2);
});

test('companion-mode stop ends the follow without interrupting what else is running', async t => {
  const f = await fixture(t); await f.follow();
  const stopsBefore = f.stops();
  const ended = await f.call('companion-mode', { action: 'stop' });
  assert.equal(ended.state, 'stopped'); assert.match(ended.reason, /已结束/);
  assert.equal(f.mode.snapshot().intent, undefined); assert.ok(f.stops() > stopsBefore, 'the running follow itself was stopped');
  // while stepping aside for a walk: the walk keeps running and the follow does not come back
  await f.follow();
  await f.call('move-to-position', moveTo);
  const walk = [...f.mock.operations.values()].find(op => op.name === 'move-to-position');
  const stopsBeforeSecond = f.stops();
  const second = await f.call('companion-mode', { action: 'stop', say: '不跟了' });
  assert.equal(second.state, 'stopped'); assert.match(second.reason, /不受影响/);
  assert.equal(f.stops(), stopsBeforeSecond, 'no body stop');
  assert.equal(f.mock.operations.get(walk.operationId).status, 'running', 'the walk was not interrupted');
  f.finishMove(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.sent().length, 2);
  // nothing to end
  const none = await f.call('companion-mode', { action: 'stop' });
  assert.equal(none.isError, undefined); assert.match(none.reason, /没有跟随/);
});

test('companion-mode guard switches protection on the current follow and restarts the server follow with the new options', async t => {
  const f = await fixture(t); await f.follow();
  assert.deepEqual(f.sent()[0].guard, {});
  const off = await f.call('companion-mode', { action: 'guard', guard: false });
  assert.equal(off.guardEnabled, false);
  await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.sent().length, 2); assert.equal('guard' in f.sent()[1], false);
  assert.equal(f.sent()[1].player, 'Alex', 'same follow, not a new one');
  await f.mode.request({ action: 'guard', guard: { radius: 9 } }); await until(() => f.mode.snapshot().stage === 'active');
  assert.deepEqual(f.sent()[2].guard, { radius: 9 }); assert.equal(f.mode.snapshot().guardEnabled, true);
  await f.mode.request({ action: 'guard', guard: { bow: false } }); await until(() => f.mode.snapshot().stage === 'active');
  assert.deepEqual(f.sent()[3].guard, { radius: 9, bow: false }, 'options are merged onto the current ones');
  assert.equal(f.sent().length, 4); assert.equal(f.mode.snapshot().state, 'following');
  // while stepping aside nothing is restarted; the option is kept and used when the follow comes back
  await f.call('move-to-position', moveTo);
  const paused = await f.call('companion-mode', { action: 'guard', guard: { radius: 5 } });
  assert.equal(paused.state, 'paused'); assert.equal(paused.suspendedFor, 'move-to-position'); assert.equal(paused.guardEnabled, true);
  assert.equal(f.sent().length, 4);
  f.finishMove(); await f.ticks(); await until(() => f.mode.snapshot().stage === 'active');
  assert.deepEqual(f.sent()[4].guard, { radius: 5, bow: false });
  // invalid use
  await assert.rejects(f.mode.request({ action: 'guard' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.mode.request({ action: 'follow', player: 'Alex', guard: true }).then(() => f.mode.request({ action: 'wait', guard: true })), { code: 'INVALID_ARGUMENT' });
  await f.mode.request({ action: 'wait' });
  await assert.rejects(f.mode.request({ action: 'guard', guard: true }), { code: 'INVALID_STATE' });
  await f.mode.stop();
  await assert.rejects(f.mode.request({ action: 'guard', guard: true }), { code: 'NO_COMPANION_INTENT' });
});

test('guard needs the companion-guard capability and is not offered without it', async t => {
  const f = await fixture(t, { guard: false }); await f.follow();
  assert.equal('guard' in f.sent()[0], false);
  await assert.rejects(f.mode.request({ action: 'guard', guard: true }), { code: 'UNSUPPORTED' });
  const tool = (await f.client.listTools()).tools.find(item => item.name === 'companion-mode');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['follow', 'wait', 'pause', 'resume', 'stop']);
});

test('after the task the follow waits for a player who is out of sight, tells the model once, and picks up when they are back', async t => {
  const f = await fixture(t); await f.follow();
  await f.call('move-to-position', moveTo);
  f.mock.setState({ entities: [] });
  f.finishMove(); await f.ticks(4);
  const snapshot = f.mode.snapshot();
  assert.equal(snapshot.state, 'paused'); assert.equal(snapshot.suspendedFor, 'move-to-position'); assert.match(snapshot.reason, /不在附近/);
  assert.equal(f.events.since(0, ['companion']).length, 1, 'said once, not every tick');
  assert.equal(f.sent().length, 1);
  f.mock.setState({ entities: [f.player] }); await f.ticks();
  await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.mode.snapshot().state, 'following'); assert.equal(f.sent().length, 2);
});

test('a sleeping body keeps the follow aside until it is awake', async t => {
  const f = await fixture(t); await f.follow();
  await f.call('move-to-position', moveTo);
  f.finishMove(); f.mock.setState({ sleeping: true }); await f.ticks(4);
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.sent().length, 1);
  f.mock.setState({ sleeping: false }); await f.ticks();
  await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.sent().length, 2);
});

test('several things at once: the follow comes back when the last one ends', async t => {
  const f = await fixture(t); await f.follow();
  const first = await f.mode.yieldTo('first'), second = await f.mode.yieldTo('second');
  assert.equal(f.mode.snapshot().state, 'paused');
  await first.release();
  assert.equal(f.mode.snapshot().state, 'paused', 'the second is still using the body');
  await second.release();
  await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.mode.snapshot().state, 'following'); assert.equal(f.sent().length, 2);
});

test('a reflex steps the follow aside and lets it back, or keeps it paused when its outcome is unknown', async t => {
  const f = await fixture(t); await f.follow();
  const hooks = companionReflexHooks(new ContainerTasks(f.body), new GatherTasks(f.body, f.events), f.mode);
  const resume = await hooks.pauseCompanion('自卫');
  assert.equal(f.mode.snapshot().suspendedFor, '自卫');
  await resume();
  await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.mode.snapshot().state, 'following');
  const held = await hooks.pauseCompanion('进食');
  held.hold(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.mode.snapshot().suspendedFor, undefined);
  assert.equal(f.sent().length, 2);
});

test('cancelling work that a reflex preempts keeps the follow that stepped aside, while an explicit stop still discards it', async t => {
  const f = await fixture(t); await f.follow();
  const tasks = new ContainerTasks(f.body), gather = new GatherTasks(f.body, f.events);
  const stop = createActionStop(f.body, tasks, gather, f.mode);
  await f.call('move-to-position', moveTo);
  await stop.keepCompanion();
  assert.equal(f.mode.snapshot().intent, 'follow'); assert.equal(f.mode.snapshot().state, 'paused');
  await f.ticks();
  await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.mode.snapshot().state, 'following', 'the cancelled walk moved the control generation on; the follow is still ours');
  assert.equal(f.sent().length, 2);
  await f.call('move-to-position', moveTo);
  await stop();
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().intent, undefined);
});
