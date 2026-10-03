#!/usr/bin/env node
// Real local model trial. Fixture setup and independent reads use RCON; only the Agent controls the Body.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rcon, readServerProps } from './rcon.mjs';

const { values } = parseArgs({ options: { 'allow-real-agent': { type: 'boolean' }, agent: { type: 'string', default: 'claude' }, account: { type: 'string' } } });
assert(values['allow-real-agent'] && ['claude', 'codex'].includes(values.agent), 'Requires --allow-real-agent --agent claude|codex');
if (values.agent === 'claude') assert(['b', 'r', 'default'].includes(values.account), 'Choose the user-approved --account b|r|default');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'runtime/serverbody-validation'), props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-escort-backup.json'), 'utf8'));
assert(backup.serverStopped && backup.comparison === 'actual bytes');
const matrix = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-escort-latest.json'), 'utf8'));
assert.equal(matrix.result, 'passed', 'Complete the current program matrix before model calls');
const dir = path.join(root, 'output', `escort-agent-${values.agent}-${new Date().toISOString().replaceAll(':', '-')}`), runtime = path.join(dir, 'runtime');
await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'), mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'), '--username', 'ServerBot', '--world-id', 'serverbody-validation'] } } }));
const report = { started: new Date().toISOString(), agent: values.agent, account: values.account, model: values.agent === 'claude' ? 'claude-sonnet-5-5' : 'host default', effort: 'low', backup: backup.backup, phases: [], cleanup: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async text => (await rcon([text], { serverDir }))[0];
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
async function lines(file) {
  try { const text = await fs.readFile(file, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const peerEvents = () => lines(peerFile);
const driverText = () => fs.readFile(path.join(runtime, 'companion-ServerBot.log'), 'utf8').catch(() => '');
const journal = () => lines(path.join(runtime, 'events-ServerBot.jsonl'));
const operations = () => lines(path.join(runtime, 'operations-ServerBot.jsonl'));
async function until(check, message, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(150); }
  throw Error(message);
}
async function fixture(text) {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
  assert(names && names.every(name => ['ServerBot', 'C2Tester'].includes(name)), 'Unknown real player; fixture mutation refused');
  const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), reply); return reply;
}
async function position(name = 'ServerBot') {
  const coords = (await command(`data get entity ${name} Pos`)).match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(coords?.length === 3 && coords.every(Number.isFinite)); return { x: coords[0], y: coords[1], z: coords[2] };
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function itemCount(id) {
  const raw = await command(`data get entity ServerBot Inventory[{id:"${id}"}].count`);
  const value = raw.match(/entity data:\s*(\d+)[bs]?\s*$/); return value ? Number(value[1]) : 0;
}
async function request(name, message) {
  const start = Date.now(), offset = (await driverText()).length;
  await send({ type: 'chat', message });
  await until(async () => /本轮结束/.test((await driverText()).slice(offset)), name + ': no model turn end');
  const replies = (await peerEvents()).filter(event => event.type === 'chat' && event.username === 'ServerBot' && Date.parse(event.time) >= start);
  assert(replies.length, name + ': no in-game acknowledgement');
  const phase = { name, message, start, firstReplyMs: Date.parse(replies[0].time) - start, replies: replies.map(value => value.message), tools: [...(await driverText()).slice(offset).matchAll(/· ([^\s]+) (.*)/g)].map(value => ({ name: value[1], args: value[2] })) };
  report.phases.push(phase); console.log('PASS ' + name); return phase;
}
async function finite(name, message, taskName) {
  const phase = await request(name, message);
  await until(async () => (await operations()).some(record => record.timestamp >= phase.start && record.operation.name === taskName), name + ': no terminal operation');
  const record = (await operations()).find(record => record.timestamp >= phase.start && record.operation.name === taskName);
  assert.equal(record.operation.status, 'succeeded', record.operation.summary); phase.operation = record.operation;
  let reply;
  await until(async () => {
    reply = (await peerEvents()).find(event => event.type === 'chat' && event.username === 'ServerBot' && Date.parse(event.time) >= record.timestamp); return !!reply;
  }, name + ': no completion chat', 45000);
  await until(async () => (await driverText()).split('\n').some(line => {
    const stamp = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*本轮结束/);
    return stamp && new Date(stamp[1].replace(' ', 'T')).getTime() >= Date.parse(reply.time) - 999;
  }), name + ': completion turn not closed', 30000);
  phase.completion = reply.message; return phase;
}
async function spawnSideDrop(count) {
  const body = await position(), player = await position('C2Tester');
  const dx = player.x - body.x, dz = player.z - body.z, length = Math.hypot(dx, dz);
  assert(length > 0.3 && length < 3, 'Wait for normal near-player stand before drop');
  const drop = { x: (body.x + player.x) / 2 - dz / length * 2.5, y: 201.1, z: (body.z + player.z) / 2 + dx / length * 2.5 };
  assert(distance(drop, body) > 2 && distance(drop, player) > 2 && distance(drop, player) < 4);
  await fixture(`summon item ${drop.x.toFixed(3)} ${drop.y} ${drop.z.toFixed(3)} {Item:{id:"minecraft:cobblestone",count:${count}},PickupDelay:0}`);
  return drop;
}
async function walk(ms = 650) {
  const start = Date.now(); await send({ type: 'look-at', username: 'ServerBot' });
  await until(async () => (await peerEvents()).some(event => event.type === 'looked' && Date.parse(event.time) >= start), 'Player turn failed', 5000);
  await send({ type: 'walk', direction: 'back', ms });
  await until(async () => (await peerEvents()).some(event => event.type === 'position' && event.reason === 'walk-finished' && Date.parse(event.time) >= start), 'Player walk failed', 5000);
}
let peer, driver;
try {
  await fixture('forceload add 2400 2400 2444 2444');
  await fixture('fill 2400 200 2400 2444 200 2444 stone'); await fixture('fill 2400 201 2400 2444 204 2444 air');
  await fixture('kill @e[type=minecraft:item,x=2400,y=199,z=2400,dx=44,dy=8,dz=44]');
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile], { cwd: root, windowsHide: true, stdio: 'ignore' });
  await until(async () => (await peerEvents()).some(event => event.type === 'spawn'), 'Peer join failed', 30000);
  await fixture('tp ServerBot 2410.5 201 2422.5'); await fixture('tp C2Tester 2413 201 2422.5');
  await fixture('clear ServerBot'); await fixture('clear C2Tester');
  await fixture('item replace entity ServerBot hotbar.0 with minecraft:diamond_pickaxe');
  await fixture('item replace entity ServerBot hotbar.8 with minecraft:diamond 5');
  await fixture('summon item 2407.5 201.1 2422.5 {Item:{id:"minecraft:snowball",count:16},PickupDelay:0}'); await wait(400);
  const args = [path.join(root, 'scripts/companion.mjs'), '--agent', values.agent, '--body', 'server', '--name', 'ServerBot', '--nickname', '小克', '--mcp-config', mcpConfig, '--effort', 'low', '--headless'];
  if (values.agent === 'claude') args.push('--config-dir', path.join(process.env.USERPROFILE, values.account === 'default' ? '.claude' : `.claude-${values.account}`), '--model', report.model);
  driver = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, COMPANION_RUNTIME_DIR: runtime } });
  await until(async () => /本轮结束/.test(await driverText()), 'Agent startup failed');
  const snow = await finite('finite-group-pickup', '小克，只捡附近地上的一组雪球。', 'collect-items');
  assert.equal(snow.operation.result.pickedUpCount, 16); assert.equal(snow.operation.result.targetCount, 16);
  // New fixtures only after the finite completion reply; no active movement is being replaced here.
  await fixture('tp ServerBot 2410.5 201 2422.5'); await wait(300);
  const follow = await request('follow-with-authorized-pickup', '小克，持续跟着我，跟到两格半左右等我。顺手捡我四格内的圆石掉落物，只捡圆石，不挖方块。先回应一句。');
  assert(follow.tools.some(tool => tool.name.endsWith('companion-mode')), 'Model did not use persistent mode');
  await until(async () => distance(await position(), await position('C2Tester')) < 2.8, 'Follow never settled near player', 20000);
  const cursor = Date.now(); follow.drop1 = await spawnSideDrop(5);
  await until(async () => (await itemCount('minecraft:cobblestone')) === 5, 'First automatic pickup failed', 25000);
  await until(async () => distance(await position(), await position('C2Tester')) < 2.8, 'No return to follow after first pickup', 20000);
  follow.drop2 = await spawnSideDrop(7);
  await until(async () => (await itemCount('minecraft:cobblestone')) === 12, 'Second automatic pickup without new model instruction failed', 25000);
  await wait(1200);
  follow.inventoryAuthority = await command('data get entity ServerBot Inventory');
  const unsolicited = (await journal()).filter(event => event.timestamp >= cursor && ['task', 'companion'].includes(event.type));
  assert.equal(unsolicited.length, 0, 'Ordinary pickup completion woke the model'); follow.noPerItemWake = true;
  const chat = await request('chat-keeps-mode', '小克，你今天心情怎么样？');
  assert(!chat.tools.some(tool => tool.name.endsWith('stop-action')), 'Ordinary chat cancelled mode');
  const beforeWalk = await position(); await walk();
  await until(async () => distance(beforeWalk, await position()) > 1 && distance(await position(), await position('C2Tester')) < 2.8, 'Follow did not continue after pickup/chat', 20000);
  const stopAt = Date.now(), offset = (await driverText()).length;
  await send({ type: 'chat', message: '小克，停下。' });
  await until(async () => /身体控制已撤销/.test((await driverText()).slice(offset)), 'Independent stop was not confirmed', 15000);
  report.stopMs = Date.now() - stopAt; await wait(7000);
  const stopped = await position(); await walk(450); await wait(1200);
  assert(distance(stopped, await position()) < 0.2, 'Old persistent pickup/follow resumed after stop');
  report.phases.push({ name: 'independent-stop', ms: report.stopMs, stayedStopped: true });
  await fixture('tp ServerBot 2410.5 201 2422.5'); await fixture('tp C2Tester 2404.5 201 2416.5');
  await fixture('clear ServerBot minecraft:cobblestone');
  await fixture('setblock 2412 201 2421 stone'); await fixture('setblock 2412 201 2424 stone'); await wait(300);
  const gathered = await finite('first-new-task-gathers-two', '小克，采两块圆石，只挖附近的石头，把掉落捡起来。先说一句。', 'gather-resources');
  assert.equal(gathered.operation.result.targetCount, 2); assert.equal(gathered.operation.result.pickedUpCount, 2); assert.equal(gathered.operation.result.minedBlocks, 2);
  gathered.inventoryAuthority = await command('data get entity ServerBot Inventory');
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  if (driver && driver.exitCode === null) {
    await fs.writeFile(path.join(runtime, 'companion-ServerBot.stop'), '');
    await until(() => driver.exitCode !== null, 'Host close timeout', 20000).catch(() => {});
    if (driver.exitCode === null) { const killer = spawn('taskkill', ['/PID', String(driver.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await new Promise(resolve => killer.once('exit', resolve)); }
  }
  if (peer && peer.exitCode === null) { await send({ type: 'quit' }); await wait(2300); if (peer.exitCode === null) peer.kill(); }
  await command('forceload remove 2400 2400 2444 2444').catch(() => {});
  report.cleanup.push('Own model host/test player closed and fixture forcechunks removed; server remains for root save/stop'); report.finished = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(root, `output/server-escort-${values.agent}-latest.json`), JSON.stringify({ dir, ...report }, null, 2));
  console.log('Evidence: ' + dir);
}
