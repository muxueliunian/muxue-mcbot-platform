import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CompanionMode } from '../dist/companion-mode.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl } from './mock-server-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
const slot = { slot: 0, expectedItem: 'minecraft:stone', expectedCount: 1, expectedComponents: {} };

// `beside` decides whether the server declares beside-follow (select-slot and equip-item run beside a running follow).
async function fixture(t, { beside }) {
  const mock = await mockServerControl();
  const player = { id: randomUUID(), name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } };
  mock.setState({ entities: [player] });
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'follow-companion', 'nearby-blocks', 'select-slot', 'equip-item', ...(beside ? ['beside-follow'] : [])] });
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
  const server = createMcpServer(body, events, { companion: mode });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'beside-follow-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { monitor.stop(); await client.close(); await server.close(); await body.close(); await mock.close(); });
  const sent = () => mock.calls.filter(call => call.method === 'act' && call.params.name === 'follow-companion').map(call => call.params.args);
  const stops = () => mock.calls.filter(call => call.method === 'stop').length;
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); const text = result.content[0].text; let parsed; try { parsed = JSON.parse(text); } catch { parsed = { message: text }; } return { isError: result.isError, ...parsed }; };
  const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await monitor.tick(); };
  const follow = async () => { await mode.request({ action: 'follow', player: 'Alex' }); await until(() => mode.snapshot().stage === 'active'); };
  const states = () => events.since(0, ['companion_state']).map(event => JSON.parse(event.text));
  return { mode, events, call, ticks, follow, sent, stops, states };
}

test('select-slot and equip-item do not step a following companion aside when the server declares beside-follow', async t => {
  const f = await fixture(t, { beside: true }); await f.follow();
  const stopsBefore = f.stops(), sentBefore = f.sent().length;
  const picked = await f.call('select-slot', slot);
  assert.equal(picked.isError, undefined, `select-slot is not refused beside the follow: ${JSON.stringify(picked)}`);
  assert.equal(f.mode.snapshot().state, 'following');
  // equip-item may still be refused by its own checks (the mock has no inventory); the follow must stay put either way.
  await f.call('equip-item', { item: 'minecraft:iron_helmet' });
  assert.equal(f.mode.snapshot().state, 'following', 'equip-item does not pause the follow');
  assert.equal(f.stops(), stopsBefore, 'no stop was sent to the server');
  assert.equal(f.sent().length, sentBefore, 'the follow was not restarted');
  assert.ok(f.states().every(state => state.state !== 'paused'), 'the follow never showed paused');
});

test('without beside-follow select-slot still steps the follow aside and picks it up again', async t => {
  const f = await fixture(t, { beside: false }); await f.follow();
  assert.equal((await f.call('select-slot', slot)).isError, undefined);
  assert.ok(f.states().some(state => state.state === 'paused' && state.suspendedFor === 'select-slot'), 'the follow stepped aside for select-slot');
  await f.ticks();
  assert.equal(f.mode.snapshot().state, 'following', 'the follow picks up again by itself');
});
