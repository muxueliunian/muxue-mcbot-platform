import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventJournal } from '../dist/events.js';
import { summarizeOperation, summarizeObservation, summarizeContainer } from '../dist/model-view.js';
import { observation } from './mock-control.mjs';

const large = { 'minecraft:custom_data': { type: 'compound', value: { message: { type: 'string', value: 'x'.repeat(12000) } } } };
const terminal = () => ({ operationId: randomUUID(), sessionId: 'game', name: 'dig-block', status: 'succeeded', summary: 'removed', result: { consumedCount: 1, block: { id: 'minecraft:air' }, inventory: [{ slot: 0, id: 'minecraft:dirt', count: 1, components: large }] } });

test('model summaries are small projections while exact component guards remain intact', () => {
  const full = terminal();
  const before = structuredClone(full);
  const summary = summarizeOperation(full);
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 10);
  assert.deepEqual(summary.result, { consumedCount: 1, block: { id: 'minecraft:air' }, inventoryChanged: true });
  assert.deepEqual(full, before);
  assert.equal(summarizeOperation({ ...full, result: { targetToken: 'runtime-only', requestedCount: 3 } }).result.targetToken, undefined);
  const state = observation({ inventory: full.result.inventory });
  const projected = summarizeObservation(state);
  assert.equal(projected.inventory[0].components, undefined);
  assert.equal(projected.inventory[0].componentsOmitted, true);
  assert.deepEqual(state.inventory[0].components, large);
});

test('container projection cannot describe bot diamonds as chest contents and keeps cursor separate', () => {
  const menu = { id: 'menu', type: 'minecraft:generic_9x3', revision: 2, slots: [
    { slot: 0, id: 'minecraft:oak_log', count: 3, components: {}, source: 'container' },
    { slot: 27, id: 'minecraft:diamond', count: 3, components: large, source: 'player', playerSlot: 9 },
    { slot: 28, id: 'mod:unverified', count: 1, components: {} },
  ], carried: { id: 'minecraft:dirt', count: 1, components: {} } };
  const compact = summarizeContainer(menu);
  assert.deepEqual(compact.container.map(item => item.id), ['minecraft:oak_log']);
  assert.deepEqual(compact.player.map(item => item.id), ['minecraft:diamond']);
  assert.equal(compact.unknown[0].id, 'mod:unverified');
  assert.equal(compact.cursor.id, 'minecraft:dirt');
  const task = summarizeOperation({ ...terminal(), name: 'container-list', result: { items: [{ item: 'minecraft:oak_log', count: 3, variant: 1 }] } });
  assert.equal(task.result.items[0].count, 3);
});
test('model projections preserve actual 16/64/99 maxima, omit unknown/empty maxima and never infer capacity from count', () => {
  const inventory = [16, 64, 99].map((maxStackSize, slot) => ({ slot, id: 'minecraft:stone', count: 3, maxStackSize, components: large }));
  const state = observation({ inventory: [...inventory, { slot: 3, id: 'minecraft:dirt', count: 5, components: {} }, { slot: 4, id: 'minecraft:air', count: 0, components: {} }], groundItems: [{ entityId: randomUUID(), position: { x: 1, y: 64, z: 0 }, visibility: 'visible', stack: { id: 'minecraft:stone', count: 3, maxStackSize: 99, components: large } }] });
  const compact = summarizeObservation(state);
  assert.deepEqual(compact.inventory.slice(0, 3).map(item => item.maxStackSize), [16, 64, 99]);
  assert.equal(compact.inventory[3].maxStackSize, undefined); assert.equal(compact.groundItems[0].stack.maxStackSize, 99);
  assert.equal(compact.groundItems[0].stack.components, undefined); assert.deepEqual(state.groundItems[0].stack.components, large);
  const menu = summarizeContainer({ id: 'm', type: 'chest', slots: inventory.map(item => ({ ...item, source: 'container' })), carried: inventory[2] });
  assert.equal(menu.cursor.maxStackSize, 99);
  const task = summarizeOperation({ ...terminal(), result: { items: [{ item: 'minecraft:stone', count: 3, maxStackSize: 99, variant: 1 }] } });
  assert.equal(task.result.items[0].maxStackSize, 99);
});

test('a terminal tool result suppresses a later poll without consuming adjacent chat', () => {
  const events = new EventJournal();
  const op = terminal();
  events.add('chat', 'Alex: new request');
  events.deliverOperation(op);
  events.notifyOperation(op);
  events.notifyOperation(op);
  assert.deepEqual(events.since(0).map(event => event.type), ['chat']);
});

test('poll-before-tool race writes a session-bound receipt, leaves other events, retains full local trace', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = new EventJournal(dir, 'ServerBot');
  const op = terminal(), unseen = terminal();
  events.notifyOperation(op);
  events.add('chat', 'Alex: follow me');
  events.notifyOperation(unseen);
  events.deliverOperation(op);
  const remaining = events.since(0);
  assert.deepEqual(remaining.map(event => event.type), ['chat', 'task']);
  assert.equal(remaining[1].operationId, unseen.operationId);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'task-delivered-ServerBot.json'), 'utf8'));
  assert.deepEqual(receipt, { session: events.session, operationIds: [op.operationId] });
  const trace = fs.readFileSync(path.join(dir, 'operations-ServerBot.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace[0].operation.result.inventory[0].components, large);
  assert.ok(fs.readFileSync(path.join(dir, 'events-ServerBot.jsonl'), 'utf8').length < 2000);
});

test('running tool result does not acknowledge a future completion', () => {
  const events = new EventJournal();
  const op = terminal();
  events.deliverOperation({ ...op, status: 'running' });
  events.notifyOperation(op);
  assert.equal(events.since(0, ['task']).length, 1);
});

test('terminal audit persists cancelled partial damage without wake or delivery, preserving later notify/deliver dedup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-survival-audit-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const events = new EventJournal(dir, 'ServerBot'), cancelled = { ...terminal(), name: 'defend-self', status: 'cancelled', summary: 'hard stop',
    result: { stage: 'cancelled', entityId: randomUUID(), confirmedHits: 1, confirmedDamage: 9, damageConfirmation: 'native_damage_event', sideEffects: 'confirmed' } };
  events.recordOperation({ ...cancelled, status: 'running' });
  assert.equal(fs.existsSync(path.join(dir, 'operations-ServerBot.jsonl')), false);
  events.recordOperation(cancelled); events.recordOperation(structuredClone(cancelled));
  const trace = () => fs.readFileSync(path.join(dir, 'operations-ServerBot.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(trace().length, 1); assert.deepEqual(trace()[0].operation, cancelled);
  assert.deepEqual(events.since(0), []); assert.equal(events.latestSeq(), 0);
  assert.equal(fs.readFileSync(path.join(dir, 'events-ServerBot.jsonl'), 'utf8'), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'task-delivered-ServerBot.json'), 'utf8')).operationIds, []);
  events.notifyOperation(cancelled); events.notifyOperation(cancelled);
  assert.equal(events.since(0, ['task']).length, 1); assert.equal(trace().length, 1);
  events.deliverOperation(cancelled); events.notifyOperation(cancelled);
  assert.equal(events.since(0, ['task']).length, 0);
  const delivered = { ...terminal(), name: 'eat', result: { consumedCount: 1, consumption: 'confirmed' } };
  events.recordOperation(delivered); events.deliverOperation(delivered); events.notifyOperation(delivered);
  assert.equal(events.since(0, ['task']).length, 0); assert.equal(trace().length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'task-delivered-ServerBot.json'), 'utf8')).operationIds, [cancelled.operationId, delivered.operationId]);
});
