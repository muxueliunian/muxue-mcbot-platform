#!/usr/bin/env node
// Isolated A regression: v2 drives Claude; Mineflayer is only a late observer/one-hit peer.
// RCON prepares explicit fixtures, initial positions, and independently reads authoritative NBT.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { rcon, readServerProps, tellrawCommand } from './rcon.mjs';

const usage = `node scripts/server-body-physics-smoke.mjs --connection-file <v2 connection.json> --server-dir <runtime/serverbody-validation> --output <evidence.json> --allow-fixture [--allow-human]
Requires the backed-up isolated NeoForge 1.21.1 server on 127.0.0.1:25568 (RCON 25578), pvp=true.
Does not launch servers, models, or Minecraft render clients. Mineflayer is only a test peer.
Writes a bounded stone/wall/gap fixture near 512.5,201,512.5; fixture tp is not movement evidence.
Exercises late join, HTTP movement/stop/new action/follow, obstacle/gap stop, natural fall damage,
one ordinary empty-hand player hit, kick/old-lease rejection/explicit reclaim and role uniqueness.
Finally releases control and quits the peer; Claude stays online. No saves are deleted or moved.
`;
const wait = ms => new Promise(done => setTimeout(done, ms));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const position = p => ({ x: p.x, y: p.y, z: p.z });
const origin = { x: 512.5, y: 201, z: 512.5 };
function insist(value, message) { if (!value) throw new Error(message); }
function inside(child, parent) { const path = relative(parent, child); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../')); }
function options(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    insist(['--connection-file', '--server-dir', '--output', '--allow-fixture', '--allow-human'].includes(arg), `Unknown argument ${arg}`);
    insist(opt[arg.slice(2)] === undefined, `Repeated argument ${arg}`);
    if (arg.startsWith('--allow-')) opt[arg.slice(2)] = true;
    else { insist(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing ${arg} value`); opt[arg.slice(2)] = argv[++i]; }
  }
  for (const key of ['connection-file', 'server-dir', 'output']) { insist(opt[key], `Required --${key}`); opt[key] = resolve(opt[key]); }
  insist(opt['allow-fixture'], 'Explicit --allow-fixture is required; back up this test world first');
  const authorized = resolve(fileURLToPath(new URL('../runtime/serverbody-validation', import.meta.url)));
  insist(opt['server-dir'].toLowerCase() === authorized.toLowerCase(), 'Only runtime/serverbody-validation is authorized');
  insist(opt['connection-file'].toLowerCase() === resolve(authorized, 'config/mcbot-server-control/connection.json').toLowerCase(), 'Use this isolated server control connection file');
  insist(!inside(opt.output, authorized) && extname(opt.output).toLowerCase() === '.json', 'Evidence must be a JSON file outside the test server');
  return opt;
}
async function bounded(promise, label, ms = 6500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function main() {
  const opt = options(process.argv.slice(2));
  if (opt.help) { console.log(usage); return; }
  const started = performance.now(), stamp = () => Math.round(performance.now() - started);
  const evidence = { schema: 1, protocol: 2, started: new Date().toISOString(), serverDir: opt['server-dir'], origin,
    boundary: 'v2 actions control Claude; RCON fixture setup/initial tp and independent reads; Mineflayer late observer and exactly one normal empty-hand attack',
    allowFixture: true, allowHuman: !!opt['allow-human'], checks: [], commands: [], operations: [], peer: null, heartbeats: [], cleanup: [] };
  let connection, hello, lease, scope, peer, uuid, generation, heartbeatTimer, heartbeatFlight;
  let heartbeatPaused = false, mutationsAllowed = false;
  const acquiredChunks = [];
  function check(name, truth, detail) {
    evidence.checks.push({ name, passed: !!truth, atMs: stamp(), ...(detail === undefined ? {} : { detail }) });
    insist(truth, `Assertion failed: ${name}`); console.log(`PASS ${name}`);
  }
  async function wire(method, params = {}) {
    const response = await fetch(connection.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5500),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ method, params }) });
    return { status: response.status, ...await response.json() };
  }
  async function rpc(method, params = {}) {
    const reply = await wire(method, params);
    if (!reply.ok) throw Object.assign(new Error(`${method}: ${reply.error?.code ?? 'BAD_RESPONSE'}: ${reply.error?.message ?? 'Request rejected'}`), { code: reply.error?.code });
    return reply.result;
  }
  async function claim() {
    hello = await rpc('hello');
    lease = await rpc('claim', { instanceId: hello.instanceId, worldId: connection.worldId, username: connection.username, controllerId: randomUUID() });
    scope = { instanceId: lease.instanceId, sessionId: lease.sessionId, leaseId: lease.leaseId }; generation = lease.controlGeneration;
    insist(Number.isSafeInteger(generation), 'Claim must include generation');
  }
  const observe = () => rpc('observe', scope);
  async function stop() {
    const result = await rpc('stop', scope);
    insist(result.stopped && result.controlGeneration === generation + 1, 'Stop must increment control generation exactly once');
    generation = result.controlGeneration; return result;
  }
  async function act(name, args) {
    await authorizeMutation();
    const operationId = randomUUID();
    const result = await rpc('act', { ...scope, controlGeneration: generation, operationId, name, args });
    evidence.operations.push({ atMs: stamp(), name, args, result }); return result;
  }
  async function operation(id) { return rpc('operation', { ...scope, operationId: id }); }
  async function terminal(op, ms = 10000) {
    return until(`${op.name} terminal`, async () => { const current = await operation(op.operationId); return current.status !== 'running' ? current : false; }, ms);
  }
  async function until(label, read, ms = 12000) {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      if (!heartbeatPaused) insist(!evidence.heartbeats.some(item => item.error), 'Unexpected heartbeat failure');
      const value = await bounded(Promise.resolve().then(read), label);
      if (value) return value;
      await wait(100);
    }
    throw new Error(`${label}: timeout ${ms}ms`);
  }
  async function command(text) {
    const [reply] = await bounded(rcon([text], { serverDir: opt['server-dir'], timeoutMs: 5000 }), `RCON ${text}`);
    evidence.commands.push({ atMs: stamp(), command: text, reply }); return reply;
  }
  async function onlineNames() {
    const reply = (await command('list')).trim(), match = reply.match(/:\s*([^\r\n]*)$/);
    insist(match || /There are 0\b/.test(reply), 'Cannot parse online player list; refuse mutations');
    return match ? match[1].split(',').map(name => name.trim()).filter(Boolean) : [];
  }
  async function authorizeMutation() {
    insist(mutationsAllowed, 'Fixture mutation is not authorized');
    const names = (await onlineNames()).filter(name => !['Claude', peer?.name].includes(name));
    insist(opt['allow-human'] || names.length === 0, `Human players present: ${names.join(', ')}`);
  }
  async function mutate(text) { await authorizeMutation(); return command(text); }
  const passed = reply => /^Test passed(?:, count: 1)?$/i.test(reply.trim());
  async function data(field) {
    const reply = await command(`data get entity Claude ${field}`), at = reply.indexOf(':');
    insist(at >= 0 && /following entity data/i.test(reply), `Cannot read Claude ${field}`);
    return reply.slice(at + 1).trim();
  }
  async function nbtState() {
    const values = {};
    for (const field of ['Pos', 'Health', 'OnGround', 'Motion', 'playerGameType']) values[field] = await data(field);
    const vector = text => {
      const parts = text.replace(/^\[/, '').replace(/\]$/, '').split(',').map(value => Number(value.trim().replace(/[dDfF]$/, '')));
      insist(parts.length === 3 && parts.every(Number.isFinite), 'Invalid NBT vector');
      return { x: parts[0], y: parts[1], z: parts[2] };
    };
    return { position: vector(values.Pos), health: Number(values.Health.replace(/[fFdD]$/, '')), onGround: values.OnGround === '1b', motion: vector(values.Motion), gameType: Number(values.playerGameType) };
  }
  async function bodyUuid() {
    const reply = await data('UUID'), match = reply.match(/^\[I;\s*([-+\d,\s]+)\]$/);
    insist(match, 'Claude UUID is not an integer array');
    const fields = match[1].split(',').map(value => Number(value.trim()));
    insist(fields.length === 4 && fields.every(Number.isInteger), 'Invalid Claude UUID fields');
    const bytes = Buffer.alloc(16); fields.forEach((value, index) => bytes.writeInt32BE(value, index * 4));
    const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  async function uniqueRole(expectedUuid) {
    const reply = await command('execute as @a[name=Claude] run data get entity @s UUID');
    const arrays = [...reply.matchAll(/\[I;\s*([-+\d,\s]+)\]/g)].map(match => match[1].split(',').map(value => Number(value.trim())));
    const bytes = Buffer.from(expectedUuid.replaceAll('-', ''), 'hex'), expected = Array.from({ length: 4 }, (_, index) => bytes.readInt32BE(index * 4));
    check('one independently registered Claude with expected UUID', arrays.length === 1 && arrays[0].every((value, index) => value === expected[index]), { arrays, expected });
  }
  async function fixture() {
    // Bot's normal PLAYER ticket should already load the entire bounded fixture footprint.
    // Only setup may temporarily preload missing chunks; these are removed before physical tests.
    for (let cx = 31; cx <= 33; cx++) for (let cz = 31; cz <= 32; cz++) {
      const chunk = { x: cx * 16, z: cz * 16 };
      if (passed(await command(`execute if loaded ${chunk.x} 201 ${chunk.z}`))) continue;
      const query = (await command(`forceload query ${chunk.x} ${chunk.z}`)).trim();
      insist(/is (?:not )?marked for force loading/i.test(query), 'Unknown forceload state');
      if (/is not marked/i.test(query)) { await mutate(`forceload add ${chunk.x} ${chunk.z}`); acquiredChunks.push(chunk); }
      await until('fixture setup chunk ready', async () => passed(await command(`execute if loaded ${chunk.x} 201 ${chunk.z}`)));
    }
    const setup = [
      'fill 508 201 508 532 213 516 minecraft:air',
      'fill 508 200 508 532 200 516 minecraft:stone',
      'fill 520 201 508 520 204 516 minecraft:stone',
      'fill 530 200 508 532 200 516 minecraft:air',
    ];
    for (const text of setup) {
      const reply = await mutate(text);
      check('bounded fixture write accepted', /Successfully filled \d+ block|No blocks were filled/i.test(reply) && !/not loaded|incorrect|unknown|failed/i.test(reply), { command: text, reply });
    }
    while (acquiredChunks.length) {
      const chunk = acquiredChunks[0];
      const reply = await mutate(`forceload remove ${chunk.x} ${chunk.z}`);
      insist(/unmarked chunk|unmarked \d+ chunks/i.test(reply), 'Setup preload removal failed');
      evidence.cleanup.push({ action: 'setupForceloadRemovedBeforeTests', chunk, reply });
      acquiredChunks.shift();
    }
  }
  async function fixtureBodyPosition(target, settle = true) {
    await stop();
    const reply = await mutate(`tp Claude ${target.x.toFixed(4)} ${target.y.toFixed(4)} ${target.z.toFixed(4)}`);
    insist(reply.trim().startsWith('Teleported Claude to '), 'Fixture initial position tp failed');
    evidence.operations.push({ atMs: stamp(), fixtureOnly: true, name: 'initial-position-tp', target, notMovementEvidence: true });
    if (settle) await until('body fixture position grounded', async () => { const current = await nbtState(); return current.onGround && distance(current.position, target) < 0.15 ? current : false; });
  }
  async function mode(modeName) {
    const reply = await mutate(`gamemode ${modeName} ${peer.name}`), actual = await command(`execute if entity @a[name=${peer.name},gamemode=${modeName}]`);
    check(`peer ${modeName} mode independently verified`, passed(actual), { reply, actual });
  }
  async function peerPosition(target) {
    const reply = await mutate(`tp ${peer.name} ${target.x.toFixed(4)} ${target.y.toFixed(4)} ${target.z.toFixed(4)}`);
    insist(reply.trim().startsWith(`Teleported ${peer.name} to `), 'Observer fixture tp failed');
    await until('peer actual position', () => peer.bot.entity && distance(peer.bot.entity.position, target) < 0.25);
  }
  const visible = () => peer ? Object.values(peer.bot.entities).filter(entity => entity.uuid === uuid) : [];
  async function attachPeer() {
    const require = createRequire(new URL('../mcp-server/package.json', import.meta.url)), mineflayer = require('mineflayer');
    const name = `SBPhys${randomUUID().slice(0, 8)}`;
    insist(!(await onlineNames()).includes(name), 'Test peer username unexpectedly occupied');
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: name, auth: 'offline', version: '1.21.1', hideErrors: true });
    peer = { name, bot, closed: false, sequence: 0, packets: [], errors: [], bodyEntityId: undefined };
    evidence.peer = { name, packets: peer.packets, errors: peer.errors }; bot.physicsEnabled = false;
    bot.on('error', error => peer.errors.push({ atMs: stamp(), message: error.message }));
    bot.on('kicked', reason => peer.errors.push({ atMs: stamp(), kicked: String(reason) }));
    bot.on('end', () => { peer.closed = true; });
    bot._client.on('packet', (packet, meta) => {
      if (!packet || !meta) return; // Bundle delimiters may contain no payload.
      let entry;
      if (meta.name === 'player_info') entry = { packet: meta.name, action: packet.action, players: (packet.data ?? []).map(item => ({ uuid: item.uuid, name: item.player?.name, listed: item.listed })) };
      else if (meta.name === 'spawn_entity') entry = { packet: meta.name, uuid: packet.objectUUID, entityId: packet.entityId, type: packet.type, position: { x: packet.x, y: packet.y, z: packet.z } };
      else if (meta.name === 'player_remove') entry = { packet: meta.name, uuids: packet.players ?? [] };
      else if (meta.name === 'entity_destroy') entry = { packet: meta.name, entityIds: packet.entityIds ?? [] };
      else if (Number.isInteger(peer.bodyEntityId) && packet.entityId === peer.bodyEntityId && ['entity_velocity', 'entity_teleport', 'rel_entity_move', 'entity_move_look', 'entity_status', 'damage_event'].includes(meta.name)) entry = { packet: meta.name, entityId: packet.entityId, data: packet };
      if (entry && peer.packets.length < 8000) peer.packets.push({ seq: ++peer.sequence, atMs: stamp(), ...entry });
    });
    await until('late observer joins', () => { insist(!peer.closed, 'Observer disconnected while joining'); return bot.entity; }, 18000);
    await mode('spectator'); await peerPosition({ x: origin.x + 2, y: origin.y + 1, z: origin.z + 2 });
    await visibleCheck('late observer');
  }
  async function visibleCheck(label, afterSeq = 0) {
    await until(`${label} body entity visibility`, () => visible().length === 1 && peer.packets.some(packet => packet.packet === 'spawn_entity' && packet.uuid === uuid && packet.seq > afterSeq), 15000);
    const spawn = peer.packets.find(packet => packet.packet === 'spawn_entity' && packet.uuid === uuid && packet.seq > afterSeq);
    const info = peer.packets.find(packet => packet.packet === 'player_info' && packet.seq < spawn.seq && packet.seq > afterSeq && packet.players.some(player => player.uuid === uuid && player.name === 'Claude') && (packet.action?.add_player === true || packet.action === 'add_player' || (typeof packet.action === 'number' && (packet.action & 1) !== 0)));
    check(`${label}: PlayerInfo before player entity`, !!info, { infoSeq: info?.seq, spawnSeq: spawn.seq, entityId: spawn.entityId, uuid });
    check(`${label}: one real player entity`, visible().length === 1 && visible()[0].type === 'player', visible().map(entity => ({ entityId: entity.id, type: entity.type, username: entity.username })));
    peer.bodyEntityId = visible()[0].id;
  }
  async function stable(label) {
    await wait(650); const a = await observe(); await wait(650); const b = await observe();
    const seen = visible()[0]?.position;
    check(label, a.connected && b.connected && distance(a.position, b.position) < 0.03, { a: a.position, b: b.position });
    check(`${label}: peer/server position convergence`, !!seen && distance(seen, b.position) < 0.2, { peer: seen ? position(seen) : null, server: b.position });
    return b;
  }
  function startHeartbeats() {
    heartbeatTimer = setInterval(() => {
      if (heartbeatPaused || !scope || heartbeatFlight) return;
      const current = { ...scope };
      heartbeatFlight = rpc('heartbeat', current).then(result => {
        if (evidence.heartbeats.length < 200) evidence.heartbeats.push({ atMs: stamp(), generation: result.controlGeneration });
      }).catch(error => evidence.heartbeats.push({ atMs: stamp(), error: error.code ?? error.message })).finally(() => { heartbeatFlight = undefined; });
    }, 1500);
  }

  try {
    const props = readServerProps(opt['server-dir']);
    evidence.serverProperties = { host: props['server-ip'], gamePort: Number(props['server-port']), rconPort: Number(props['rcon.port']), pvp: props.pvp, difficulty: props.difficulty };
    check('strict isolated loopback game/RCON scope', props['server-ip'] === '127.0.0.1' && Number(props['server-port']) === 25568 && Number(props['rcon.port']) === 25578);
    check('server pvp=true before any fixture', props.pvp === 'true');
    const names = await onlineNames(); check('no human mutations without explicit authorization', opt['allow-human'] || names.every(name => name === 'Claude'), { names });
    connection = JSON.parse(await readFile(opt['connection-file'], 'utf8'));
    const endpoint = new URL(connection.endpoint);
    check('selected server v2 connection', connection.protocol === 2 && connection.backend === 'server' && connection.username === 'Claude' && connection.worldId === 'serverbody-validation' && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port === '8766' && endpoint.pathname === '/v2' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
    hello = await rpc('hello'); evidence.initialHello = hello;
    check('A declares only four supported actions', JSON.stringify([...hello.capabilities].sort()) === JSON.stringify(['send-chat', 'look-at', 'move-to-position', 'follow-player'].sort()));
    evidence.initialIndependentState = hello.connected ? await nbtState() : { exists: false };
    await claim(); startHeartbeats(); evidence.initialObservation = await observe(); uuid = await bodyUuid();
    const ops = JSON.parse(await readFile(resolve(opt['server-dir'], 'ops.json'), 'utf8'));
    check('configured Claude identity is not OP', !ops.some(player => player.uuid === uuid || player.name === 'Claude'));
    await uniqueRole(uuid); mutationsAllowed = true;
    if (opt['allow-human']) await command(tellrawCommand('[ServerBody physics test] Isolated fixtures: HTTP movement/stop, natural fall, one peer hit and explicit kick/reclaim. Claude stays online at completion.', { color: 'yellow' }));
    await until('body own chunk ready before setup/peer', async () => {
      const current = await observe(), block = { x: Math.floor(current.position.x), y: Math.floor(current.position.y) - 1, z: Math.floor(current.position.z) };
      return (await rpc('observe', { ...scope, block })).block?.state === 'loaded';
    });
    check('normal body ticket loads chunk before observer and fixture preloads', true);
    await fixture(); await fixtureBodyPosition(origin); await wait(3300);
    const normal = await nbtState(); check('non-OP survival body grounded on fixture', normal.gameType === 0 && normal.onGround && normal.health > 10, normal);
    await attachPeer();

    const first = await observe(), movement = await act('move-to-position', { x: first.position.x + 5, y: first.position.y, z: first.position.z, tolerance: 0.25, timeoutMs: 6000 });
    check('HTTP movement accepted', movement.status === 'running', movement);
    await wait(350); const moving = await observe(), observedMoving = visible()[0];
    check('HTTP movement physically displaces authoritative body', horizontal(first.position, moving.position) > 0.1, { before: first.position, during: moving.position });
    await until('peer sees moving body', () => visible()[0] && horizontal(first.position, visible()[0].position) > 0.1);
    check('observer sees actual HTTP movement', !!observedMoving && horizontal(first.position, visible()[0].position) > 0.1);
    const stopStart = performance.now(); await stop(); evidence.stopRpcMs = performance.now() - stopStart;
    check('stopped operation cancelled', (await operation(movement.operationId)).status === 'cancelled');
    const stopped = await stable('stop remains online and stationary');
    const newMovement = await act('move-to-position', { x: stopped.position.x, y: stopped.position.y, z: stopped.position.z - 2, tolerance: 0.3, timeoutMs: 5000 });
    const newTerminal = await terminal(newMovement); check('first new movement succeeds after stop', newTerminal.status === 'succeeded', newTerminal);
    await stable('new movement converges');

    await fixtureBodyPosition(origin); await peerPosition({ x: origin.x + 3, y: origin.y, z: origin.z + 2 });
    const followed = await act('follow-player', { player: peer.name, distance: 1.5, timeoutMs: 8000 });
    check('HTTP follow starts for ordinary observed peer', followed.status === 'running', followed);
    await until('follow reaches requested distance', async () => horizontal((await observe()).position, peer.bot.entity.position) <= 1.85);
    await stop(); check('follow stops without old-task resume', (await operation(followed.operationId)).status === 'cancelled'); await stable('follow stop remains stable');

    const wallStart = { x: 518.5, y: 201, z: 512.5 }; await fixtureBodyPosition(wallStart);
    const wall = await act('move-to-position', { x: 524.5, y: 201, z: 512.5, tolerance: 0.3, timeoutMs: 5000 });
    const wallTerminal = await terminal(wall), wallState = await observe();
    check('wall terminates action with explicit blocked failure', wallTerminal.status === 'failed' && /BLOCKED/.test(wallTerminal.summary), wallTerminal);
    check('wall collision prevents crossing', wallState.position.x >= wallStart.x && wallState.position.x <= 519.71, wallState.position); await stable('wall failure stays stopped');
    const edgeStart = { x: 528.5, y: 201, z: 512.5 }; await fixtureBodyPosition(edgeStart);
    const edge = await act('move-to-position', { x: 532.5, y: 201, z: 512.5, tolerance: 0.3, timeoutMs: 5000 });
    const edgeTerminal = await terminal(edge), edgeState = await nbtState();
    check('unsupported drop edge terminates with blocked failure', edgeTerminal.status === 'failed' && /BLOCKED/.test(edgeTerminal.summary), edgeTerminal);
    check('danger edge preserves support and height', edgeState.onGround && Math.abs(edgeState.position.y - 201) < 0.1 && edgeState.position.x < 529.9, edgeState); await stable('edge failure stays stopped');

    await fixtureBodyPosition(origin); await peerPosition({ x: origin.x + 2, y: origin.y + 1, z: origin.z + 2 });
    const beforeFall = await observe(); check('safe health reserve before fall', beforeFall.health > 10, { health: beforeFall.health });
    // Fixture-only initial placement in the air; gravity, collision and damage are normal entity ticks.
    await fixtureBodyPosition({ ...origin, y: origin.y + 8 }, false);
    const fall = { beforeHealth: beforeFall.health, fixtureHeight: origin.y + 8, samples: [] }; evidence.fall = fall;
    const landed = await until('natural fall lands on floor', async () => {
      const current = await observe(), state = await nbtState(); fall.samples.push({ atMs: stamp(), observation: current, nbt: state });
      return state.onGround && Math.abs(state.position.y - origin.y) < 0.1 ? { observation: current, nbt: state } : false;
    });
    check('gravity lowers body by eight blocks without movement act', fall.samples.some(sample => sample.nbt.position.y > origin.y + 1) && Math.abs(landed.nbt.position.y - origin.y) < 0.1, fall);
    check('normal fall damage from server authority', landed.observation.health > 0 && landed.observation.health < beforeFall.health, { before: beforeFall.health, after: landed.observation.health }); await stable('fall settles naturally');

    await stop(); await mode('survival');
    const ready = await observe(); await peerPosition({ x: ready.position.x - 2.5, y: ready.position.y, z: ready.position.z });
    const slot = Array.from({ length: 9 }, (_, index) => index).find(index => !peer.bot.inventory.slots[peer.bot.inventory.hotbarStart + index]);
    check('one-hit peer has an empty hotbar slot', slot !== undefined); peer.bot.setQuickBarSlot(slot); await wait(150);
    check('one-hit peer is empty handed', !peer.bot.heldItem);
    const target = visible()[0]; check('attack target is current visible real player', target?.id === peer.bodyEntityId && target?.type === 'player');
    await bounded(peer.bot.lookAt(target.position.offset(0, 1.2, 0), true), 'peer attack look', 2500); await wait(150);
    const beforeHit = await observe(), attacker = position(peer.bot.entity.position), observedBefore = position(target.position);
    const range = horizontal(attacker, beforeHit.position); check('one-hit starts within reach without overlap', range >= 2.3 && range <= 2.7 && Math.abs(attacker.y - beforeHit.position.y) < 0.2, { range, attacker, body: beforeHit.position });
    await authorizeMutation(); insist(peer.bot.entities[target.id] === target && !peer.closed, 'Peer lost target before hit; do not retry');
    const hit = { attempts: 1, before: beforeHit, attacker, observedBefore, packetMarker: peer.sequence, samples: [] }; evidence.hit = hit;
    const hitStart = performance.now(); peer.bot.attack(target); // Exactly one real interact_entity attack.
    for (let index = 1; index <= 10; index++) {
      const remaining = hitStart + index * 100 - performance.now(); if (remaining > 0) await wait(remaining);
      const current = await observe(), seen = visible()[0];
      hit.samples.push({ sinceAttackMs: Math.round(performance.now() - hitStart), observation: current, visible: seen ? { position: position(seen.position), velocity: position(seen.velocity) } : null });
    }
    hit.packets = peer.packets.filter(packet => packet.seq > hit.packetMarker && packet.entityId === peer.bodyEntityId);
    const away = { x: (beforeHit.position.x - attacker.x) / range, z: (beforeHit.position.z - attacker.z) / range };
    check('ordinary empty-hand hit causes server damage', hit.samples.some(sample => sample.observation.health < beforeHit.health) && hit.samples.every(sample => sample.observation.health > 0), { beforeHealth: beforeHit.health, health: hit.samples.map(sample => sample.observation.health) });
    check('hit motion is consumed as physical knockback without act', hit.samples.some(sample => horizontal(sample.observation.position, beforeHit.position) >= 0.1 && (sample.observation.position.x - beforeHit.position.x) * away.x + (sample.observation.position.z - beforeHit.position.z) * away.z >= 0.1), hit.samples.map(sample => ({ sinceAttackMs: sample.sinceAttackMs, position: sample.observation.position })));
    check('peer receives velocity and sees knockback', hit.packets.some(packet => packet.packet === 'entity_velocity') && hit.samples.some(sample => sample.visible && horizontal(sample.visible.position, observedBefore) >= 0.1), { packets: hit.packets, samples: hit.samples.map(sample => sample.visible) });
    const tail = hit.samples.slice(-3); check('one hit has no repeated damage', tail.every(sample => sample.observation.health >= tail[0].observation.health) && hit.attempts === 1, tail.map(sample => sample.observation.health)); await stable('single hit knockback converges');
    await mode('spectator');

    await fixtureBodyPosition(origin); const oldScope = { ...scope }, oldGeneration = generation, oldSession = scope.sessionId, oldEntity = peer.bodyEntityId, marker = peer.sequence;
    heartbeatPaused = true; if (heartbeatFlight) await heartbeatFlight;
    await mutate('kick Claude ServerBody A physics lifecycle test');
    await until('kick invalidates body control', async () => !(await rpc('hello')).connected);
    const deniedHeartbeat = await wire('heartbeat', oldScope); check('kicked old lease cannot heartbeat', !deniedHeartbeat.ok && ['WORLD_CHANGED', 'LEASE_LOST'].includes(deniedHeartbeat.error?.code), { code: deniedHeartbeat.error?.code });
    const deniedAct = await wire('act', { ...oldScope, controlGeneration: oldGeneration, operationId: randomUUID(), name: 'look-at', args: origin });
    check('kicked old controller cannot act', !deniedAct.ok && ['WORLD_CHANGED', 'LEASE_LOST'].includes(deniedAct.error?.code), { code: deniedAct.error?.code });
    await until('kick removes old peer-visible entity', () => visible().length === 0 && peer.packets.some(packet => packet.seq > marker && packet.packet === 'player_remove' && packet.uuids.includes(uuid)));
    scope = lease = undefined; await claim(); heartbeatPaused = false;
    check('explicit claim after kick creates new body session', scope.sessionId !== oldSession);
    check('explicit claim preserves configured UUID', await bodyUuid() === uuid); await uniqueRole(uuid); await visibleCheck('explicit reclaim after kick', marker);
    check('kick reclaim replaces entity rather than duplicating role', peer.bodyEntityId !== oldEntity, { oldEntity, newEntity: peer.bodyEntityId });
    await stable('reclaimed body keeps no old actions');
    check('observer has no protocol errors', peer.errors.length === 0, peer.errors); check('normal heartbeat chain survived test', !evidence.heartbeats.some(item => item.error));
    evidence.result = 'passed';
  } catch (error) {
    evidence.result = 'failed'; evidence.error = { message: error.message, code: error.code }; process.exitCode = 1; console.error(error.message);
  } finally {
    clearInterval(heartbeatTimer); heartbeatPaused = true; if (heartbeatFlight) await heartbeatFlight;
    if (scope) {
      try { await rpc('release', scope); evidence.cleanup.push({ action: 'release', retainedRole: (await rpc('hello')).connected }); }
      catch (error) { evidence.cleanup.push({ action: 'release', error: error.code ?? error.message }); process.exitCode = 1; }
    }
    if (peer && !peer.closed) {
      try { peer.bot.quit('ServerBody A physics observer finished'); await until('peer disconnect', () => peer.closed, 5000); evidence.cleanup.push({ action: 'peerQuit', name: peer.name }); }
      catch (error) { peer.bot._client.end(); evidence.cleanup.push({ action: 'peerQuit', error: error.message }); process.exitCode = 1; }
    }
    for (const chunk of acquiredChunks) {
      try { const reply = await command(`forceload remove ${chunk.x} ${chunk.z}`); insist(/unmarked chunk|unmarked \d+ chunks/i.test(reply), 'Fixture preload cleanup failed'); evidence.cleanup.push({ action: 'forceloadRemove', chunk, reply }); }
      catch (error) { evidence.cleanup.push({ action: 'forceloadRemove', chunk, error: error.message }); process.exitCode = 1; }
    }
    if (process.exitCode) evidence.result = 'failed'; evidence.finished = new Date().toISOString(); evidence.durationMs = stamp();
    await mkdir(dirname(opt.output), { recursive: true }); await writeFile(opt.output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8'); console.log(`Evidence: ${opt.output}`);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
