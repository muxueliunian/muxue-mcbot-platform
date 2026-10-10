import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CompanionMode } from '../dist/companion-mode.js';
import { ContainerTasks } from '../dist/tasks.js';
import { GatherTasks } from '../dist/gather-tasks.js';
import { ServerBody } from '../dist/server-body.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { companionReflexHooks } from '../dist/action-stop.js';
import { mockServerControl } from './mock-server-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
const idleGuard = { state: 'idle', hits: 0, kills: 0, shots: 0, retreats: 0, damage: 0 };
async function fixture(t, { guardCapability = true } = {}) {
  const mock = await mockServerControl();
  mock.setState({ entities: [{ id: randomUUID(), name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'follow-companion', 'nearby-blocks', ...(guardCapability ? ['companion-guard'] : [])] });
  const act = mock.handlers.act;
  mock.handlers.act = (params, ctx) => {
    const op = act(params, ctx);
    if (params.name !== 'follow-companion') return op;
    const { guard, ...args } = params.args;
    const following = { ...op, status: 'running', result: { ...args, distance: args.distance ?? 2.5, state: 'following', position: { x: 0, y: 64, z: 0 }, ...(guard ? { guard: { ...idleGuard, options: guard } } : {}) } };
    ctx.operations.set(op.operationId, following); return following;
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const events = new EventJournal();
  const mode = new CompanionMode(body, events);
  mode.resumeDelayMs = 0; // This suite checks the handoff, not the production debounce interval.
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: () => {} });
  t.after(async () => { monitor.stop(); await body.close(); await mock.close(); });
  const sent = () => mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').map(call => call.params.args);
  const report = async guard => {
    const op = mock.operations.get(mode.snapshot().operationId);
    mock.operations.set(op.operationId, { ...op, result: { ...op.result, state: guard.state === 'idle' ? 'following' : 'guarding', guard: { ...idleGuard, ...guard } } });
    await monitor.tick();
  };
  return { mock, body, events, mode, monitor, sent, report, follow: async request => {
    await mode.request({ action: 'follow', player: 'Alex', ...request });
    await until(() => mode.snapshot().stage === 'active');
  } };
}
test('follow guards by default with the runtime settings; a request can tune or turn it off; wait/pause cannot carry it', async t => {
  const f = await fixture(t);
  await f.follow();
  assert.deepEqual(f.sent()[0].guard, {}, 'default guard uses the server defaults');
  f.mode.guardDefaults = { radius: 6, bow: false, shield: true };
  await f.follow({ guard: { radius: 10 } });
  assert.deepEqual(f.sent()[1].guard, { radius: 10, bow: false, shield: true }, 'request overrides the runtime defaults field by field');
  await f.follow({ guard: false });
  assert.equal('guard' in f.sent()[2], false, 'guard:false is an ordinary follow');
  f.mode.guardDefaults = false;
  await f.follow();
  assert.equal('guard' in f.sent()[3], false, 'turned off in the runtime settings');
  await f.follow({ guard: true });
  assert.deepEqual(f.sent()[4].guard, {}, 'an explicit request still guards');
  await assert.rejects(f.mode.request({ action: 'follow', player: 'Alex', guard: { radius: 30 } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.mode.request({ action: 'wait', guard: true }), { code: 'INVALID_ARGUMENT' });
});
test('a body without companion-guard follows without it, and refuses an explicit guard instead of silently dropping it', async t => {
  const f = await fixture(t, { guardCapability: false });
  await f.follow();
  assert.equal('guard' in f.sent()[0], false);
  await assert.rejects(f.mode.request({ action: 'follow', player: 'Alex', guard: true }), { code: 'UNSUPPORTED' });
});
test('guarding stays a follow; fight start, end with kills and a retreat each wake the model once', async t => {
  const f = await fixture(t);
  await f.follow();
  assert.equal(f.mode.guarding(), true);
  await f.report({ state: 'approaching', target: 'minecraft:zombie', targetId: randomUUID() });
  assert.equal(f.mode.snapshot().state, 'following', 'guarding is reported as following the same player');
  assert.equal(f.mode.snapshot().guard.state, 'approaching');
  const guardEvents = () => f.events.since(0, ['guard']).map(event => event.text);
  assert.equal(guardEvents().length, 1); assert.match(guardEvents()[0], /minecraft:zombie.*Alex/);
  await f.report({ state: 'fighting', target: 'minecraft:zombie', hits: 2, damage: 12 });
  await f.report({ state: 'fighting', target: 'minecraft:skeleton', hits: 3, damage: 18, kills: 1 });
  assert.equal(guardEvents().length, 1, 'swings and target changes inside one fight do not wake the model');
  await f.report({ state: 'idle', hits: 3, damage: 18, kills: 2 });
  assert.equal(guardEvents().length, 2); assert.match(guardEvents()[1], /打倒 2 只.*minecraft:zombie.*minecraft:skeleton/);
  await f.report({ state: 'retreating', target: 'minecraft:husk', kills: 2, retreats: 1 });
  assert.equal(guardEvents().length, 3); assert.match(guardEvents()[2], /撤/);
  await f.report({ state: 'retreating', target: 'minecraft:husk', kills: 2, retreats: 1 });
  assert.equal(guardEvents().length, 3, 'a continuing retreat is not reported again');
  assert.equal(f.mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').length, 1, 'never resubmitted');
});
test('a reflex pauses a plain follow and resumes it afterwards; busy finite work is not paused', async t => {
  const f = await fixture(t);
  await f.follow();
  const tasks = new ContainerTasks(f.body), gather = new GatherTasks(f.body, f.events);
  const hooks = companionReflexHooks(tasks, gather, f.mode);
  const resume = await hooks.pauseCompanion();
  assert.equal(f.mode.snapshot().state, 'paused');
  assert.equal(hooks.guarding(), false, 'a paused follow does not guard; the 3-block self-defense may act');
  await resume();
  await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.mode.snapshot().state, 'following');
  assert.equal(hooks.guarding(), true);
  assert.equal(f.sent().length, 2, 'resume restarts the same follow intent once');
  assert.deepEqual(f.sent()[1].guard, {}, 'with its guard');
  await f.mode.stop();
  assert.equal(await hooks.pauseCompanion(), undefined, 'nothing to pause after a stop');
});
