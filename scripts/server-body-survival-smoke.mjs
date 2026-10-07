#!/usr/bin/env node
// B1-B3: real ServerBody HTTP actions; RCON only prepares isolated fixtures and reads authority.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ServerBody, readServerConnection } from '../client-runtime/dist/server-body.js';
import { rcon, readServerProps } from './rcon.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const serverDir = resolve('runtime/serverbody-validation');
const connectionFile = resolve(serverDir, 'config/mcbot-server-control/connection.json');
const outputFlag = process.argv.indexOf('--output');
const output = resolve(outputFlag < 0 ? 'output/serverbody-survival-B.json' : process.argv[outputFlag + 1]);
if (!process.argv.includes('--allow-fixture')) throw new Error('Back up the isolated world, then pass --allow-fixture');
const evidence = { started: new Date().toISOString(), scope: 'B1-B3; real Node ServerBody -> HTTP v2 -> normal survival packet handlers. RCON is test fixture and independent read only.', checks: [], operations: [], fixtures: [], cleanup: [] };
let body, lease, connection, oldSpawn;
const target = { x: 516, y: 201, z: 512 };
const anchor = { x: 516, y: 200, z: 512 };
const origin = { x: 513.5, y: 201, z: 512.5 };
const marker = '516 199 512';
function check(name, passed, detail) {
  evidence.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new Error(`FAIL ${name}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${name}`);
}
async function command(text) {
  const [reply] = await rcon([text], { serverDir });
  evidence.fixtures.push({ command: text, reply });
  return reply;
}
async function alone() {
  const reply = (await command('list')).trim();
  if (!reply.includes('players online:')) throw new Error('Cannot parse online player list; refuse fixture mutation');
  const names = reply.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(s => s.trim()).filter(Boolean) ?? [];
  if (names.some(name => name !== 'Claude')) throw new Error('Human or unrelated player online; refuse fixture mutations');
}
async function fixture(text) { await alone(); const reply = await command(text); if (/not loaded|Unknown or incomplete command|Incorrect argument/i.test(reply)) throw new Error(`Fixture rejected: ${text}: ${reply.trim()}`); return reply; }
async function wire(method, params = {}) {
  const response = await fetch(connection.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000), headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ method, params }) });
  return response.json();
}
async function rpc(method, params = {}) {
  const result = await wire(method, params);
  if (!result.ok) throw Object.assign(new Error(`${method}: ${result.error.code}`), { code: result.error.code });
  return result.result;
}
async function connect() {
  body = await ServerBody.connect({ connection, worldId: connection.worldId, username: connection.username, claimWaitMs: 0, onLease(value) { lease = value; } });
}
async function until(label, fn, timeout = 6000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
async function act(name, args, terminal = true) {
  await alone();
  let op = await body.act(name, args);
  evidence.operations.push({ name, args, initial: op });
  if (terminal && op.status === 'running') op = await until(`${name} terminal`, async () => { const value = await body.operation(op.operationId); return value.status !== 'running' && value; }, Math.max(10000, args.timeoutMs || 0) + 1000);
  evidence.operations.at(-1).terminal = op;
  return op;
}
async function success(name, args, label = name) {
  const op = await act(name, args);
  check(label, op.status === 'succeeded', op);
  return op;
}
async function rejected(name, args, label = `${name} rejected`) {
  const op = await act(name, args);
  check(label, op.status === 'failed', op);
  return op;
}
async function block(position = target) { return (await body.observe(position)).block; }
async function guarded(position = target) { const observed = await block(position); return { ...position, expectedBlock: observed.id, expectedProperties: observed.properties }; }
async function stack(slot) { return (await body.observe()).inventory.find(item => item.slot === slot); }
function stackGuard(item) { return { slot: item.slot, expectedItem: item.id, expectedCount: item.count, expectedComponents: item.components }; }
async function select(slot) { return success('select-slot', stackGuard(await stack(slot))); }
async function pose() { await fixture(`tp Claude ${origin.x} ${origin.y} ${origin.z}`); await delay(250); }
async function resetTarget(id = 'stone') {
  await fixture(`setblock ${marker} stone`);
  await fixture(`setblock ${target.x} ${target.y} ${target.z} ${id}`);
  await fixture('setblock 515 202 512 air');
  await pose();
}
async function placeArgs() { return { ...await guarded(anchor), face: 'up', ...stackGuard(await stack(1)) }; }
async function inventoryNbt() { return command('data get entity Claude Inventory'); }
async function serverBlockIs(position, id) { return (await command(`execute if block ${position.x} ${position.y} ${position.z} ${id}`)).trim() === 'Test passed'; }
function clickArgs(menu, slot, button = 0) {
  const item = menu.slots.find(value => value.slot === slot);
  return { containerId: menu.id, expectedRevision: menu.revision, slot, expectedItem: item.id, expectedCount: item.count, expectedComponents: item.components, expectedCarriedItem: menu.carried.id, expectedCarriedCount: menu.carried.count, expectedCarriedComponents: menu.carried.components, button };
}
async function menu() { return (await body.observe()).container; }

try {
  const props = readServerProps(serverDir);
  check('isolated ports only', props['server-port'] === '25568' && props['rcon.port'] === '25578');
  connection = await readServerConnection(connectionFile);
  check('expected isolated role/world', connection.username === 'Claude' && connection.worldId === 'serverbody-validation');
  check('backup evidence present', JSON.parse(await readFile('output/serverbody-B-backup.json', 'utf8')).serverStopped === true);
  await alone();
  await connect();
  const hello = await rpc('hello');
  check('B actions advertised', ['dig-block', 'place-block', 'open-container', 'click-slot', 'close-container', 'select-slot', 'drop-item'].every(name => hello.capabilities.includes(name)));
  check('test-only cancellation hooks enabled', hello.validationFixture?.enabled === true);
  check('non-OP bot', !JSON.parse(await readFile(resolve(serverDir, 'ops.json'), 'utf8')).some(item => item.name === 'Claude'));
  const initial = await body.observe();
  check('authority includes complete item components', initial.inventory.every(item => item.components && typeof item.components === 'object'));
  check('survival role', /0/.test(await command('data get entity Claude playerGameType')));
  await pose(); // Ensure the fixture chunk is loaded before writing blocks after a respawn elsewhere.
  await fixture('fill 511 200 509 523 200 516 stone');
  await fixture('fill 511 201 509 523 203 516 air');
  await fixture('kill @e[type=item,x=511,y=199,z=509,dx=12,dy=5,dz=7]');
  await pose();
  // This backed-up test NPC has no user-owned inventory; isolate measured contents.
  await fixture('clear Claude');
  await fixture('item replace entity Claude hotbar.0 with minecraft:iron_pickaxe');
  await fixture('item replace entity Claude hotbar.1 with minecraft:cobblestone 16');
  await fixture('item replace entity Claude hotbar.2 with minecraft:dirt 10');
  await select(0);
  await resetTarget();
  const pickBefore = await stack(0);
  const dig = await success('dig-block', await guarded(), 'ordinary survival dig completes');
  check('independent world confirms block removed', await serverBlockIs(target, 'air'));
  const pickAfter = await stack(0);
  check('dig wears the real selected tool', (pickAfter.components['minecraft:damage']?.value ?? 0) > (pickBefore.components['minecraft:damage']?.value ?? 0), { before: pickBefore, after: pickAfter });
  check('ordinary dig produces dropped cobblestone', (await command('execute if entity @e[type=item,x=516,y=201,z=512,distance=..4,nbt={Item:{id:"minecraft:cobblestone"}}]')).startsWith('Test passed'));
  const beforePickup = (await body.observe()).inventory.filter(s => s.id === 'minecraft:cobblestone').reduce((sum, s) => sum + s.count, 0);
  await delay(550);
  await success('move-to-position', { x: 516.5, y: 201, z: 512.5, tolerance: 0.3 }, 'walk to dropped item');
  await until('natural item pickup', async () => (await body.observe()).inventory.filter(s => s.id === 'minecraft:cobblestone').reduce((sum, s) => sum + s.count, 0) > beforePickup);
  check('native item pickup increments inventory', true);
  await resetTarget('air');
  const placing = await stack(1);
  await success('place-block', await placeArgs(), 'ordinary placement');
  check('independent world confirms exact placed block', await serverBlockIs(target, 'cobblestone'));
  check('placement consumes one real inventory item', (await stack(1)).count === placing.count - 1);
  const duplicateArgs = await placeArgs();
  await rejected('place-block', duplicateArgs, 'occupied target refused without an additional placement');
  check('occupied target preserves inventory', (await stack(1)).count === placing.count - 1);

  await resetTarget('obsidian');
  await select(8);
  const cancelled = await act('dig-block', { ...await guarded(), timeoutMs: 120000 }, false);
  check('slow dig really started', cancelled.status === 'running');
  await delay(300);
  await body.stop();
  check('stop cancels active dig', (await body.operation(cancelled.operationId)).status === 'cancelled');
  await delay(2200);
  check('no delayed break after stop', await serverBlockIs(target, 'obsidian'));
  await resetTarget(); await select(0);
  await success('dig-block', await guarded(), 'first fresh dig after stop succeeds');

  await resetTarget('obsidian'); await select(0);
  const changedTool = await act('dig-block', { ...await guarded(), timeoutMs: 120000 }, false);
  await fixture('item replace entity Claude hotbar.0 with minecraft:diamond_pickaxe');
  const changedTerminal = await until('changed tool rejection', async () => { const op = await body.operation(changedTool.operationId); return op.status !== 'running' && op; });
  check('tool change during digging rejected', changedTerminal.status === 'failed', changedTerminal);
  await delay(1300);
  check('changed tool cannot leave delayed break', await serverBlockIs(target, 'obsidian'));

  await resetTarget();
  const inventoryBeforeReject = await inventoryNbt();
  await rejected('dig-block', { ...await guarded(), expectedBlock: 'minecraft:dirt' }, 'stale block ID refused');
  await rejected('dig-block', { ...await guarded(), expectedProperties: { nonexistent: 'wrong' } }, 'stale block state refused');
  await fixture('setblock 522 201 512 stone');
  await rejected('dig-block', await guarded({ x: 522, y: 201, z: 512 }), 'out-of-reach dig refused');
  await fixture('setblock 515 202 512 stone');
  await rejected('dig-block', await guarded(), 'occluded dig refused');
  check('all precondition refusals leave inventory byte-for-byte equivalent text', await inventoryNbt() === inventoryBeforeReject);
  check('refused digs preserve target', await serverBlockIs(target, 'stone'));
  await fixture('setblock 515 202 512 air');

  const beforeBreakHook = (await rpc('hello')).validationFixture.breakCancelled;
  await fixture(`setblock ${marker} redstone_block`);
  const beforeProtected = await inventoryNbt();
  await rejected('dig-block', await guarded(), 'NeoForge BreakEvent cancellation honored');
  check('BreakEvent hook actually fired', (await rpc('hello')).validationFixture.breakCancelled > beforeBreakHook);
  check('cancelled break preserves block and tool', await serverBlockIs(target, 'stone') && await inventoryNbt() === beforeProtected);
  await fixture(`setblock ${marker} stone`);
  await success('dig-block', await guarded(), 'same block succeeds after removing break protection');

  await resetTarget('air');
  const beforePlaceHook = (await rpc('hello')).validationFixture.placeCancelled;
  await fixture(`setblock ${marker} gold_block`);
  const beforePlaceReject = await inventoryNbt();
  await rejected('place-block', await placeArgs(), 'NeoForge EntityPlaceEvent cancellation honored');
  check('EntityPlaceEvent hook actually fired', (await rpc('hello')).validationFixture.placeCancelled > beforePlaceHook);
  check('cancelled placement restores world and item count', await serverBlockIs(target, 'air') && await inventoryNbt() === beforePlaceReject);
  await fixture(`setblock ${marker} stone`);
  await success('place-block', await placeArgs(), 'same place succeeds without event protection');
  await resetTarget('air');
  const beforeRightHook = (await rpc('hello')).validationFixture.rightClickCancelled;
  await fixture(`setblock ${marker} diamond_block`);
  const beforeRightReject = await inventoryNbt();
  await rejected('place-block', await placeArgs(), 'NeoForge RightClickBlock cancellation honored');
  check('RightClickBlock hook actually fired', (await rpc('hello')).validationFixture.rightClickCancelled > beforeRightHook);
  check('right-click cancellation preserves inventory and world', await serverBlockIs(target, 'air') && await inventoryNbt() === beforeRightReject);
  await fixture(`setblock ${marker} stone`);

  // Original spawn is captured by the launch preparation, and restored in finally.
  oldSpawn = JSON.parse(await readFile('output/serverbody-B-spawn.json', 'utf8'));
  check('spawn protection is enabled with another OP identity', +props['spawn-protection'] > 0 && JSON.parse(await readFile(resolve(serverDir, 'ops.json'), 'utf8')).some(item => item.name === 'SBFixtureAdmin'));
  await fixture('setworldspawn 516 201 512');
  await resetTarget();
  const beforeSpawnReject = await inventoryNbt();
  await rejected('dig-block', await guarded(), 'vanilla spawn-protection dig refusal');
  check('spawn refusal preserves world and inventory', await serverBlockIs(target, 'stone') && await inventoryNbt() === beforeSpawnReject);
  await resetTarget('air');
  await rejected('place-block', await placeArgs(), 'vanilla spawn-protection place refusal');
  check('spawn refusal consumes no blocks', await serverBlockIs(target, 'air') && await inventoryNbt() === beforeSpawnReject);
  await fixture(`setworldspawn ${oldSpawn.x} ${oldSpawn.y} ${oldSpawn.z} ${oldSpawn.angle}`); oldSpawn = undefined;
  await success('place-block', await placeArgs(), 'same place succeeds outside spawn protection');

  await resetTarget('chest[facing=west]');
  await fixture('item replace block 516 201 512 container.0 with minecraft:diamond[minecraft:custom_name=\'{"text":"B original"}\'] 3');
  await success('open-container', await guarded(), 'ordinary standard chest opens');
  const initialMenu = await menu();
  check('menu includes authoritative revision and components', Number.isSafeInteger(initialMenu.revision) && initialMenu.slots.length === 63 && initialMenu.slots[0].components['minecraft:custom_name'] !== undefined, initialMenu);
  const stale = clickArgs(initialMenu, 0);
  await fixture('item replace block 516 201 512 container.0 with minecraft:diamond[minecraft:custom_name=\'{"text":"B changed"}\'] 3');
  await rejected('click-slot', stale, 'same ID/count with changed components rejected');
  check('component rejection leaves cursor empty', (await menu()).carried.count === 0);
  let current = await menu();
  await rejected('click-slot', { ...clickArgs(current, 0), expectedComponents: {} }, 'explicit wrong slot components rejected');
  current = await menu();
  const valid = clickArgs(current, 0);
  await success('click-slot', valid, 'one ordinary pickup takes chest stack');
  current = await menu();
  check('pickup changes exact slot/cursor count and components', current.slots[0].count === 0 && current.carried.count === 3 && isDeepStrictEqual(current.carried.components, valid.expectedComponents));
  await rejected('click-slot', valid, 'stale menu revision cannot double-pick');
  await rejected('click-slot', { ...clickArgs(current, 1), expectedCarriedComponents: {} }, 'wrong carried components rejected');
  current = await menu();
  await success('click-slot', clickArgs(current, 1, 1), 'right click deposits exactly one');
  current = await menu();
  check('right-click split preserves total and components', current.slots[1].count === 1 && current.carried.count === 2 && isDeepStrictEqual(current.slots[1].components, current.carried.components));
  await success('click-slot', clickArgs(current, 62), 'place remaining stack in empty player hotbar');
  current = await menu();
  check('transfer total is conserved', current.slots[1].count === 1 && current.slots[62].count === 2 && current.carried.count === 0);
  // Close with cursor stack exercises native removed()/return-to-inventory rather than deletion.
  await success('click-slot', clickArgs(current, 1));
  current = await menu();
  await rejected('close-container', { containerId: current.id, expectedRevision: current.revision - 1 }, 'stale close rejected');
  await success('close-container', { containerId: current.id, expectedRevision: current.revision }, 'native close with carried item');
  check('close clears menu and preserves all three named diamonds', (await menu()) === null && (await body.observe()).inventory.filter(s => s.id === 'minecraft:diamond').reduce((sum, s) => sum + s.count, 0) === 3);
  check('independent chest contents are empty after transfer', (await command('data get block 516 201 512 Items')).includes('[]'));
  await success('open-container', await guarded());
  const secondMenu = await menu();
  check('new window has different identity', secondMenu.id !== initialMenu.id);
  await rejected('click-slot', stale, 'old window cannot act on new window');
  await rejected('click-slot', { ...clickArgs(secondMenu, 0), slot: 99999 }, 'invalid slot refused');
  await fixture('setblock 530 200 512 stone');
  await fixture('tp Claude 530.5 201 512.5');
  await rejected('click-slot', clickArgs(secondMenu, 0), 'distant or closed menu cannot be clicked');
  await pose();
  if (await menu()) { const m = await menu(); await success('close-container', { containerId: m.id, expectedRevision: m.revision }); }

  // Typed NBT values must remain distinguishable through JSON and the JavaScript runtime.
  await fixture('item replace block 516 201 512 container.0 with minecraft:diamond[minecraft:custom_data={kind:1b,big:9007199254740993L}] 3');
  await success('open-container', await guarded());
  const byteMenu = await menu(), byteGuard = clickArgs(byteMenu, 0);
  await fixture('item replace block 516 201 512 container.0 with minecraft:diamond[minecraft:custom_data={kind:1,big:9007199254740993L}] 3');
  let typedMenu = await menu();
  check('custom NBT byte and int remain distinct in observation', !isDeepStrictEqual(byteMenu.slots[0].components, typedMenu.slots[0].components));
  await rejected('click-slot', { ...byteGuard, expectedRevision: typedMenu.revision }, 'same ID/count with stale NBT type rejected even at current revision');
  const longGuard = clickArgs(typedMenu, 0);
  await fixture('item replace block 516 201 512 container.0 with minecraft:diamond[minecraft:custom_data={kind:1,big:9007199254740992L}] 3');
  typedMenu = await menu();
  check('custom NBT long beyond JS precision remains exact', !isDeepStrictEqual(longGuard.expectedComponents, typedMenu.slots[0].components));
  await rejected('click-slot', { ...longGuard, expectedRevision: typedMenu.revision }, 'stale precise long cannot authorize item pickup');
  typedMenu = await menu();
  await success('click-slot', clickArgs(typedMenu, 0), 'current typed-NBT stack can be picked up');
  const carriedComponents = (await menu()).carried.components;
  await body.stop();
  check('stop closes menu and preserves carried components in inventory', await menu() === null && (await body.observe()).inventory.some(item => item.count === 3 && isDeepStrictEqual(item.components, carriedComponents)));

  await select(2);
  const dropBefore = await stack(2);
  await success('drop-item', { ...stackGuard(dropBefore), count: 3 }, 'ordinary drop emits requested count');
  check('drop consumes exact count from selected hand', (await stack(2)).count === dropBefore.count - 3);
  check('independent dropped item exists', (await command('execute if entity @e[type=item,x=514,y=201,z=512,distance=..6,nbt={Item:{id:"minecraft:dirt"}}]')).startsWith('Test passed'));
  const guard = stackGuard(await stack(2));
  await rejected('drop-item', { ...guard, count: guard.expectedCount + 1 }, 'overdrop refused');
  await rejected('drop-item', { ...guard, expectedComponents: { bad: true }, count: 1 }, 'changed stack cannot be dropped');
  check('drop refusals preserve hand count', (await stack(2)).count === guard.expectedCount);

  const beforeDuplicate = await stack(2), observedGeneration = (await body.observe()).controlGeneration;
  const rawDrop = { instanceId: lease.instanceId, sessionId: lease.sessionId, leaseId: lease.leaseId, controlGeneration: observedGeneration, operationId: randomUUID(), name: 'drop-item', args: { ...stackGuard(beforeDuplicate), count: 1 } };
  const dropReceipt = await rpc('act', rawDrop), duplicateReceipt = await rpc('act', rawDrop);
  check('same operation ID drop returns same receipt without repeating side effects', dropReceipt.status === 'succeeded' && isDeepStrictEqual(dropReceipt, duplicateReceipt) && (await stack(2)).count === beforeDuplicate.count - 1);
  const conflicting = await wire('act', { ...rawDrop, args: { ...rawDrop.args, count: 2 } });
  check('conflicting reused drop ID refused without additional consumption', !conflicting.ok && conflicting.error.code === 'OPERATION_CONFLICT' && (await stack(2)).count === beforeDuplicate.count - 1);

  // Independent raw controller intentionally has no heartbeat; begin near expiry.
  await resetTarget('obsidian'); await select(8);
  await body.close(); body = undefined;
  const fresh = await rpc('hello');
  const rawLease = await rpc('claim', { instanceId: fresh.instanceId, worldId: connection.worldId, username: connection.username, controllerId: randomUUID() });
  const scope = { instanceId: rawLease.instanceId, sessionId: rawLease.sessionId, leaseId: rawLease.leaseId };
  await delay(8100);
  const slow = await rpc('act', { ...scope, controlGeneration: rawLease.controlGeneration, operationId: randomUUID(), name: 'dig-block', args: { ...target, expectedBlock: 'minecraft:obsidian', expectedProperties: {}, timeoutMs: 120000 } });
  check('raw dig active shortly before lease expires', slow.status === 'running');
  await delay(3800);
  check('lease expiry cannot be revived by heartbeat', !(await wire('heartbeat', scope)).ok);
  check('expired dig leaves no delayed block break', await serverBlockIs(target, 'obsidian'));
  await connect(); await resetTarget(); await select(0);
  await success('dig-block', await guarded(), 'new explicit lease can perform first dig');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = { message: error.message, code: error.code }; process.exitCode = 1; console.error(error.message);
} finally {
  try { if (oldSpawn) await fixture(`setworldspawn ${oldSpawn.x} ${oldSpawn.y} ${oldSpawn.z} ${oldSpawn.angle}`); } catch (error) { evidence.cleanup.push({ error: error.message }); process.exitCode = 1; }
  try { await fixture(`setblock ${marker} stone`); } catch (error) { evidence.cleanup.push({ error: error.message }); }
  if (body) { await body.close(); evidence.cleanup.push({ action: 'release', roleKeptOnline: true }); }
  evidence.finished = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Evidence ${output}`);
}
