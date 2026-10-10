import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerBody } from '../dist/server-body.js';
import { EventJournal } from '../dist/events.js';
import { gearLabel, summarizeObservation } from '../dist/model-view.js';
import { SurvivalReflexes } from '../dist/survival-reflexes.js';
import { mockServerControl } from './mock-server-control.mjs';
import { observation } from './mock-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const WINDOW = 40;
const stack = (id, count, components = {}) => ({ id, count, components, maxStackSize: 64 });
const receipt = (seq, id, count, extra = {}) => ({ seq, entityId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, position: { x: 0, y: 64, z: 0 }, stack: stack(id, count, extra.components), pickedUpCount: count,
  sessionId: 'server-session-1', controlGeneration: 0, dimension: 'minecraft:overworld', ...(extra.thrownBy ? { thrownBy: extra.thrownBy } : {}), ...(extra.storedIn ? { storedIn: extra.storedIn } : {}) });
const seen = (receipts, overrides = {}) => observation({ source: 'server-observed', username: 'ServerBot', instanceId: 'instance-1', sessionId: 'server-session-1', controlGeneration: 0,
  pickupCursor: receipts.length ? Math.max(...receipts.map(r => r.seq)) : 0, pickupOldestCursor: 0, pickupReceipts: receipts, ...overrides });
const gifts = events => events.since(0).filter(event => event.type === 'gift').map(event => event.text);
function journal() { const events = new EventJournal(undefined, 'ServerBot', ['OtherBot']); events.useGifts(WINDOW); return events; }

test('a thrown sword picked up natively becomes one gift event after the window', async () => {
  const events = journal();
  const before = [receipt(1, 'minecraft:dirt', 3, { thrownBy: 'muxue' })];
  events.ingest(seen(before));
  assert.deepEqual(gifts(events), [], 'receipts before attaching are a baseline, not news');
  const after = [...before, receipt(2, 'minecraft:netherite_sword', 1, { thrownBy: 'muxue' })];
  events.ingest(seen(after));
  assert.deepEqual(gifts(events), [], 'held for the merge window');
  await delay(WINDOW * 3);
  assert.deepEqual(gifts(events), ['muxue 丢给你：minecraft:netherite_sword ×1（已进背包）']);
  events.ingest(seen(after)); events.ingest(seen(after));
  await delay(WINDOW * 3);
  assert.equal(gifts(events).length, 1, 'the same receipt is never told twice, however often it is observed');
});

test('several items from one player within the window merge; another player gets their own event', async () => {
  const events = journal();
  events.ingest(seen([]));
  const sword = { 'minecraft:enchantments': { levels: { 'minecraft:sharpness': 5 } } };
  const receipts = [receipt(1, 'minecraft:bread', 2, { thrownBy: 'muxue' }), receipt(2, 'minecraft:bread', 3, { thrownBy: 'muxue' }),
    receipt(3, 'minecraft:iron_sword', 1, { thrownBy: 'muxue', components: sword }), receipt(4, 'minecraft:apple', 1, { thrownBy: 'Alex' })];
  events.ingest(seen(receipts.slice(0, 2)));
  events.ingest(seen(receipts));
  await delay(WINDOW * 3);
  assert.deepEqual(gifts(events).sort(), ['Alex 丢给你：minecraft:apple ×1（已进背包）', 'muxue 丢给你：minecraft:bread ×5、minecraft:iron_sword ×1（带附魔、名字等属性）（已进背包）']);
  // After the window a new throw is a new event.
  events.ingest(seen([...receipts, receipt(5, 'minecraft:torch', 16, { thrownBy: 'muxue' })]));
  await delay(WINDOW * 3);
  assert.equal(gifts(events).at(-1), 'muxue 丢给你：minecraft:torch ×16（已进背包）');
});

test('mined blocks, mob loot and the body\'s own drops are never gifts', async () => {
  const events = journal();
  events.ingest(seen([]));
  events.ingest(seen([receipt(1, 'minecraft:cobblestone', 8), receipt(2, 'minecraft:rotten_flesh', 1), receipt(3, 'minecraft:oak_log', 4, { thrownBy: 'ServerBot' }), receipt(4, 'minecraft:stick', 2, { thrownBy: 'OtherBot' })]));
  await delay(WINDOW * 3);
  assert.deepEqual(gifts(events), []);
  assert.equal(events.since(0).filter(event => event.type === 'gift').length, 0);
});

test('items a carried backpack took are told with where they went', async () => {
  const events = journal();
  events.ingest(seen([]));
  events.ingest(seen([receipt(1, 'minecraft:diamond', 2, { thrownBy: 'muxue' }), receipt(2, 'minecraft:coal', 9, { thrownBy: 'muxue', storedIn: 'sophisticatedbackpacks:backpack' })]));
  await delay(WINDOW * 3);
  assert.deepEqual(gifts(events), ['muxue 丢给你：minecraft:diamond ×2（已进背包）；minecraft:coal ×9（已放进 sophisticatedbackpacks:backpack）']);
});

test('without gift-receipts there are no gift events; a new server instance starts a new baseline', async () => {
  const off = new EventJournal(undefined, 'ServerBot');
  off.ingest(seen([]));
  off.ingest(seen([receipt(1, 'minecraft:bread', 1, { thrownBy: 'muxue' })]));
  await delay(WINDOW * 3);
  assert.deepEqual(gifts(off), []);
  const events = journal();
  events.ingest(seen([receipt(7, 'minecraft:bread', 1, { thrownBy: 'muxue' })]));
  // The server restarted: its ledger counts from 1 again; what it already holds is the new baseline.
  events.ingest(seen([receipt(1, 'minecraft:apple', 1, { thrownBy: 'muxue' })], { instanceId: 'instance-2', sessionId: 'server-session-2' }));
  events.ingest(seen([receipt(1, 'minecraft:apple', 1, { thrownBy: 'muxue' }), receipt(2, 'minecraft:carrot', 1, { thrownBy: 'muxue' })], { instanceId: 'instance-2', sessionId: 'server-session-2' }));
  await delay(WINDOW * 3);
  assert.deepEqual(gifts(events), ['muxue 丢给你：minecraft:carrot ×1（已进背包）']);
});

const playerGear = { mainhand: { id: 'minecraft:netherite_sword', count: 1, enchantments: ['minecraft:sharpness 5'], name: '屠龙', durability: '2000/2031' }, offhand: { id: 'minecraft:shield', count: 1 },
  head: { id: 'minecraft:diamond_helmet', count: 1 }, chest: { id: 'minecraft:diamond_chestplate', count: 1 } };
const zombieGear = { mainhand: { id: 'minecraft:iron_sword', count: 1 }, head: { id: 'minecraft:iron_helmet', count: 1 }, chest: { id: 'minecraft:iron_chestplate', count: 1 } };
const skeletonGear = { mainhand: { id: 'minecraft:bow', count: 1 } };
const nearby = [
  { id: 'p1', type: 'minecraft:player', name: 'muxue', position: { x: 1, y: 64, z: 0 }, sleeping: false, equipment: playerGear },
  { id: 'z1', type: 'minecraft:zombie', name: 'Zombie', position: { x: 4, y: 64, z: 0 }, equipment: zombieGear },
  { id: 's1', type: 'minecraft:skeleton', name: 'Skeleton', position: { x: 6, y: 64, z: 0 }, equipment: skeletonGear },
  { id: 'c1', type: 'minecraft:cow', name: 'Cow', position: { x: 3, y: 64, z: 3 } },
  { id: 'z2', type: 'minecraft:zombie', name: 'Zombie', position: { x: 20, y: 64, z: 0 }, equipmentOmitted: true },
  { id: 'z3', type: 'minecraft:zombie', name: 'Zombie', position: { x: 9, y: 64, z: 0 }, equipment: { head: { id: 'minecraft:iron_helmet', count: 1, name: 'x'.repeat(500) } } },
];

test('ServerBody keeps equipment and thrownBy, drops malformed equipment without losing the observation', async t => {
  const mock = await mockServerControl();
  t.after(() => mock.close());
  mock.handlers.hello = () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
    platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.217' }, capabilities: ['send-chat', 'gift-receipts', 'entity-equipment'] });
  mock.setState({ entities: nearby, pickupCursor: 2, pickupOldestCursor: 0, pickupReceipts: [receipt(1, 'minecraft:netherite_sword', 1, { thrownBy: 'muxue' }), { ...receipt(2, 'minecraft:dirt', 1), thrownBy: 42 }] });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  assert.ok(body.hello.capabilities.includes('gift-receipts') && body.hello.capabilities.includes('entity-equipment'), 'both capabilities pass the runtime filter');
  const state = await body.observe();
  const byId = Object.fromEntries(state.entities.map(entity => [entity.id, entity]));
  assert.deepEqual(byId.p1.equipment, playerGear, 'player hand, offhand and armour');
  assert.deepEqual(byId.z1.equipment, zombieGear, 'armoured zombie');
  assert.deepEqual(byId.s1.equipment, skeletonGear, 'skeleton with a bow');
  assert.equal(byId.c1.equipment, undefined, 'nothing equipped: no field');
  assert.equal(byId.c1.equipmentOmitted, undefined);
  assert.equal(byId.z2.equipmentOmitted, true, 'left out by the server limit stays marked');
  assert.equal(byId.z3.equipment, undefined, 'an oversized value is dropped, the entity stays');
  assert.equal(state.entities.length, nearby.length);
  assert.equal(state.pickupReceipts[0].thrownBy, 'muxue');
  assert.equal(state.pickupReceipts[1].thrownBy, undefined, 'a malformed thrower is dropped, the receipt stays');
  const compact = summarizeObservation(state);
  assert.deepEqual(compact.entities.find(entity => entity.id === 'z1').equipment, zombieGear, 'get-status compact view shows equipment');
});

test('an older server without the fields still parses', async t => {
  const { body } = await (async () => {
    const mock = await mockServerControl();
    t.after(() => mock.close());
    const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
    t.after(() => body.close());
    return { body };
  })();
  assert.ok(!body.hello.capabilities.includes('gift-receipts') && !body.hello.capabilities.includes('entity-equipment'));
  const state = await body.observe();
  assert.equal(state.entities[0].equipment, undefined);
});

test('gear labels read like "穿铁甲的僵尸" and "拿弓的骷髅"', () => {
  assert.equal(gearLabel(zombieGear), '穿 iron_helmet、iron_chestplate，拿 iron_sword');
  assert.equal(gearLabel(skeletonGear), '拿 bow');
  assert.equal(gearLabel(playerGear), '穿 diamond_helmet、diamond_chestplate，拿 netherite_sword（附魔）、shield');
  assert.equal(gearLabel({ body: { id: 'minecraft:wolf_armor', count: 1 } }), '披 wolf_armor');
  assert.equal(gearLabel({ mainhand: { id: 'othermod:blaster', count: 1 } }), '拿 othermod:blaster', 'mod ids keep their namespace');
  assert.equal(gearLabel(undefined), '');
  assert.equal(gearLabel(undefined, true), '装备未列出');
});

test('survival danger event names what the hostile threats hold and wear', async () => {
  const threat = (entityId, type, distance, extra) => ({ entityId, type, classification: 'hostile', hostilitySource: 'vanilla_hostile_allowlist', targetingSelf: false, distance, lineOfSight: true, alive: true, explosionPreparing: false, defenseEligible: true, defenseReason: null, factsAvailable: true, ...extra });
  const state = { serverTick: 10, observedAt: 100, health: 20, maxHealth: 20, food: 20, saturation: 5, selectedSlot: 0, foods: [],
    threats: { radius: 8, complete: true, serverTick: 10, nearby: [
      threat('00000000-0000-4000-8000-000000000001', 'minecraft:zombie', 2, { equipment: zombieGear }),
      threat('00000000-0000-4000-8000-000000000002', 'minecraft:skeleton', 2.5, { equipment: skeletonGear }),
      threat('00000000-0000-4000-8000-000000000003', 'minecraft:spider', 1.5, {})] } };
  const events = new EventJournal();
  const body = { hello: { capabilities: ['defend-entity'] }, async survivalState() { return state; } };
  const reflexes = new SurvivalReflexes(body, { assertIdle() {}, read() { return { state: 'idle' }; } }, events, { ordinaryBusy: () => false, guarding: () => true, async stopCurrent() { return { stopped: true }; } });
  await reflexes.tick();
  const text = events.since(0).find(event => event.type === 'survival')?.text ?? '';
  assert.match(text, /；装备：minecraft:zombie（穿 iron_helmet、iron_chestplate，拿 iron_sword），minecraft:skeleton（拿 bow）$/);
  assert.doesNotMatch(text, /spider（/, 'a threat with nothing equipped adds no gear');
  // Gear is not part of the event key: the same threats with changed gear do not wake the model again.
  state.threats.nearby[0] = { ...state.threats.nearby[0], equipment: skeletonGear };
  await reflexes.tick();
  assert.equal(events.since(0).filter(event => event.type === 'survival').length, 1);
});
