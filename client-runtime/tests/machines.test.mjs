import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineBook, MachineWatch } from '../dist/machines.js';
import { EventJournal } from '../dist/events.js';

// 8b 放好就走、到时回来取：烧炼不等时记账，到时间读一下炉子，好了／停了／读不到都发 machine 事件，回去取了就销账。
const FURNACE = { x: 10, y: 64, z: -3 };
const loaded = (over = {}) => ({ operationId: 'load', sessionId: 's', name: 'smelt-item', status: 'succeeded', summary: 'Loaded',
  result: { furnace: FURNACE, type: 'minecraft:furnace', input: 'minecraft:raw_iron', added: 8, queued: 8, output: 'minecraft:iron_ingot', readyInSeconds: 80, ...over } });
const collected = (over = {}) => ({ operationId: 'collect', sessionId: 's', name: 'smelt-item', status: 'succeeded', summary: 'Collected', result: { furnace: FURNACE, type: 'minecraft:furnace', collected: 8, ...over } });
function setup(status, { dir } = {}) {
  let now = 1_000_000;
  const reads = [];
  const body = { hello: { capabilities: ['smelt-item', 'machine-status'] }, machineStatus: async position => { reads.push(position); if (status instanceof Error) throw status; return typeof status === 'function' ? status() : status; } };
  const events = new EventJournal();
  const book = new MachineBook(dir, dir ? 'world-1' : undefined);
  const watch = new MachineWatch(book, body, events, { intervalMs: 0, now: () => now });
  events.onOperation(operation => watch.operation(operation));
  return { watch, book, events, reads, advance: ms => { now += ms; }, machine: () => events.since(0, ['machine']) };
}
const done = { position: FURNACE, state: 'loaded', id: 'minecraft:furnace', supported: true, inputs: [], results: [{ item: 'minecraft:iron_ingot', count: 8 }], fuel: null, working: false, stalled: false };

test('a furnace loaded without waiting is checked when due and wakes the model once when done', async () => {
  const t = setup(done);
  await t.watch.tick('minecraft:overworld');
  t.events.recordOperation(loaded());
  assert.equal(t.book.list().length, 1);
  assert.equal(t.watch.waiting()[0].readyInSeconds, 82, 'ready time from the receipt plus slack');
  t.advance(60_000); await t.watch.tick('minecraft:overworld');
  assert.equal(t.reads.length, 0, 'not read before it is due');
  t.advance(30_000); await t.watch.tick('minecraft:overworld');
  assert.equal(t.machine().length, 1);
  assert.match(t.machine()[0].text, /烧好了.*8 个 iron_ingot.*smelt-item furnace=\{"x":10,"y":64,"z":-3\}/);
  t.advance(30_000); await t.watch.tick('minecraft:overworld');
  assert.equal(t.machine().length, 1, 'told once');
  assert.equal(t.watch.waiting()[0].told, true);
  t.events.deliverOperation(collected());
  await t.watch.tick('minecraft:overworld');
  assert.equal(t.book.list().length, 0, 'collected there: forgotten, and nothing left is no news');
  assert.equal(t.machine().length, 1);
});

test('still cooking is rechecked when the furnace says it will be done; no event until then', async () => {
  let left = 3;
  const t = setup(() => ({ ...done, inputs: left ? [{ item: 'minecraft:raw_iron', count: left }] : [], working: left > 0, ticksLeft: left * 200, results: [{ item: 'minecraft:iron_ingot', count: 8 - left }] }));
  await t.watch.tick('minecraft:overworld'); t.events.recordOperation(loaded());
  t.advance(90_000); await t.watch.tick('minecraft:overworld');
  assert.equal(t.machine().length, 0);
  assert.equal(t.watch.waiting()[0].readyInSeconds, 32, 'server lag: 3 items x 10 s left, plus slack');
  left = 0; t.advance(32_000); await t.watch.tick('minecraft:overworld');
  assert.equal(t.machine().length, 1);
});

test('stalled, unloaded, other dimension, too far and a vanished furnace each say so', async () => {
  const stalled = setup({ ...done, inputs: [{ item: 'minecraft:raw_iron', count: 5 }], results: [{ item: 'minecraft:iron_ingot', count: 3 }], working: false, stalled: true, fuel: null });
  await stalled.watch.tick('minecraft:overworld'); stalled.events.recordOperation(loaded());
  stalled.advance(90_000); await stalled.watch.tick('minecraft:overworld');
  assert.match(stalled.machine()[0].text, /停了.*还剩 5 个 raw_iron.*没燃料.*已经出了 3 个 iron_ingot/);

  const unloaded = setup({ position: FURNACE, state: 'unloaded' });
  await unloaded.watch.tick('minecraft:overworld'); unloaded.events.recordOperation(loaded());
  unloaded.advance(90_000); await unloaded.watch.tick('minecraft:overworld');
  assert.match(unloaded.machine()[0].text, /区块没加载/);

  const away = setup(done);
  await away.watch.tick('minecraft:overworld'); away.events.recordOperation(loaded());
  away.advance(90_000); await away.watch.tick('minecraft:the_nether');
  assert.match(away.machine()[0].text, /不在那个维度/);
  assert.equal(away.reads.length, 0, 'never reads the same coordinates in another dimension');

  const far = setup(Object.assign(new Error('Machine is more than 256 blocks away'), { code: 'OUT_OF_REACH' }));
  await far.watch.tick('minecraft:overworld'); far.events.recordOperation(loaded());
  far.advance(90_000); await far.watch.tick('minecraft:overworld');
  assert.match(far.machine()[0].text, /离得太远/);

  const gone = setup({ position: FURNACE, state: 'loaded', id: 'minecraft:air', supported: false });
  await gone.watch.tick('minecraft:overworld'); gone.events.recordOperation(loaded());
  gone.advance(90_000); await gone.watch.tick('minecraft:overworld');
  assert.match(gone.machine()[0].text, /炉子不见了/);
  assert.equal(gone.book.list().length, 0);
});

test('waiting with wait:true, failed loads and other tools are not tracked; a collect with more cooking is followed quietly', async () => {
  const t = setup(() => ({ ...done, inputs: [{ item: 'minecraft:raw_iron', count: 2 }], working: true, ticksLeft: 400 }));
  await t.watch.tick('minecraft:overworld');
  t.events.recordOperation(loaded({ collected: 8, leftInFurnace: 0 }));
  t.events.recordOperation({ ...loaded(), operationId: 'failed', status: 'failed' });
  t.events.recordOperation({ ...loaded(), operationId: 'other', name: 'craft-item' });
  assert.equal(t.book.list().length, 0);
  t.events.recordOperation(collected({ collected: 3 }));
  await t.watch.tick('minecraft:overworld');
  assert.equal(t.machine().length, 0, 'just collected: no event while it still cooks');
  assert.equal(t.book.list().length, 1, 'still cooking after the collect: followed');
  assert.equal(t.book.list()[0].quiet, false);
});

test('the list survives a restart of the runtime (per world file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-machines-'));
  try {
    const first = setup(done, { dir });
    await first.watch.tick('minecraft:overworld'); first.events.recordOperation(loaded());
    const again = new MachineBook(dir, 'world-1');
    assert.equal(again.list().length, 1);
    assert.deepEqual(again.list()[0].position, FURNACE);
    assert.equal(new MachineBook(dir, 'world-2').list().length, 0, 'another world has its own list');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
