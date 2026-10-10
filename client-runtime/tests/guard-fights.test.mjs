import test from 'node:test';
import assert from 'node:assert/strict';
import { FightGrace, fightGrace } from '../dist/fight-grace.js';
import { ServerBody } from '../dist/server-body.js';
import { mockServerControl } from './mock-server-control.mjs';

// Guard fights interrupt tasks on bodies with guard-duty-tasks; runtime-timed tasks get the fight time back (docs/companion_state_design.md 5.2).

test('FightGrace hands out new fight time once, at most the budget in all', () => {
  let total = 500;
  const grace = new FightGrace({ fightMs: () => total }, 1000);
  assert.equal(grace.take(), 0, 'fights before the task do not count');
  total = 900; assert.equal(grace.take(), 400);
  assert.equal(grace.take(), 0, 'the same fight time is not granted twice');
  total = 2000; assert.equal(grace.take(), 600, 'capped at the budget');
  total = 3000; assert.equal(grace.take(), 0);
  assert.equal(fightGrace({ hello: { capabilities: ['guard-duty-fenced'] }, fightMs: () => 0 }, 1000), undefined, 'a server that does not interrupt tasks gives no grace');
  assert.equal(fightGrace({ hello: { capabilities: ['guard-duty-tasks'] } }, 1000), undefined, 'a body that does not count fights gives no grace');
  assert.ok(fightGrace({ hello: { capabilities: ['guard-duty-tasks'] }, fightMs: () => 0 }, 1000));
});

test('ServerBody.fightMs adds up busyMs over observations and over successive duties', async t => {
  const mock = await mockServerControl();
  let guard;
  const observe = mock.handlers.observe;
  mock.handlers.observe = params => ({ ...observe(params), ...(guard ? { guard } : {}) });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(async () => { await body.close(); await mock.close(); });
  const duty = busyMs => ({ enabled: true, player: 'Alex', entityId: '00000000-0000-4000-8000-000000000001', covering: true, state: 'idle', hits: 0, kills: 0, shots: 0, retreats: 0, damage: 0, busyMs });
  const seen = [];
  for (const g of [undefined, duty(0), duty(1200), duty(3000), duty(500), undefined, duty(200)]) { guard = g; await body.observe(); seen.push(body.fightMs()); }
  assert.deepEqual(seen, [0, 0, 1200, 3000, 3500, 3500, 3700], 'a new duty starts its busyMs again; the total only grows');
});
