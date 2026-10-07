#!/usr/bin/env node
// Explicit real-Agent trial on the backed-up isolated server; no direct Body actions by this harness.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { rcon, readServerProps } from './rcon.mjs';

assert(process.argv.includes('--allow-real-agent'), 'Requires --allow-real-agent after isolated-server backup and tool tests');
// The operator must select the user-approved account for each trial batch; never fall back to another login.
const accountArgs = process.argv.flatMap((value, index) => value === '--account' ? [process.argv[index + 1]] : []);
assert(accountArgs.length === 1 && ['b', 'r', 'default'].includes(accountArgs[0]), 'Requires explicit --account b|r|default approved for this trial batch');
const account = accountArgs[0];
assert(process.env.USERPROFILE, 'Missing USERPROFILE for the selected local Claude account');
const configDirName = account === 'default' ? '.claude' : `.claude-${account}`;
const configDir = path.join(process.env.USERPROFILE, configDirName);
assert((await fs.stat(configDir).catch(() => null))?.isDirectory(), 'Selected Claude account directory does not exist');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'runtime/serverbody-validation');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-approach-backup.json'), 'utf8'));
assert(backup, 'Missing fresh backup record');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const tag = new Date().toISOString().replaceAll(':', '-');
const dir = path.join(root, 'output', `server-agent-approach-${tag}`);
await fs.mkdir(dir, { recursive: true });
const peerInput = path.join(dir, 'peer-input.jsonl'), peerOutput = path.join(dir, 'peer-output.jsonl');
await fs.writeFile(peerInput, ''); await fs.writeFile(peerOutput, '');
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime);
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath,
  args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--nickname', '小克', '--world-id', 'serverbody-validation'] } } }));
const result = { started: new Date().toISOString(), model: 'claude-sonnet-5-5', effort: 'low', account, configDir: configDirName,
  boundary: 'Real Claude via product companion; only the Agent calls Minecraft MCP. RCON is fixture setup and independent observation.', phases: [], cleanup: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async text => (await rcon([text], { serverDir }))[0];
const messages = async () => (await fs.readFile(peerOutput, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const send = async value => fs.appendFile(peerInput, JSON.stringify(value) + '\n');
const driverText = async () => fs.readFile(path.join(runtime, 'companion-Claude.log'), 'utf8').catch(() => '');
let peer, driver;
async function until(check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(200); }
  throw new Error('Timed out awaiting observable trial condition');
}
async function alone() {
  const reply = (await command('list')).trim();
  const names = reply.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), 'Unexpected real player; no fixture mutation');
}
async function fixture(text) { await alone(); const reply = await command(text); assert(!/not loaded|Unknown or incomplete command|Incorrect argument/i.test(reply), 'Fixture rejected'); return reply; }
async function ready() { await until(async () => /本轮结束/.test(await driverText())); await wait(2000); }
async function prepare(far = false) {
  await fixture('fill 1024 201 1024 1043 204 1043 air');
  await fixture('clear Claude'); await fixture('clear C2Tester');
  await fixture('item replace entity Claude hotbar.8 with minecraft:diamond 5');
  await fixture(`setblock ${far ? 1034 : 1033} 201 1034 chest[facing=west]`);
  await fixture(`item replace block ${far ? 1034 : 1033} 201 1034 container.0 with minecraft:oak_log 6`);
  if (far) await fixture('fill 1032 201 1033 1032 202 1035 stone');
  await fixture(`tp Claude ${far ? 1030.5 : 1031.5} 201 1034.5`);
  await fixture(`tp C2Tester ${far ? 1027.5 : 1031.5} 201 ${far ? 1034.5 : 1033.2}`);
  await wait(700);
}
async function phase(name, text, expectedLogs) {
  const logStart = (await driverText()).length, began = Date.now();
  const phase = { name, message: text, started: new Date(began).toISOString() }; result.phases.push(phase);
  await send({ type: 'chat', message: text });
  await until(async () => {
    await send({ type: 'inventory' });
    const recent = (await messages()).filter(event => Date.parse(event.time) >= began);
    const inventory = recent.filter(event => event.type === 'inventory' || event.type === 'collected').at(-1)?.inventory ?? [];
    return inventory.filter(item => item.name === 'oak_log').reduce((sum, item) => sum + item.count, 0) >= expectedLogs;
  });
  phase.playerInventoryMs = Date.now() - began;
  await until(async () => /本轮结束/.test((await driverText()).slice(logStart)), 45000);
  await wait(2000);
  const events = (await messages()).filter(event => Date.parse(event.time) >= began);
  const replies = events.filter(event => event.type === 'chat' && event.username === 'Claude');
  phase.firstReplyMs = replies.length ? Date.parse(replies[0].time) - began : null;
  phase.replies = replies.map(event => ({ ms: Date.parse(event.time) - began, message: event.message }));
  const log = (await driverText()).slice(logStart);
  phase.tools = [...log.matchAll(/· ([^\s]+) /g)].map(match => match[1]);
  phase.turns = [...log.matchAll(/本轮结束[^\r\n]*/g)].map(match => match[0]);
  phase.playerInventoryAuthority = await command('data get entity C2Tester Inventory');
  console.log(JSON.stringify(phase));
}
try {
  await alone();
  await fixture('forceload add 1024 1024 1043 1043');
  await fixture('fill 1024 200 1024 1043 200 1043 stone');
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', peerInput, '--events', peerOutput], { cwd: root, stdio: 'ignore', windowsHide: true });
  await until(async () => (await messages()).some(event => event.type === 'spawn'), 20000);
  driver = spawn(process.execPath, [path.join(root, 'scripts/companion.mjs'), '--agent', 'claude', '--body', 'server', '--name', 'Claude', '--nickname', '小克',
    '--mcp-config', mcpConfig, '--config-dir', configDir, '--model', result.model, '--effort', 'low', '--headless'],
  { cwd: root, env: { ...process.env, COMPANION_RUNTIME_DIR: runtime }, stdio: 'ignore', windowsHide: true });
  await ready();
  await prepare(false);
  await phase('nearby-first-task', '小克，把你附近箱子里的三个橡木原木给我。', 3);
  await prepare(true);
  await phase('walk-around-and-return', '小克，再把你附近箱子里的三个橡木原木拿给我。', 3);
  // Start another remote transfer, stop on actual motion, then verify a fresh status task.
  await prepare(true);
  const began = Date.now(), logStart = (await driverText()).length;
  await send({ type: 'chat', message: '小克，再去箱子里拿三个橡木原木给我。' });
  await until(async () => {
    const position = await command('data get entity Claude Pos');
    const numbers = position.match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value.trim()));
    return numbers?.length === 3 && Math.hypot(numbers[0] - 1030.5, numbers[2] - 1034.5) > 0.8;
  });
  const stoppedAt = Date.now(); await send({ type: 'chat', message: '小克，停下。' });
  await until(async () => /身体控制已撤销/.test((await driverText()).slice(logStart)), 15000);
  const stopMs = Date.now() - stoppedAt;
  await wait(6500);
  const box = await command('data get block 1034 201 1034 Items');
  assert.match(box, /count: 6/);
  const nextAt = Date.now(), nextLog = (await driverText()).length;
  await send({ type: 'chat', message: '小克，现在告诉我你的背包里有多少钻石，不要继续拿原木。' });
  await until(async () => (await messages()).some(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= nextAt), 90000);
  await until(async () => /本轮结束/.test((await driverText()).slice(nextLog)), 30000);
  result.phases.push({ name: 'stop-while-moving-and-new-task', started: new Date(began).toISOString(), stopMs, boxAfterStop: box,
    replies: (await messages()).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= nextAt) });
  result.result = 'passed';
} catch (error) { result.result = 'failed'; result.error = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  if (driver && driver.exitCode === null) {
    await fs.writeFile(path.join(runtime, 'companion-Claude.stop'), '');
    await until(() => driver.exitCode !== null, 20000).catch(() => {});
    if (driver.exitCode === null) { const killer = spawn('taskkill', ['/PID', String(driver.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); await new Promise(resolve => killer.once('exit', resolve)); }
  }
  await send({ type: 'quit' }).catch(() => {});
  if (peer) { await until(() => peer.exitCode !== null, 4000).catch(() => {}); if (peer.exitCode === null) peer.kill(); }
  await command('forceload remove 1024 1024 1043 1043').catch(() => {});
  result.cleanup.push('Agent driver and peer stopped; dedicated forced chunks removed; server retained for owner shutdown');
  result.finished = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(root, 'output/serverbody-agent-approach-latest.json'), JSON.stringify({ dir, ...result }, null, 2));
  console.log(`Evidence: ${dir}`);
}
