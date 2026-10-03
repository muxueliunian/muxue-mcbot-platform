#!/usr/bin/env node
// A real local Claude decides quantities and uses task tools; this harness only prepares fixtures, chats and reads evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rcon, readServerProps } from './rcon.mjs';

const { values } = parseArgs({ options: { 'allow-real-agent': { type: 'boolean' }, account: { type: 'string' } } });
assert(values['allow-real-agent'] && ['b', 'r', 'default'].includes(values.account), 'Requires --allow-real-agent --account b|r|default selected by the user');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), serverDir = path.join(root, 'runtime/serverbody-validation');
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-gather-backup.json'), 'utf8'));
assert(backup.serverStopped && backup.comparison === 'actual bytes');
const matrix = JSON.parse(await fs.readFile(path.join(root, 'output/server-gather-latest.json'), 'utf8')); assert.equal(matrix.result, 'passed');
const dir = path.join(root, 'output', `gather-agent-${new Date().toISOString().replaceAll(':', '-')}`), runtime = path.join(dir, 'runtime');
await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), events = path.join(dir, 'peer-events.jsonl'), mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(input, ''); await fs.writeFile(events, '');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'), '--username', 'ServerBot', '--world-id', 'serverbody-validation'] } } }));
const report = { started: new Date().toISOString(), account: values.account, model: 'claude-sonnet-5-5', effort: 'low', backup: backup.backup, phases: [], cleanup: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async text => (await rcon([text], { serverDir }))[0];
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
async function lines(file) { try { const text = await fs.readFile(file, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
const peerEvents = () => lines(events);
const driverText = () => fs.readFile(path.join(runtime, 'companion-ServerBot.log'), 'utf8').catch(() => '');
const operations = () => lines(path.join(runtime, 'operations-ServerBot.jsonl'));
async function until(check, message, timeout = 120000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await wait(150); } throw Error(message); }
async function fixture(text) {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
  assert(names && names.every(name => ['ServerBot', 'C2Tester'].includes(name)), 'Unknown real player; no fixture mutation');
  const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), reply); return reply;
}
async function reset(tool = 'minecraft:diamond_pickaxe') {
  await fixture('kill @e[type=minecraft:item,x=2000,y=199,z=2000,dx=24,dy=8,dz=24]');
  await fixture('fill 2000 200 2000 2024 200 2024 stone'); await fixture('fill 2000 201 2000 2024 204 2024 air');
  await fixture('clear ServerBot'); await fixture('tp ServerBot 2008.5 201 2012.5'); await fixture('tp C2Tester 2001.5 201 2003.5');
  await fixture(`item replace entity ServerBot hotbar.0 with ${tool}`); await fixture('item replace entity ServerBot hotbar.8 with minecraft:diamond 5'); await wait(300);
}
async function phase(name, message, taskName) {
  const start = Date.now(), offset = (await driverText()).length;
  await send({ type: 'chat', message });
  await until(async () => (await operations()).some(record => record.timestamp >= start && record.operation.name === taskName), name + ': no terminal task receipt');
  const record = (await operations()).find(record => record.timestamp >= start && record.operation.name === taskName);
  // A background task can finish after its submitting model turn has already ended.
  // Wait for the completion reply and that turn's end before resetting fixtures or stopping the host.
  let completionReply;
  await until(async () => {
    completionReply = (await peerEvents()).find(event => event.type === 'chat' && event.username === 'ServerBot' && Date.parse(event.time) >= record.timestamp);
    return !!completionReply;
  }, name + ': no game reply after terminal task event', 45000);
  await until(async () => (await driverText()).slice(offset).split('\n').some(line => {
    const match = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*本轮结束/);
    return match && new Date(match[1].replace(' ', 'T')).getTime() >= Date.parse(completionReply.time) - 999;
  }), name + ': completion reply turn did not end', 30000);
  const replies = (await peerEvents()).filter(event => event.type === 'chat' && event.username === 'ServerBot' && Date.parse(event.time) >= start);
  const log = (await driverText()).slice(offset);
  const result = { name, message, firstReplyMs: replies.length ? Date.parse(replies[0].time) - start : null, replies: replies.map(value => value.message), operation: record.operation,
    tools: [...log.matchAll(/· ([^\s]+) (.*)/g)].map(value => ({ name: value[1], args: value[2] })) };
  report.phases.push(result); assert(replies.length, 'No in-game response'); assert.equal(record.operation.status, 'succeeded', record.operation.summary);
  console.log('PASS ' + name); return result;
}
let peer, driver;
try {
  await fixture('forceload add 2000 2000 2024 2024');
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', events], { cwd: root, windowsHide: true, stdio: 'ignore' });
  await until(async () => (await peerEvents()).some(event => event.type === 'spawn'), 'Peer join failed', 30000); await reset();
  for (const [x, z] of [[2010,2010],[2010,2014],[2013,2012],[2005,2009],[2005,2015],[2003,2012]]) await fixture(`setblock ${x} 201 ${z} stone`);
  driver = spawn(process.execPath, [path.join(root, 'scripts/companion.mjs'), '--agent', 'claude', '--body', 'server', '--name', 'ServerBot', '--nickname', '小克', '--mcp-config', mcpConfig,
    '--config-dir', path.join(process.env.USERPROFILE, values.account === 'default' ? '.claude' : `.claude-${values.account}`), '--model', report.model, '--effort', 'low', '--headless'],
  { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, COMPANION_RUNTIME_DIR: runtime } });
  await until(async () => /本轮结束/.test(await driverText()), 'Claude startup failed');
  const autonomous = await phase('agent-decides-quantity', '小克，采一些附近的圆石备用，数量你看现场情况自己决定，先说一句打算采多少。', 'gather-resources');
  assert(autonomous.operation.result.targetCount > 0 && autonomous.operation.result.targetCount <= 6 && autonomous.operation.result.pickedUpCount >= autonomous.operation.result.targetCount);
  autonomous.inventoryAuthority = await command('data get entity ServerBot Inventory');
  assert(autonomous.inventoryAuthority.includes('minecraft:cobblestone'));
  await reset();
  await fixture('summon item 2012.5 201.1 2012.5 {Item:{id:"minecraft:cobblestone",count:99,components:{"minecraft:max_stack_size":99}},PickupDelay:0}'); await wait(400);
  const group = await phase('one-group-is-99', '小克，现在只捡附近地上的一组圆石，不要挖方块。', 'collect-items');
  assert.equal(group.operation.result.targetCount, 99); assert.equal(group.operation.result.pickedUpCount, 99); assert.equal(group.operation.result.maxStackSize, 99);
  group.inventoryAuthority = await command('data get entity ServerBot Inventory'); assert.match(group.inventoryAuthority, /count: 99/);
  await reset('minecraft:wooden_pickaxe');
  for (const [x, z] of [[2010,2010],[2010,2014],[2013,2012]]) await fixture(`setblock ${x} 201 ${z} stone`);
  const offset = (await driverText()).length, start = Date.now();
  await send({ type: 'chat', message: '小克，把旁边这片石料采成圆石。' });
  await until(async () => /· gather-resources /.test((await driverText()).slice(offset)), 'Agent did not start cancellable gathering');
  await wait(150); const stopAt = Date.now(); await send({ type: 'chat', message: '小克，停下。' });
  await until(async () => /身体控制已撤销/.test((await driverText()).slice(offset)), 'Host stop did not revoke');
  report.stopMs = Date.now() - stopAt; await wait(7000);
  const blockChecks = []; for (const [x,z] of [[2010,2010],[2010,2014],[2013,2012]]) blockChecks.push(await command(`execute if block ${x} 201 ${z} stone`));
  report.phases.push({ name: 'stop-while-gathering', started: new Date(start).toISOString(), stopMs: report.stopMs, blocksStillPresent: blockChecks.filter(value => /^Test passed/.test(value)).length });
  assert.equal(report.phases.at(-1).blocksStillPresent, 3, 'Cancelled mining still broke a target');
  await fixture('summon item 2012.5 201.1 2012.5 {Item:{id:"minecraft:snowball",count:16},PickupDelay:0}'); await wait(350);
  const next = await phase('first-task-after-stop', '小克，只捡附近的一组雪球。', 'collect-items');
  assert.equal(next.operation.result.targetCount, 16); assert.equal(next.operation.result.pickedUpCount, 16);
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  if (driver && driver.exitCode === null) {
    await fs.writeFile(path.join(runtime, 'companion-ServerBot.stop'), ''); await until(() => driver.exitCode !== null, 'Host close timeout', 20000).catch(() => {});
    if (driver.exitCode === null) { const killer = spawn('taskkill', ['/PID', String(driver.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await new Promise(resolve => killer.once('exit', resolve)); }
  }
  if (peer && peer.exitCode === null) { await send({ type: 'quit' }); await wait(2300); if (peer.exitCode === null) peer.kill(); }
  await command('forceload remove 2000 2000 2024 2024').catch(() => {});
  report.cleanup.push('Local Claude host and test player closed; dedicated forced chunks removed; server kept for final save/stop'); report.finished = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(root, 'output/server-gather-agent-latest.json'), JSON.stringify({ dir, ...report }, null, 2));
  console.log('Evidence: ' + dir);
}
