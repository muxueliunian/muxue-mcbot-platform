import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanionMode } from '../dist/companion-mode.js';
import { ServerBody } from '../dist/server-body.js';
import { EventJournal } from '../dist/events.js';
import { writePosture } from '../dist/posture.js';
import { mockServerControl } from './mock-server-control.mjs';

// The standing posture (follow, wait, protect) outlives a lost body so a reconnecting host can tell the agent; only an explicit end clears it.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
const alex = randomUUID();
async function fixture(t) {
  const mock = await mockServerControl();
  mock.setState({ entities: [{ id: alex, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  let duty = null;
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'follow-companion', 'nearby-blocks', 'companion-guard', 'guard-duty-fenced'] });
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
    if (params.name !== 'follow-companion') return op;
    const following = { ...op, status: 'running', result: { ...params.args, distance: params.args.distance ?? 2.5, state: 'following', position: { x: 0, y: 64, z: 0 } } };
    ctx.operations.set(op.operationId, following); return following;
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const mode = new CompanionMode(body, new EventJournal());
  mode.resumeDelayMs = 0;
  const told = [];
  mode.onPosture = posture => told.push(posture);
  t.after(async () => { await body.close().catch(() => {}); await mock.close(); });
  return { mode, told, follow: async request => { await mode.request({ action: 'follow', player: 'Alex', ...request }); await until(() => mode.snapshot().stage === 'active'); } };
}

test('a follow, its guard setting and a wait are recorded once each, as they change', async t => {
  const f = await fixture(t);
  await f.follow();
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: true });
  const recorded = f.told.length;
  await f.mode.request({ action: 'guard', guard: { radius: 6 } });
  assert.equal(f.told.length, recorded, 'a new guard radius is not a new posture');
  await f.mode.request({ action: 'guard', guard: false });
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: false });
  await f.mode.request({ action: 'wait' });
  assert.deepEqual(f.told.at(-1), { action: 'wait', guard: false });
});

test('losing the body keeps the record; companion-mode stop, guard off with no follow and stop-action clear it', async t => {
  const f = await fixture(t);
  await f.follow();
  f.mode.fail(Object.assign(new Error('lease lost'), { code: 'LEASE_LOST' }), undefined, true);
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: true }, 'a death or a closed game is not the player ending it');
  assert.equal(f.told.includes(null), false);

  const g = await fixture(t);
  await g.follow();
  await g.mode.request({ action: 'stop' });
  assert.equal(g.told.at(-1), null);

  const h = await fixture(t);
  await h.mode.request({ action: 'guard', player: 'Alex', guard: true });
  assert.deepEqual(h.told.at(-1), { action: 'guard', player: 'Alex', guard: true });
  await h.mode.request({ action: 'guard', guard: false });
  assert.equal(h.told.at(-1), null);

  const k = await fixture(t);
  await k.follow();
  await k.mode.stop(undefined, { clearGuard: true });
  assert.equal(k.told.at(-1), null, 'stop-action');
  await k.follow();
  await k.mode.stop('reflex');
  assert.notEqual(k.told.at(-1), null, 'a plain stop (a reflex, a tool stepping in) is not an end');
});

test('writePosture replaces the file whole and removes it on an explicit end', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-posture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'posture-ServerBot.json');
  const write = writePosture(file, () => 1234);
  write({ action: 'follow', player: 'Alex', guard: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { action: 'follow', player: 'Alex', guard: true, at: 1234 });
  assert.deepEqual(fs.readdirSync(dir), ['posture-ServerBot.json'], 'no temporary file left behind');
  write(null);
  assert.equal(fs.existsSync(file), false);
  write(null);
});
