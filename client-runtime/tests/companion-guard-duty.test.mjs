import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CompanionMode } from '../dist/companion-mode.js';
import { ServerBody } from '../dist/server-body.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl } from './mock-server-control.mjs';

// Bodies with guard-duty keep protection as a standing duty, not inside the follow (docs/companion_state_design.md, section 5).
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
const alex = randomUUID(), sam = randomUUID();
const idle = { state: 'idle', hits: 0, kills: 0, shots: 0, retreats: 0, damage: 0, busyMs: 0 };
async function fixture(t) {
  const mock = await mockServerControl();
  mock.setState({ entities: [
    { id: alex, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } },
    { id: sam, name: 'Sam', type: 'minecraft:player', position: { x: -3, y: 64, z: 0 } },
  ] });
  let duty = null;
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'follow-companion', 'nearby-blocks', 'companion-guard', 'guard-duty'] });
  mock.handlers.guard = params => {
    if (params.off) { duty = null; return { enabled: false }; }
    duty = { enabled: true, player: params.player, entityId: params.expectedEntityId, options: params.options, covering: true, ...idle };
    return duty;
  };
  const observe = mock.handlers.observe;
  mock.handlers.observe = params => ({ ...observe(params), ...(duty ? { guard: duty } : {}) });
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
  mode.resumeDelayMs = 0;
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: () => {} });
  t.after(async () => { monitor.stop(); await body.close(); await mock.close(); });
  const guardCalls = () => mock.calls.filter(call => call.method === 'guard').map(call => call.params);
  const follows = () => mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').map(call => call.params.args);
  return { mock, mode, events, monitor, guardCalls, follows,
    duty: () => duty, setDuty: next => { duty = next === null ? null : { ...duty, ...next }; },
    follow: async request => { await mode.request({ action: 'follow', player: 'Alex', ...request }); await until(() => mode.snapshot().stage === 'active'); } };
}

test('follow turns the guard duty on for that player; the follow itself carries no guard', async t => {
  const f = await fixture(t);
  await f.follow();
  assert.equal(f.guardCalls().length, 1);
  assert.deepEqual({ player: f.guardCalls()[0].player, entityId: f.guardCalls()[0].expectedEntityId, options: f.guardCalls()[0].options }, { player: 'Alex', entityId: alex, options: {} });
  assert.equal('guard' in f.follows()[0], false, 'protection is not a follow argument any more');
  assert.equal(f.mode.snapshot().guardEnabled, true);
  await f.monitor.tick();
  assert.equal(f.mode.guarding(), true, 'covering: the 3-block self-defense stays out of the way');
  await f.follow({ guard: false });
  assert.deepEqual(f.guardCalls().at(-1), { ...f.guardCalls().at(-1), off: true }, 'guard:false on a follow turns protection off');
  assert.equal(f.duty(), null);
});

test('protection outlives a step aside and a wait, and works with no follow at all', async t => {
  const f = await fixture(t);
  await f.follow();
  const lease = await f.mode.yieldTo('build');
  assert.equal(f.mode.snapshot().state, 'paused');
  assert.equal(f.guardCalls().length, 1, 'stepping aside for a tool does not touch the duty');
  await f.monitor.tick();
  assert.equal(f.mode.guarding(), true, 'still protecting while the follow stands aside');
  await lease.release();
  await f.mode.request({ action: 'wait' });
  assert.equal(f.guardCalls().length, 1, 'waiting keeps protecting the same player');
  assert.equal(f.mode.snapshot().guardEnabled, true);
  // Another player, named without following them.
  await f.mode.request({ action: 'guard', player: 'Sam', guard: { radius: 6 } });
  assert.equal(f.duty().player, 'Sam'); assert.equal(f.duty().entityId, sam);
  assert.deepEqual(f.duty().options, { radius: 6 });
  await f.mode.request({ action: 'guard', guard: false });
  assert.equal(f.duty(), null);
});

test('guard without a follow needs a player; an unknown player is refused before anything changes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.mode.request({ action: 'guard', guard: true }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.mode.request({ action: 'guard', player: 'Nobody', guard: true }), { code: 'PLAYER_NOT_VISIBLE' });
  assert.equal(f.guardCalls().length, 0);
  await f.mode.request({ action: 'guard', player: 'Alex', guard: true });
  assert.equal(f.mode.snapshot().guardEnabled, true);
  assert.equal(f.mode.snapshot().state, 'idle', 'protection alone starts no follow');
});

test('companion-mode stop and stop-action end protection; a plain reflex stop does not', async t => {
  const f = await fixture(t);
  await f.follow();
  await f.mode.stop('reflex');
  assert.notEqual(f.duty(), null, 'a reflex stop keeps the duty');
  await f.mode.dropGuard();
  assert.equal(f.duty(), null, 'stop-action drops it');
  await f.mode.request({ action: 'guard', player: 'Alex', guard: true });
  const ended = await f.mode.request({ action: 'stop' });
  assert.equal(f.duty(), null, 'companion-mode stop with no follow still ends protection');
  assert.match(ended.reason, /保护已关/);
  await f.follow();
  await f.mode.request({ action: 'stop' });
  assert.equal(f.duty(), null, 'companion-mode stop ends the follow and the protection');
});

test('fights reported by the duty wake the model once; a duty the server dropped is reported', async t => {
  const f = await fixture(t);
  await f.mode.request({ action: 'guard', player: 'Alex', guard: true });
  const guardEvents = () => f.events.since(0, ['guard']).map(event => event.text);
  f.setDuty({ state: 'approaching', target: 'minecraft:zombie', targetId: randomUUID() });
  await f.monitor.tick();
  assert.equal(guardEvents().length, 1); assert.match(guardEvents()[0], /minecraft:zombie.*Alex/);
  assert.equal(f.mode.guardFighting(), true, 'a fight makes ordinary meals wait');
  f.setDuty({ state: 'fighting', hits: 2, damage: 12 });
  await f.monitor.tick();
  f.setDuty({ state: 'idle', hits: 2, damage: 12, kills: 1 });
  await f.monitor.tick();
  assert.equal(guardEvents().length, 2); assert.match(guardEvents()[1], /打倒 1 只/);
  assert.doesNotMatch(guardEvents()[1], /接着跟着/, 'not following: no "keeps following" in the report');
  f.setDuty({ covering: false, reason: 'TOO_FAR' });
  await f.monitor.tick();
  assert.equal(f.mode.guarding(), false, 'out of range: self-defense takes over again');
  assert.equal(f.mode.snapshot().guard.reason, 'TOO_FAR');
  f.setDuty(null);
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().guardEnabled, false);
  assert.match(guardEvents().at(-1), /保护已经停了/);
});
