import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { CompanionMode } from '../dist/companion-mode.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl } from './mock-server-control.mjs';

// sit / stand-up: the tools, their arguments, and what sitting does to a running follow (ends it, keeps protection).
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
const alex = randomUUID();
const capabilities = ['send-chat', 'look-at', 'move-to-position', 'follow-companion', 'nearby-blocks', 'companion-guard', 'guard-duty-fenced', 'sit', 'stand-up'];

async function setup(t, { caps = capabilities, sitResult } = {}) {
  const mock = await mockServerControl();
  mock.setState({ entities: [{ id: alex, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  let duty = null;
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: caps });
  mock.handlers.guard = params => {
    if (params.off) { duty = null; return { enabled: false, guardRevision: params.guardRevision }; }
    duty = { enabled: true, player: params.player, entityId: params.expectedEntityId, options: params.options, covering: true, state: 'idle', hits: 0, kills: 0, shots: 0, retreats: 0, damage: 0, busyMs: 0 };
    return { ...duty, guardRevision: params.guardRevision };
  };
  const stop = mock.handlers.stop;
  mock.handlers.stop = params => { const result = stop(params); if (params.clearGuard === true) duty = null; return result; };
  const observe = mock.handlers.observe;
  mock.handlers.observe = params => ({ ...observe(params), ...(duty ? { guard: duty } : {}) });
  const act = mock.handlers.act;
  mock.handlers.act = (params, ctx) => {
    const op = act(params, ctx);
    if (params.name === 'sit' && sitResult) { const failed = { ...op, ...sitResult }; ctx.operations.set(op.operationId, failed); return failed; }
    if (params.name !== 'follow-companion') return op;
    const following = { ...op, status: 'running', result: { ...params.args, distance: params.args.distance ?? 2.5, state: 'following', position: { x: 0, y: 64, z: 0 } } };
    ctx.operations.set(op.operationId, following); return following;
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const events = new EventJournal();
  const mode = new CompanionMode(body, events);
  mode.resumeDelayMs = 0;
  const told = [];
  mode.onPosture = posture => told.push(posture);
  const server = createMcpServer(body, events, { companion: mode });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'seat-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); await body.close().catch(() => {}); await mock.close(); });
  const acts = () => mock.calls.filter(call => call.method === 'act').map(call => call.params);
  const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const follow = async request => { await mode.request({ action: 'follow', player: 'Alex', ...request }); await until(() => mode.snapshot().stage === 'active'); };
  return { mock, body, mode, told, acts, call, client, follow };
}

test('sit and stand-up are published only with their capabilities', async t => {
  const full = await setup(t);
  const names = (await full.client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('sit') && names.includes('stand-up'));
  const old = await setup(t, { caps: capabilities.filter(cap => cap !== 'sit' && cap !== 'stand-up') });
  const oldNames = (await old.client.listTools()).tools.map(tool => tool.name);
  assert.ok(!oldNames.includes('sit') && !oldNames.includes('stand-up'));
});

test('sit forwards an optional seat position; partial or malformed arguments never reach the server', async t => {
  const f = await setup(t);
  assert.equal((await f.call('sit', { x: 4, y: 64, z: -2 })).status, 'succeeded');
  assert.equal((await f.call('sit')).status, 'succeeded');
  assert.equal((await f.call('stand-up')).status, 'succeeded');
  assert.deepEqual(f.acts().map(act => [act.name, act.args]), [['sit', { x: 4, y: 64, z: -2 }], ['sit', {}], ['stand-up', {}]]);
  const partial = await f.client.callTool({ name: 'sit', arguments: { x: 4 } });
  assert.equal(partial.isError, true);
  await assert.rejects(f.body.act('sit', { x: 1.5, y: 64, z: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.body.act('sit', { x: 1, y: 64 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.body.act('stand-up', { now: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.acts().length, 3);
});

test('a successful sit ends the follow, keeps the guard duty and is not resumed by itself; stand-up clears the mark', async t => {
  const f = await setup(t);
  await f.follow();
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: true });
  assert.equal(f.acts().filter(act => act.name === 'follow-companion').length, 1);

  const sat = await f.call('sit');
  assert.equal(sat.status, 'succeeded');
  assert.ok(f.acts().some(act => act.name === 'sit'), 'sit went to the server');
  const state = f.mode.snapshot();
  assert.equal(state.seated, true);
  assert.equal(state.intent, undefined, 'the follow is over');
  assert.equal(state.guardEnabled, true, 'protection stays');
  assert.deepEqual(f.told.at(-1), { action: 'guard', player: 'Alex', guard: true }, 'what is left of the posture is the guard');
  assert.equal(f.told.includes(null), false);

  await delay(120);
  assert.equal(f.acts().filter(act => act.name === 'follow-companion').length, 1, 'no follow resumed after the tool released');
  assert.equal(f.mode.snapshot().seated, true);

  assert.equal((await f.call('stand-up')).status, 'succeeded');
  await until(() => f.mode.snapshot().seated !== true);
  assert.equal(f.mode.snapshot().guardEnabled, true, 'standing up leaves the protection alone');
  await delay(60);
  assert.equal(f.acts().filter(act => act.name === 'follow-companion').length, 1, 'stand-up does not bring the follow back');
});

test('sitting without protection leaves no posture to restore', async t => {
  const f = await setup(t);
  await f.follow({ guard: false });
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: false });
  assert.equal((await f.call('sit')).status, 'succeeded');
  assert.equal(f.told.at(-1), null, 'the follow was the posture and sitting ended it');
  assert.equal(f.mode.snapshot().seated, true);
});

test('a refused sit leaves the follow as it was and picks it up again', async t => {
  const f = await setup(t, { sitResult: { status: 'failed', summary: 'SEAT_OCCUPIED: Someone is already sitting there', result: { code: 'SEAT_OCCUPIED' } } });
  await f.follow();
  const refused = await f.call('sit');
  assert.equal(refused.status, 'failed');
  assert.equal(f.mode.snapshot().seated, undefined);
  await until(() => f.mode.snapshot().state === 'following');
  assert.equal(f.mode.snapshot().intent, 'follow');
  assert.equal(f.told.at(-1).action, 'follow');
});

test('get-companion-mode drops the sitting mark when the server observes the body standing (a fight got it up)', async t => {
  const f = await setup(t);
  await f.follow();
  await f.call('sit');
  f.mock.setState({ sitting: true });
  assert.equal((await f.call('get-companion-mode')).seated, true);
  f.mock.setState({ sitting: false });
  assert.equal((await f.call('get-companion-mode')).seated, undefined);
  assert.equal(f.mode.snapshot().guardEnabled, true);
});

test('get-status shows sitting from the server observation', async t => {
  const f = await setup(t);
  f.mock.setState({ sitting: true });
  const status = await f.call('get-status');
  assert.equal(status.sitting, true);
});
