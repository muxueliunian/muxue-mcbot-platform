#!/usr/bin/env node
// Real model -> product host -> Minecraft MCP. The harness only sends player chat/walks and observes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rcon, readServerProps } from './rcon.mjs';

const { values } = parseArgs({ options: { 'allow-real-agent': { type: 'boolean' }, account: { type: 'string' }, agent: { type: 'string', default: 'claude' }, scenario: { type: 'string', default: 'full' } } });
assert(values['allow-real-agent'], 'Requires --allow-real-agent after isolated-server backup and tool matrix');
assert(['claude', 'codex'].includes(values.agent));
assert(['full', 'blocked'].includes(values.scenario));
if (values.agent === 'claude') assert(['b', 'r', 'default'].includes(values.account), 'Requires --account b|r|default approved by the user for this trial');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'runtime/serverbody-validation'), props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-companion-backup.json'), 'utf8'));
assert(backup.serverStopped && backup.comparison === 'actual bytes');
const matrix = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-companion-latest.json'), 'utf8'));
assert.equal(matrix.result, 'passed', 'Complete program matrix before spending model calls');
const dir = path.join(root, 'output', `companion-agent-${values.agent}-${new Date().toISOString().replaceAll(':', '-')}`);
await fs.mkdir(dir, { recursive: true });
const runtime = path.join(dir, 'runtime'), input = path.join(dir, 'peer-input.jsonl'), events = path.join(dir, 'peer-events.jsonl');
await fs.mkdir(runtime); await fs.writeFile(input, ''); await fs.writeFile(events, '');
const mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server',
  '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'), '--username', 'Claude', '--world-id', 'serverbody-validation'] } } }));
const report = { started: new Date().toISOString(), agent: values.agent, account: values.account, scenario: values.scenario, model: values.agent === 'claude' ? 'claude-sonnet-5-5' : 'host default', effort: 'low', backup: backup.backup,
  boundary: 'Actual model and product host; test player sends real game chat and movement. RCON only fixture and independent observation.', phases: [], cleanup: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async text => (await rcon([text], { serverDir }))[0];
const peerEvents = async () => (await fs.readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
const driverText = () => fs.readFile(path.join(runtime, 'companion-Claude.log'), 'utf8').catch(() => '');
async function until(check, message, timeout = 120000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await wait(200); } throw Error(message); }
async function fixture(text) {
  const list = (await command('list')).trim(), names = list.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), 'Unexpected real player; fixture mutation refused');
  const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument/i.test(reply), reply); return reply;
}
async function position(name = 'Claude') {
  const values = (await command(`data get entity ${name} Pos`)).match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(values?.length === 3 && values.every(Number.isFinite)); return { x: values[0], y: values[1], z: values[2] };
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function request(name, message, verify) {
  const began = Date.now(), offset = (await driverText()).length;
  await send({ type: 'chat', message });
  await until(async () => /本轮结束/.test((await driverText()).slice(offset)), `${name}: agent did not finish`);
  const replies = (await peerEvents()).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= began);
  const phase = { name, message, ms: Date.now() - began, firstReplyMs: replies.length ? Date.parse(replies[0].time) - began : null, replies: replies.map(event => event.message),
    tools: [...(await driverText()).slice(offset).matchAll(/· ([^\s]+) /g)].map(match => match[1]) };
  report.phases.push(phase);
  assert(replies.length, `${name}: no in-game response`);
  if (verify) await verify(phase);
  console.log('PASS ' + name);
}
async function walk(ms = 800) {
  const began = Date.now(); await send({ type: 'look-at', username: 'Claude' });
  await until(async () => (await peerEvents()).some(event => event.type === 'looked' && Date.parse(event.time) >= began), 'Peer turn timeout', 5000);
  await send({ type: 'walk', direction: 'back', ms });
  await until(async () => (await peerEvents()).some(event => event.type === 'position' && Date.parse(event.time) >= began), 'Peer walk timeout', 5000);
}
let driver, peer;
try {
  await fixture('forceload add 1600 1600 1644 1644');
  await fixture('fill 1600 200 1600 1644 200 1644 stone'); await fixture('fill 1600 201 1600 1644 204 1644 air');
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', events], { cwd: root, windowsHide: true, stdio: 'ignore' });
  await until(async () => (await peerEvents()).some(event => event.type === 'spawn'), 'Test player failed to join', 25000);
  await fixture('tp Claude 1610.5 201 1622.5'); await fixture('tp C2Tester 1613.5 201 1622.5');
  await fixture('clear Claude'); await fixture('clear C2Tester');
  await fixture('item replace entity Claude hotbar.8 with minecraft:diamond 5');
  await fixture('setblock 1607 201 1622 chest[facing=east]'); await fixture('item replace block 1607 201 1622 container.0 with minecraft:oak_log 3');
  const args = [path.join(root, 'scripts/companion.mjs'), '--agent', values.agent, '--body', 'server', '--name', 'Claude', '--nickname', '小克', '--mcp-config', mcpConfig, '--effort', 'low', '--headless'];
  if (values.agent === 'claude') args.push('--config-dir', path.join(process.env.USERPROFILE, values.account === 'default' ? '.claude' : `.claude-${values.account}`), '--model', report.model);
  driver = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, COMPANION_RUNTIME_DIR: runtime } });
  await until(async () => /本轮结束/.test(await driverText()), 'Agent startup failed');
  if (values.scenario === 'blocked') {
    await fixture('tp C2Tester 1619.5 201 1622.5');
    await fixture('fill 1614 201 1600 1614 203 1644 stone');
    const began = Date.now(), before = await position();
    await request('blocked-follow', '小克，跟着我。');
    await until(async () => (await peerEvents()).some(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= began && /墙|挡|路|过不|受阻/.test(event.message)), 'No in-game explanation for blocked follow', 45000);
    await wait(1000);
    const journal = (await fs.readFile(path.join(runtime, 'events-Claude.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(journal.filter(event => event.type === 'companion').length, 1, 'Blocked incident must have one actionable event');
    const beforeClearing = await position();
    await fixture('fill 1614 201 1600 1614 203 1644 air'); await wait(2500);
    assert(distance(beforeClearing, await position()) < 0.2, 'Agent automatically retried after clearing obstacle');
    report.blocked = { before, beforeClearing, oneEvent: true, noAutomaticResume: true, replies: (await peerEvents()).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= began).map(event => event.message) };
    await request('explicit-resume-after-obstacle', '小克，路已经清好了，请继续刚才的跟随。');
    await until(async () => distance(beforeClearing, await position()) > 4 && distance(await position(), await position('C2Tester')) < 3, 'Explicit resume after obstacle did not move', 15000);
  } else {
  await request('fetch-new-task-interface', '小克，把你附近箱子里的三个橡木原木拿给我。', async () => {
    await until(async () => /minecraft:oak_log/.test(await command('data get entity C2Tester Inventory')), 'Player did not receive logs', 15000);
    report.phases.at(-1).inventory = await command('data get entity C2Tester Inventory');
    assert.match(report.phases.at(-1).inventory, /count: 3/);
  });
  await request('start-continuous-follow', '小克，持续跟着我，跟到身边就等我继续走，先回应一句。', phase => assert(phase.tools.some(tool => tool.endsWith('companion-mode')), 'Agent did not choose persistent mode'));
  const before = await position(); await walk(1100);
  await until(async () => distance(before, await position()) > 2 && distance(await position(), await position('C2Tester')) < 3, 'No physical follow after actual player walking', 15000);
  await request('chat-while-following', '小克，你今天心情怎么样？');
  const afterChat = await position(); await walk(700);
  await until(async () => distance(afterChat, await position()) > 1, 'Chat interrupted persistent follow', 15000);
  await request('wait-here', '小克，你先留在这里等我。'); await wait(400);
  const waiting = await position(); await walk(600); await wait(800);
  assert(distance(waiting, await position()) < 0.2, 'Explicit wait kept chasing');
  await request('follow-again', '小克，重新跟着我。');
  await until(async () => distance(await position(), await position('C2Tester')) < 3, 'New explicit follow failed', 15000);
  const stopAt = Date.now(), offset = (await driverText()).length;
  await send({ type: 'chat', message: '小克，停下。' });
  await until(async () => /身体控制已撤销/.test((await driverText()).slice(offset)), 'Host did not revoke on stop', 15000);
  report.stopMs = Date.now() - stopAt; await wait(7000);
  const stopped = await position(); await walk(600); await wait(1000); assert(distance(stopped, await position()) < 0.2, 'Old follow resumed after stop');
  await request('first-new-task-after-stop', '小克，现在告诉我你背包里有多少钻石。');
  assert(/5|五/.test(report.phases.at(-1).replies.join(' ')), 'New task did not report five diamonds');
  }
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  if (driver && driver.exitCode === null) {
    await fs.writeFile(path.join(runtime, 'companion-Claude.stop'), '');
    await until(() => driver.exitCode !== null, 'Driver close timeout', 20000).catch(() => {});
    if (driver.exitCode === null) { const killer = spawn('taskkill', ['/PID', String(driver.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await new Promise(resolve => killer.once('exit', resolve)); }
  }
  if (peer && peer.exitCode === null) { await send({ type: 'quit' }); await wait(2300); if (peer.exitCode === null) peer.kill(); }
  await command('forceload remove 1600 1600 1644 1644').catch(() => {});
  report.cleanup.push('Product host and test player closed; dedicated forced chunks removed; server kept for final save/stop');
  report.finished = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(root, `output/server-companion-${values.agent}${values.scenario === 'full' ? '' : '-blocked'}-latest.json`), JSON.stringify({ dir, ...report }, null, 2));
  console.log('Evidence: ' + dir);
}
