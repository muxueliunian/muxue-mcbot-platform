#!/usr/bin/env node
// Real-server spike verification only. RCON is an experimental entry, not a product API.
// Mineflayer observes packets (and attacks once in hit); Claude has no network client. Never starts a server.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { rcon, readServerProps, tellrawCommand } from './rcon.mjs';

const usage = `node scripts/server-body-spike-smoke.mjs --server-dir <isolated server> --output <JSON> --phase g0|g1|hit [--allow-fixture] [--allow-human] [--origin x,y,z]
Requires Minecraft 1.21.1, loopback port 25568 and the mcbot-server-spike Mod.
Default fixture origin: 512.5,201,512.5. Without --allow-fixture, prepare a clear level area there (or supply --origin).
G1 requires --allow-fixture: floor, wall and elevated fall platform are written only in this isolated area.
hit requires --allow-fixture: a survival test observer punches Claude once, then checks damage and knockback without active Bot movement.
Back up the test world first. Human presence refuses mutations unless --allow-human is explicit.
Exit 0: all assertions passed; exit 1: failed. Evidence is written even on failure.
`;
const wait = ms => new Promise(done => setTimeout(done, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function insist(condition, message) { if (!condition) throw new Error(message); }
async function bounded(promise, label, ms = 12000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    insist(['--server-dir', '--output', '--phase', '--allow-fixture', '--allow-human', '--origin'].includes(arg), `Unknown argument: ${arg}`);
    insist(result[arg.slice(2)] === undefined, `Repeated argument: ${arg}`);
    if (arg.startsWith('--allow-')) result[arg.slice(2)] = true;
    else { insist(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value: ${arg}`); result[arg.slice(2)] = argv[++i]; }
  }
  for (const key of ['server-dir', 'output', 'phase']) insist(result[key], `Required: --${key}`);
  insist(['g0', 'g1', 'hit'].includes(result.phase), 'phase must be g0, g1 or hit');
  insist(!['g1', 'hit'].includes(result.phase) || result['allow-fixture'], 'G1 and hit require explicit --allow-fixture');
  const origin = (result.origin ?? '512.5,201,512.5').split(',').map(Number);
  insist(origin.length === 3 && origin.every(Number.isFinite), '--origin requires finite x,y,z');
  insist(origin.every(n => Math.abs(n) < 100000) && origin[1] >= 80 && origin[1] <= 280, 'origin outside supported test bounds');
  result.origin = { x: origin[0], y: origin[1], z: origin[2] };
  result['server-dir'] = resolve(result['server-dir']); result.output = resolve(result.output);
  insist(result['server-dir'].toLowerCase() === resolve(fileURLToPath(new URL('../runtime/serverbody-validation', import.meta.url))).toLowerCase(), 'Only runtime/serverbody-validation is authorized for this spike script');
  insist(!result.output.toLowerCase().startsWith(`${result['server-dir'].toLowerCase()}\\`), 'Evidence must be outside the server directory');
  return result;
}

async function main() {
  const opt = options(process.argv.slice(2));
  if (opt.help) { console.log(usage); return; }
  const evidence = { schema: 1, phase: opt.phase, started: new Date().toISOString(), serverDir: opt['server-dir'], origin: opt.origin,
    boundary: 'Isolated spike commands; Mineflayer is a test observer, with one attacker in hit; no Claude protocol client',
    allowFixture: !!opt['allow-fixture'], allowHuman: !!opt['allow-human'], assertions: [], commands: [], observers: [], cleanup: [] };
  const observers = []; const acquiredChunks = []; const start = performance.now(); let mutationsAllowed = false; let ownedBody = false;
  const stamp = () => Math.round(performance.now() - start);
  function check(name, condition, details) {
    evidence.assertions.push({ name, passed: !!condition, atMs: stamp(), details });
    insist(condition, `Assertion failed: ${name}`); console.log(`PASS ${name}`);
  }
  async function command(text) {
    const [reply] = await bounded(rcon([text], { serverDir: opt['server-dir'], timeoutMs: 5000 }), `RCON ${text}`, 6000);
    evidence.commands.push({ atMs: stamp(), command: text, reply }); return reply;
  }
  async function humans() {
    const text = (await command('list')).trim();
    const match = text.match(/:\s*([^\r\n]*)$/);
    insist(match || /There are 0\b/.test(text), 'Cannot parse online player list; refuse mutation');
    const names = match ? match[1].split(',').map(s => s.trim()).filter(Boolean) : [];
    return names.filter(name => !['Claude', ...observers.map(o => o.name)].includes(name));
  }
  async function mutate(text) {
    insist(mutationsAllowed, 'Mutations not authorized for this server');
    const online = await humans();
    insist(opt['allow-human'] || online.length === 0, `Human players present: ${online.join(', ')}; use --allow-human only after notifying them`);
    return await command(text);
  }
  async function status() {
    const reply = await command('mcbot-spike status');
    const from = reply.indexOf('{'), to = reply.lastIndexOf('}');
    insist(from >= 0 && to >= from, `No status JSON: ${reply}`);
    return JSON.parse(reply.slice(from, to + 1));
  }
  function pos(s) {
    const p = s.pos ?? s.position ?? s;
    insist(['x', 'y', 'z'].every(k => Number.isFinite(p[k])), 'Status must contain finite position');
    return { x: p.x, y: p.y, z: p.z };
  }
  async function until(label, fn, ms = 10000) {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) { const value = await bounded(Promise.resolve().then(fn), label, 6500); if (value) return value; await bounded(wait(100), label, 200); }
    throw new Error(`${label}: timeout ${ms}ms`);
  }
  async function quit(observer) {
    if (observer.closed) return;
    observer.bot.quit('ServerBody spike observer finished');
    await until(`${observer.name} disconnect`, () => observer.closed, 5000);
  }
  async function observer(name) {
    const require = createRequire(new URL('../mcp-server/package.json', import.meta.url));
    const mineflayer = require('mineflayer');
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: name, auth: 'offline', version: '1.21.1', hideErrors: true });
    const o = { name, bot, closed: false, packets: [], errors: [], sequence: 0 }; observers.push(o);
    evidence.observers.push({ name, packets: o.packets, errors: o.errors });
    bot.physicsEnabled = false;
    bot.on('error', e => o.errors.push({ atMs: stamp(), message: e.message }));
    bot.on('kicked', reason => o.errors.push({ atMs: stamp(), kicked: String(reason) }));
    bot.on('end', () => { o.closed = true; });
    bot._client.on('packet', (packet, meta) => {
      let entry;
      if (meta.name === 'player_info') entry = { packet: meta.name, action: packet.action, players: packet.data.map(p => ({ uuid: p.uuid, name: p.player?.name, listed: p.listed })) };
      if (meta.name === 'spawn_entity') entry = { packet: meta.name, uuid: packet.objectUUID, entityId: packet.entityId, type: packet.type, pos: { x: packet.x, y: packet.y, z: packet.z } };
      if (meta.name === 'entity_destroy') entry = { packet: meta.name, entityIds: packet.entityIds };
      if (meta.name === 'player_remove') entry = { packet: meta.name, uuids: packet.players };
      if (opt.phase === 'hit' && packet && Number.isInteger(o.bodyEntityId) && packet.entityId === o.bodyEntityId && ['entity_velocity', 'entity_teleport', 'rel_entity_move', 'entity_move_look', 'entity_status', 'damage_event'].includes(meta.name)) entry = { packet: meta.name, entityId: packet.entityId, data: packet };
      if (entry) { if (o.packets.length < 6000) o.packets.push({ seq: ++o.sequence, atMs: stamp(), ...entry }); else o.errors.push({ message: 'packet evidence limit exceeded' }); }
    });
    await until(`${name} join`, () => { insist(!o.closed, `${name} disconnected: ${JSON.stringify(o.errors)}`); return bot.entity; }, 15000);
    const modeReply = await mutate(`gamemode spectator ${name}`);
    const modeCheck = await command(`execute if entity @a[name=${name},gamemode=spectator]`);
    check(`${name}: spectator mode confirmed`, /^Test passed(?:, count: 1)?$/i.test(modeCheck.trim()), { reply: modeReply, actual: modeCheck });
    await teleportObserver(o, { x: opt.origin.x + 2, y: opt.origin.y + 1, z: opt.origin.z + 2 });
    return o;
  }
  async function teleportObserver(o, target) {
    // Integer x/z arguments are centered by Minecraft; explicit decimals preserve fixture coordinates.
    const reply = await mutate(`tp ${o.name} ${target.x.toFixed(4)} ${target.y.toFixed(4)} ${target.z.toFixed(4)}`);
    check(`${o.name}: teleport command accepted`, reply.trim().startsWith(`Teleported ${o.name} to `), { reply, target });
    await until(`${o.name} authoritative position`, () => o.bot.entity && dist(o.bot.entity.position, target) < 0.25);
    check(`${o.name}: observer position confirmed`, dist(o.bot.entity.position, target) < 0.25, { actual: pos(o.bot.entity.position), target });
  }
  function infos(o, uuid) { return o.packets.filter(p => p.packet === 'player_info' && p.players.some(e => e.uuid === uuid && e.name === 'Claude') && (p.action?.add_player === true || p.action === 'add_player' || (typeof p.action === 'number' && (p.action & 1) !== 0))); }
  function spawns(o, uuid, after = 0) { return o.packets.filter(p => p.packet === 'spawn_entity' && p.uuid === uuid && p.seq > after); }
  function visible(o, uuid) { return Object.values(o.bot.entities).filter(e => e.uuid === uuid); }
  async function visibleCheck(o, s, name, after = 0) {
    await until(`${name} visibility`, () => visible(o, s.uuid).length === 1 && spawns(o, s.uuid, after).length > 0);
    const spawn = spawns(o, s.uuid, after)[0], info = infos(o, s.uuid).find(p => p.seq < spawn.seq);
    check(`${name}: PlayerInfo precedes player entity`, !!info, { infoSeq: info?.seq, spawnSeq: spawn.seq, uuid: s.uuid, entityId: spawn.entityId });
    check(`${name}: unique visible player`, visible(o, s.uuid).length === 1 && visible(o, s.uuid)[0].type === 'player', { entities: visible(o, s.uuid).map(e => ({ id: e.id, type: e.type, username: e.username })) });
  }
  async function spawn(p) {
    ownedBody = true;
    const reply = await mutate(`mcbot-spike spawn ${p.x} ${p.y} ${p.z}`);
    const s = await status();
    check('spawn exists', s.exists === true && s.registered === 1 && /^[0-9a-f-]{36}$/i.test(s.uuid) && Number.isInteger(s.entityId), { reply, status: s });
    check('ordinary non-OP survival player', s.gameMode === 'survival' && s.op === false, s);
    await entityCount(1, s.uuid); return s;
  }
  async function entityCount(expected, uuid) {
    const reply = await command('execute as @e[type=minecraft:player,name=Claude] run data get entity @s UUID');
    const arrays = [...reply.matchAll(/\[I;\s*([-+\d,\s]+)\]/g)].map(match => match[1].split(',').map(part => Number(part.trim())));
    const expectedArray = uuid ? Array.from({ length: 4 }, (_, index) => Buffer.from(uuid.replaceAll('-', ''), 'hex').readInt32BE(index * 4)) : undefined;
    check(`independent player entity count ${expected}`, arrays.length === expected && arrays.every(array => array.length === 4 && array.every((value, index) => value === expectedArray[index])), { reply, arrays, expectedArray });
  }
  async function remove(uuid) {
    const markers = new Map(observers.filter(o => !o.closed).map(o => [o, { seq: o.sequence, entityId: visible(o, uuid)[0]?.id }]));
    await mutate('mcbot-spike remove'); ownedBody = false;
    const s = await status();
    check('remove clears server body and registration', s.exists === false && s.registered === 0, s);
    await entityCount(0);
    for (const o of observers.filter(o => !o.closed)) {
      await until(`${o.name} removal`, () => visible(o, uuid).length === 0 && !o.bot.players.Claude);
      const marker = markers.get(o);
      check(`${o.name}: removed entity and player info`, o.packets.some(p => p.seq > marker.seq && p.packet === 'player_remove' && p.uuids.includes(uuid)) && (marker.entityId === undefined || o.packets.some(p => p.seq > marker.seq && p.packet === 'entity_destroy' && p.entityIds.includes(marker.entityId))), { uuid, marker });
    }
  }
  async function fixture() {
    if (!opt['allow-fixture']) return;
    const x = Math.floor(opt.origin.x), y = Math.floor(opt.origin.y), z = Math.floor(opt.origin.z);
    const chunks = [];
    for (let cx = Math.floor((x - 4) / 16); cx <= Math.floor((x + 20) / 16); cx++) {
      for (let cz = Math.floor((z - 4) / 16); cz <= Math.floor((z + 4) / 16); cz++) {
        const chunk = { x: cx * 16, z: cz * 16 }; chunks.push(chunk);
        const query = (await command(`forceload query ${chunk.x} ${chunk.z}`)).trim();
        insist(/is (?:not )?marked for force loading/i.test(query), `Unknown forceload query response: ${query}`);
        if (/is not marked/i.test(query)) {
          const reply = await mutate(`forceload add ${chunk.x} ${chunk.z}`);
          insist(/marked chunk|marked \d+ chunks/i.test(reply) && !/already|not|failed/i.test(reply), `Forceload add failed: ${reply}`);
          acquiredChunks.push(chunk);
        }
      }
    }
    await until('fixture chunks loaded', async () => {
      for (const chunk of chunks) {
        const reply = await command(`execute if loaded ${chunk.x} ${y} ${chunk.z}`);
        if (/Test failed/i.test(reply)) return false;
        insist(/^Test passed(?:, count: 1)?$/i.test(reply.trim()), `Unknown chunk load test response: ${reply}`);
      }
      return true;
    }, 15000);
    check('fixture chunks loaded before writes', true, { chunks, acquiredChunks });
    async function fixtureCommand(text) {
      const reply = await mutate(text);
      const success = text.startsWith('fill ') ? /Successfully filled \d+ block|No blocks were filled/i : /Changed the block|Could not set the block/i;
      check('fixture command accepted', success.test(reply) && !/not loaded|incorrect|unknown|failed/i.test(reply), { command: text, reply });
    }
    // 25 x 9 footprint, no global gamerule or weather changes, no existing builds expected.
    await fixtureCommand(`fill ${x - 4} ${y} ${z - 4} ${x + 20} ${y + 12} ${z + 4} minecraft:air`);
    await fixtureCommand(`fill ${x - 4} ${y - 1} ${z - 4} ${x + 20} ${y - 1} ${z + 4} minecraft:stone`);
    if (opt.phase === 'g1') {
      await fixtureCommand(`fill ${x + 8} ${y} ${z - 4} ${x + 8} ${y + 3} ${z + 4} minecraft:stone`);
      await fixtureCommand(`setblock ${x + 15} ${y + 8} ${z} minecraft:stone`);
    }
  }
  async function playerHit(o, s) {
    o.bodyEntityId = s.entityId;
    await until('spawn hit-damage grace elapsed', async () => {
      const now = await status();
      return now.exists && now.onGround && now.survivalTicks >= 65;
    });
    const modeReply = await mutate(`gamemode survival ${o.name}`);
    const modeCheck = await command(`execute if entity @a[name=${o.name},gamemode=survival]`);
    check('hit observer is a survival player', /^Test passed(?:, count: 1)?$/i.test(modeCheck.trim()), { reply: modeReply, actual: modeCheck });
    const ready = await status();
    await teleportObserver(o, { x: pos(ready).x - 2.5, y: pos(ready).y, z: pos(ready).z });
    const emptySlot = Array.from({ length: 9 }, (_, slot) => slot).find(slot => !o.bot.inventory.slots[o.bot.inventory.hotbarStart + slot]);
    check('hit observer has an empty hotbar slot', emptySlot !== undefined, { emptySlot });
    o.bot.setQuickBarSlot(emptySlot);
    await bounded(wait(150), 'empty hand synchronization', 350);
    check('hit uses an empty hand', !o.bot.heldItem, { slot: emptySlot, heldItem: o.bot.heldItem?.name ?? null });
    const target = visible(o, s.uuid).find(entity => entity.id === s.entityId && entity.type === 'player');
    check('hit targets the current real player entity', !!target, { expectedId: s.entityId, visible: visible(o, s.uuid).map(entity => ({ id: entity.id, type: entity.type })) });
    await bounded(o.bot.lookAt(target.position.offset(0, 1.2, 0), true), 'hit look at body', 2500);
    await bounded(wait(150), 'hit look synchronization', 350);
    const before = await status(), attacker = pos(o.bot.entity.position), observedBefore = pos(target.position);
    const range = horizontal(pos(before), attacker);
    check('hit starts in reach without player overlap', range >= 2.3 && range <= 2.7 && Math.abs(pos(before).y - attacker.y) < 0.2, { range, attacker, body: pos(before) });
    check('hit starts with no active Bot controls', before.controlActive === false && before.entityId === s.entityId && before.health > 0 && before.onGround, before);
    const online = await humans();
    check('human attack permission', opt['allow-human'] || online.length === 0, { online });
    insist(!o.closed && o.bot.entities[target.id] === target && target.uuid === s.uuid, 'Player reference lost before hit; refuse attack and do not retry');
    const hit = { before, attacker, observedBefore, attempts: 0, packetMarker: o.sequence, afters: [], motionPackets: [] };
    evidence.hit = hit;
    const attackedAt = performance.now(); hit.attackedAtMs = stamp();
    // Exactly one genuine client interact_entity attack, no synthetic damage command or retry.
    hit.attempts = 1; o.bot.attack(target);
    for (let sample = 1; sample <= 10; sample++) {
      const remaining = attackedAt + sample * 100 - performance.now();
      if (remaining > 0) await bounded(wait(remaining), 'hit sample interval', 250);
      const current = await status(), entity = o.bot.entities[s.entityId];
      hit.afters.push({ sinceAttackMs: Math.round(performance.now() - attackedAt), status: current,
        observed: entity?.uuid === s.uuid ? { entityId: entity.id, pos: pos(entity.position), velocity: pos(entity.velocity) } : null,
        attacker: pos(o.bot.entity.position) });
    }
    await bounded(wait(600), 'knockback convergence sample', 850);
    hit.settled = { status: await status(), observed: o.bot.entities[s.entityId]?.uuid === s.uuid ? pos(o.bot.entities[s.entityId].position) : null };
    hit.motionPackets = o.packets.filter(packet => packet.seq > hit.packetMarker && packet.entityId === s.entityId);
    const bodyBefore = pos(before), away = { x: (bodyBefore.x - attacker.x) / range, z: (bodyBefore.z - attacker.z) / range };
    const projections = hit.afters.map(sample => ({ sinceAttackMs: sample.sinceAttackMs, horizontal: horizontal(bodyBefore, pos(sample.status)),
      away: (pos(sample.status).x - bodyBefore.x) * away.x + (pos(sample.status).z - bodyBefore.z) * away.z }));
    hit.projections = projections;
    check('player-hit deals normal damage', hit.afters.some(sample => sample.status.health < before.health) && hit.afters.every(sample => sample.status.health > 0), { beforeHealth: before.health, health: hit.afters.map(sample => sample.status.health) });
    check('player-hit applies knockback', projections.some(sample => sample.horizontal >= 0.1 && sample.away >= 0.1), { before, attacker, projections, motionPackets: hit.motionPackets });
    check('knockback occurs without active Bot movement', hit.afters.every(sample => sample.status.controlActive === false && sample.status.movingTicks === before.movingTicks) && hit.settled.status.controlActive === false && hit.settled.status.movingTicks === before.movingTicks, { before, afters: hit.afters, settled: hit.settled });
    const last = hit.afters.at(-1), tail = hit.afters.slice(-3);
    check('single hit converges without repeated damage or motion', hit.attempts === 1 && tail.every(sample => sample.status.health >= tail[0].status.health) && hit.settled.status.health >= last.status.health && horizontal(pos(last.status), pos(hit.settled.status)) < 0.03, { tail, settled: hit.settled });
    check('observer sees body knockback', hit.afters.some(sample => sample.observed && horizontal(observedBefore, sample.observed.pos) >= 0.1), { observedBefore, afters: hit.afters.map(sample => ({ sinceAttackMs: sample.sinceAttackMs, observed: sample.observed })) });
  }

  try {
    const props = readServerProps(opt['server-dir']);
    check('isolated loopback test port', props['server-ip'] === '127.0.0.1' && +props['server-port'] === 25568);
    const online = await humans();
    check('human mutation permission', online.length === 0 || !!opt['allow-human'], { online });
    const initial = await status(); check('initially no Claude', initial.exists === false && initial.registered === 0, initial);
    await entityCount(0);
    mutationsAllowed = true;
    if (opt['allow-human']) await command(tellrawCommand('[ServerBody test] Isolated experiment: Claude will be spawned, removed and respawned. Test observers may teleport.', { color: 'yellow' }));
    await fixture();
    const a = await observer('SBObserveA');
    check('observer initially has no Claude', !a.bot.players.Claude && !Object.values(a.bot.entities).some(e => e.username === 'Claude'));
    let s = await spawn(opt.origin);
    await visibleCheck(a, s, 'existing observer');
    if (opt.phase === 'g0') {
      const duplicateReply = await mutate(`mcbot-spike spawn ${opt.origin.x} ${opt.origin.y} ${opt.origin.z}`);
      const duplicate = await status();
      check('duplicate spawn rejected and original remains', /already|exists|duplicate/i.test(duplicateReply) && duplicate.uuid === s.uuid && duplicate.entityId === s.entityId && duplicate.registered === 1, { reply: duplicateReply, status: duplicate });
      await entityCount(1, s.uuid);
      check('duplicate produces no second player entity', visible(a, s.uuid).length === 1 && spawns(a, s.uuid).length === 1);
      let b = await observer('SBObserveB'); await visibleCheck(b, s, 'late observer');
      const uuid = s.uuid, originalEntityId = s.entityId; await remove(uuid); s = await spawn(opt.origin);
      check('respawn preserves fixed UUID and replaces entity', s.uuid === uuid && s.entityId !== originalEntityId, { before: { uuid, entityId: originalEntityId }, after: s });
      await visibleCheck(a, s, 'respawn existing observer', a.packets.findLast(p => p.packet === 'player_remove' && p.uuids.includes(uuid))?.seq ?? 0);
      await quit(b); b = await observer('SBObserveB'); await visibleCheck(b, s, 'reconnected observer');
      const beforeKick = s, kickSeq = a.sequence;
      await mutate('kick Claude ServerBody smoke kick lifecycle');
      const kicked = await until('kick reconciles lifecycle', async () => { const now = await status(); return !now.exists && now.registered === 0 ? now : false; });
      ownedBody = false;
      check('vanilla kick unregisters body', kicked.exists === false && kicked.registered === 0, kicked);
      await entityCount(0);
      await until('kick clears observer player', () => !a.bot.players.Claude && visible(a, uuid).length === 0);
      check('kick notifies observers', a.packets.some(p => p.seq > kickSeq && p.packet === 'player_remove' && p.uuids.includes(uuid)));
      await mutate('mcbot-spike remove');
      const kickRemoved = await status(); check('remove after kick is idempotent', !kickRemoved.exists && kickRemoved.registered === 0, kickRemoved);
      s = await spawn(opt.origin);
      check('spawn after kick creates new body with fixed UUID', s.uuid === uuid && s.entityId !== beforeKick.entityId, { beforeKick, after: s });
      await visibleCheck(a, s, 'rebuilt after kick', kickSeq);
      const entityId = visible(a, uuid)[0].id, farSeq = a.sequence;
      await teleportObserver(a, { x: opt.origin.x + 1024, y: opt.origin.y + 1, z: opt.origin.z });
      await until('leave tracking range', () => visible(a, uuid).length === 0 && a.packets.some(p => p.seq > farSeq && p.packet === 'entity_destroy' && p.entityIds.includes(entityId)), 15000);
      check('tracking leave removes entity', true, { entityId, afterSeq: farSeq });
      const returnSeq = a.sequence;
      await teleportObserver(a, { x: opt.origin.x + 2, y: opt.origin.y + 1, z: opt.origin.z + 2 });
      await visibleCheck(a, s, 'tracking return', returnSeq);
      await remove(uuid);
    } else if (opt.phase === 'hit') {
      await playerHit(a, s);
      await remove(s.uuid);
    } else {
      await until('settle on fixture floor', async () => { const current = await status(); return current.onGround && Math.abs(pos(current).y - opt.origin.y) < 0.1; });
      const before = await status(); await mutate('mcbot-spike move 1 0 20');
      await bounded(wait(1600), 'finite movement settle', 1800); const moved = await status();
      check('finite physical movement', pos(moved).x - pos(before).x > 0.4 && pos(moved).x - pos(before).x < 7.5 && Math.abs(pos(moved).z - pos(before).z) < 0.3, { before, moved });
      check('timed movement expires', moved.controlActive === false && moved.movingTicks > before.movingTicks && moved.movingTicks - before.movingTicks <= 20, { before, moved });
      await bounded(wait(700), 'expired input stays inactive', 900); const expired = await status();
      check('inactive movement ticks do not grow', expired.controlActive === false && expired.movingTicks === moved.movingTicks, { moved, expired });
      await mutate('mcbot-spike move -1 0 100'); await bounded(wait(350), 'move before stop', 550);
      const preStop = await status(); await mutate('mcbot-spike stop'); await bounded(wait(600), 'stop settle', 800);
      const stopped = await status(); await bounded(wait(800), 'stop stability', 1000); const still = await status();
      check('stop clears movement and remains still', stopped.controlActive === false && still.controlActive === false && stopped.movingTicks === still.movingTicks && horizontal(pos(stopped), pos(still)) < 0.03, { preStop, stopped, still });
      await mutate('mcbot-spike move 0 1 8'); await bounded(wait(1000), 'new movement', 1200); const newMove = await status();
      check('new movement works after stop', pos(newMove).z - pos(still).z > 0.3 && Math.abs(pos(newMove).x - pos(still).x) < 0.1, { still, newMove });
      // Recreate only through the explicit spawn entry; never teleport Claude to fake movement.
      await remove(s.uuid); s = await spawn({ x: Math.floor(opt.origin.x) + 6.5, y: opt.origin.y, z: opt.origin.z });
      await mutate('mcbot-spike move 1 0 60'); await bounded(wait(3800), 'wall collision', 4000); const wall = await status();
      check('wall physically blocks movement', pos(wall).x > Math.floor(opt.origin.x) + 6.6 && pos(wall).x <= Math.floor(opt.origin.x) + 7.71, wall);
      await remove(s.uuid); s = await spawn({ x: Math.floor(opt.origin.x) + 15.5, y: Math.floor(opt.origin.y) + 9, z: opt.origin.z });
      await until('fall platform grounded', async () => (await status()).onGround);
      // ServerPlayer has a 60-tick spawn hurt grace period; a fresh body must outlive it.
      await until('spawn fall-damage grace elapsed', async () => (await status()).survivalTicks >= 65, 10000);
      const high = await status(); await mutate('mcbot-spike move 1 0 12');
      const landed = await until('fall lands', async () => { const now = await status(); return now.onGround && pos(now).y < pos(high).y - 6 ? now : false; });
      check('gravity lowers body onto floor', pos(high).y - pos(landed).y > 6 && Math.abs(pos(landed).y - opt.origin.y) < 0.1, { high, landed });
      check('normal fall damage', Number.isFinite(landed.health) && landed.health > 0 && landed.health < high.health, { beforeHealth: high.health, afterHealth: landed.health });
      const tickStart = await status(); await bounded(wait(1200), 'tick sample', 1400); const tickEnd = await status();
      const worldDelta = tickEnd.worldTicks - tickStart.worldTicks, survivalDelta = tickEnd.survivalTicks - tickStart.survivalTicks, serverDelta = tickEnd.serverTick - tickStart.serverTick;
      check('body ticks once per server tick', Number.isInteger(worldDelta) && worldDelta > 0 && worldDelta === serverDelta && survivalDelta === serverDelta && tickStart.duplicateSurvivalTicks === 0 && tickEnd.duplicateSurvivalTicks === 0, { tickStart, tickEnd, worldDelta, survivalDelta, serverDelta });
      await remove(s.uuid);
    }
    check('observers had no protocol errors', observers.every(o => o.errors.length === 0), observers.map(o => ({ name: o.name, errors: o.errors })));
    evidence.result = 'passed';
  } catch (error) { evidence.result = 'failed'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1; console.error(error.message); }
  finally {
    if (ownedBody) {
      try { const reply = await command('mcbot-spike stop'); evidence.cleanup.push({ action: 'stop', reply }); }
      catch (e) { evidence.cleanup.push({ action: 'stop', error: e.message }); process.exitCode = 1; }
      try {
        const online = await humans();
        if (opt['allow-human'] || online.length === 0) { const reply = await command('mcbot-spike remove'); evidence.cleanup.push({ action: 'remove', reply }); }
        else evidence.cleanup.push({ action: 'remove', skipped: 'Human joined without --allow-human; stopped body retained', humans: online });
      } catch (e) { evidence.cleanup.push({ action: 'remove', error: e.message }); process.exitCode = 1; }
    }
    for (const o of observers) { try { await bounded(quit(o), `${o.name} quit`, 6000); evidence.cleanup.push({ action: 'observerQuit', name: o.name, closed: o.closed }); } catch (e) { o.bot._client.end(); evidence.cleanup.push({ action: 'observerQuit', name: o.name, error: e.message }); process.exitCode = 1; } }
    for (const chunk of acquiredChunks) {
      try {
        const reply = await command(`forceload remove ${chunk.x} ${chunk.z}`);
        insist(/unmarked chunk|unmarked \d+ chunks/i.test(reply), `Forceload remove failed: ${reply}`);
        evidence.cleanup.push({ action: 'forceloadRemove', chunk, reply });
      } catch (e) { evidence.cleanup.push({ action: 'forceloadRemove', chunk, error: e.message }); process.exitCode = 1; }
    }
    evidence.finished = new Date().toISOString(); evidence.durationMs = stamp();
    if (process.exitCode) evidence.result = 'failed';
    await bounded(mkdir(dirname(opt.output), { recursive: true }), 'evidence directory', 5000);
    await bounded(writeFile(opt.output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8'), 'evidence write', 5000);
    console.log(`Evidence: ${opt.output}`);
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
