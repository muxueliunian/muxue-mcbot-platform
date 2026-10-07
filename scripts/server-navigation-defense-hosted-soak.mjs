#!/usr/bin/env node
// Only the real hosted Claude-b/Minecraft MCP controls the Body. RCON prepares
// this owned fixture and independently observes native fields; it is not a Body.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rcon, readServerProps } from './rcon.mjs';
import { getAgentProtocol } from './agents/process-protocols.mjs';
import { isAddressedStop } from './companion.mjs';

const { values } = parseArgs({ options: { 'allow-real-agent': { type: 'boolean' }, account: { type: 'string' }, minutes: { type: 'string', default: '30' }, help: { type: 'boolean' }, check: { type: 'boolean' } } });
const minutes = Number(values.minutes);
assert(Number.isInteger(minutes) && minutes >= 1 && minutes <= 30, '--minutes must be an integer from 1 to 30');
if (values.help || values.check) {
  console.log('node scripts/server-navigation-defense-hosted-soak.mjs --allow-real-agent --account b --minutes 30');
  console.log('Only existing Node24.19 and Claude-b. MC_SERVER_DIR must match the new actual-byte backup. Requires current full passed server-navigation-defense-latest.json. --minutes 1..29 is debug evidence only. --check never reads credentials, starts a process, connects or writes fixtures.');
  console.log('Six scheduled player-chat phases, native peer walking and persistent follow between phases, final independent host stop. Controlled platform 2600..2628 at feet201..202; not natural survival evidence.');
  process.exit(0);
}
assert(values['allow-real-agent'] && values.account === 'b', 'Explicit --allow-real-agent --account b required; no fallback');
assert.equal(process.platform, 'win32', 'Windows-owned process identity and cleanup required');
assert.equal(process.version, 'v24.19.0', 'Use the existing Node24.19 executable; no runtime installation or fallback');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.resolve(process.env.MC_SERVER_DIR || path.join(root, 'runtime/serverbody-validation'));
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backupFile = path.join(root, 'output/serverbody-navigation-defense-backup.json');
const matrixFile = path.join(root, 'output/server-navigation-defense-latest.json');
const backup = await readJson(backupFile), matrix = await readJson(matrixFile);
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup), 'Missing current stopped-server actual-byte backup');
assert.equal(path.resolve(backup.serverDir).toLowerCase(), serverDir.toLowerCase());
assert(!serverDir.toLowerCase().startsWith('g:\\mc\\mcbot\\'), 'Old repository servers are forbidden');
assert((await fs.stat(backup.backup)).isDirectory());
assert.equal(matrix.result, 'passed', 'Full current program matrix must pass before a real model');
assert.equal(matrix.navigationOnly, false, 'Navigation-only evidence is incomplete');
assert.equal(matrix.defenseOnly, false, 'Defense-only evidence is incomplete');
assert.equal(path.resolve(matrix.serverDir).toLowerCase(), serverDir.toLowerCase());
assert.equal(path.resolve(matrix.backup).toLowerCase(), path.resolve(backup.backup).toLowerCase());
assert(Date.parse(matrix.started) >= (await fs.stat(backupFile)).mtimeMs - 2000, 'Program evidence predates this backup');
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json'), connection = await readJson(connectionFile);
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
assert(process.env.USERPROFILE); const configDir = path.join(process.env.USERPROFILE, '.claude-b');
assert((await fs.stat(configDir)).isDirectory(), 'Explicit existing Claude-b profile missing');
const dir = path.join(root, 'output', `navigation-defense-hosted-soak-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'), mcpConfig = path.join(dir, 'mcp.json');
const observerFile = path.join(dir, 'mcp-observer.jsonl');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [path.join(root, 'scripts/server-play-mcp-observer.mjs'), '--observer-log', observerFile, '--body', 'server', '--connection-file', connectionFile,
  '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime] } } }));
const model = 'claude-sonnet-5-5', startedAt = Date.now(), requestedMs = minutes * 60000;
const report = { started: new Date(startedAt).toISOString(), selectedAccount: 'b', agent: 'claude', model, effort: 'low', serverDir, backup: backup.backup, backupRecord: backupFile, programEvidence: matrixFile,
  requestedMinutes: minutes, requestedScenarioMs: requestedMs, scenarioStarted: null, scenarioEnded: null, actualScenarioMs: null, formalThirtyMinuteEvidence: false,
  nodeRuntime: { version: process.version, executable: process.execPath, v8: process.versions.v8, uv: process.versions.uv },
  tools: { expected: 39, observedCount: null, names: null, source: 'Transparent tools/list responses to actual Agent requests; no observer-originated calls' },
  boundary: 'Actual hosted player chat through companion.mjs and one game role. RCON only fixture/independent native observation. No evaluator Body/control API calls, model retry, account fallback or save/shutdown.',
  timingBoundary: 'Host tool-log time has one-second precision. Runtime actionRequestedAt/actionAcceptedAt, task terminal and independent observed game fields are separate; native last-write timestamp unavailable remains null.',
  limitations: ['Controlled platform and mostly NoAI enemy fixture, not natural wilderness survival', 'No unknown Mod/codec injection', 'Restricted CLI tools do not establish OS sandbox isolation', 'Short runs do not count as thirty-minute evidence'],
  phases: [], samples: [], peerWalks: [], fixtures: [], processes: [], ownedChildren: [], cleanup: [] };
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = value => { let text = String(value); for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:token|apiKey|accessToken|refreshToken|authorization|password|stopToken|leaseId)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"'); };
const safe = value => JSON.parse(redact(JSON.stringify(value)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let driver, peer, ownHost, interrupted = '', scenarioStart, scenarioDeadline = startedAt + requestedMs + 300000, lastSafety = 0;
const forced = [], mob = '@e[tag=mcbot_hosted_soak_fixture]';
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; });
async function lines(file) { let text; try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse); }
const driverText = () => fs.readFile(path.join(runtime, 'companion-Claude.log'), 'utf8').catch(() => '');
const operations = () => lines(path.join(runtime, 'operations-Claude.jsonl'));
const journal = () => lines(path.join(runtime, 'events-Claude.jsonl'));
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
const command = async text => (await rcon([text], { serverDir, timeoutMs: 3000 }))[0];
async function alone() { const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), 'Unowned real player online; fixture mutations blocked'); return names; }
async function fixture(text) { await alone(); const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), 'Fixture rejected: ' + redact(reply));
  report.fixtures.push({ at: Date.now(), command: text, reply: redact(reply) }); return reply; }
async function safety() { assert(!interrupted, 'Interrupted: ' + interrupted); assert(!driver?.done, 'Product host exited before completion'); assert(!peer?.done, 'Owned peer exited before completion');
  const events = await lines(peerFile); assert(!events.some(event => ['died', 'error'].includes(event.type)), 'Protocol peer died or failed');
  assert(!/agent 进程退出|本轮出错|没有自己退出|MCP_OBSERVER_AUDIT_FAILED|MCP_OBSERVER_RUNTIME_START_FAILED/.test(await driverText()), 'Agent or transparent observer exited/failed before intentional final stop');
  if (Date.now() - lastSafety >= 1000) { await alone(); lastSafety = Date.now(); } }
async function until(check, message, timeout = 60000, cleanup = false) { const end = cleanup ? Date.now() + timeout : Math.min(scenarioDeadline, Date.now() + timeout);
  while (Date.now() < end) { if (!cleanup) await safety(); if (await check()) return; await wait(150); } throw Error('Bounded wait failed: ' + message); }
function launch(label, cmd, args, options = {}) { const child = spawn(cmd, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const record = { label, pid: child.pid ?? null, parentPid: process.pid, started: new Date().toISOString(), exitCode: null, signal: null, intentional: false, stderrTail: '' };
  const owner = { child, record, done: false, stdout: '', stderr: '' }; report.processes.push(record);
  child.stdout.on('data', chunk => { owner.stdout = (owner.stdout + chunk).slice(-16000); }); child.stderr.on('data', chunk => { owner.stderr = (owner.stderr + chunk).slice(-16000); });
  child.on('error', error => { record.error = redact(error.message); }); owner.closed = new Promise(resolve => child.once('close', (code, signal) => { owner.done = true;
    Object.assign(record, { exitCode: code, signal, finished: new Date().toISOString(), stderrTail: redact(owner.stderr).slice(-5000) }); resolve(); })); return owner; }
async function helper(label, cmd, args) { const child = launch(label, cmd, args); const timer = setTimeout(() => child.child.kill(), 8000);
  try { await child.closed; assert.equal(child.record.exitCode, 0, label + ': ' + child.record.stderrTail); child.record.intentional = true; return child.stdout; } finally { clearTimeout(timer); } }
async function childrenOf(pid) { assert(Number.isSafeInteger(pid) && pid > 0);
  const script = `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='name';e={$_.Name}},@{n='created';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress -Depth 3`;
  const raw = await helper('own-process-metadata', 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', script]); const parsed = raw.trim() ? JSON.parse(raw) : []; return Array.isArray(parsed) ? parsed : [parsed]; }
async function position(name = 'Claude') { const values = (await command(`data get entity ${name} Pos`)).match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(values?.length === 3 && values.every(Number.isFinite), 'Native position unavailable: ' + name); const result = { x: values[0], y: values[1], z: values[2] };
  assert(result.x >= 2600 && result.x <= 2629 && result.z >= 2600 && result.z <= 2629 && result.y >= 200.9 && result.y <= 203, 'Role left the owned safe platform: ' + name); return result; }
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function settled(name = 'Claude') { let stable = 0, previous; await until(async () => {
  const ground = await command(`data get entity ${name} OnGround`), motion = (await command(`data get entity ${name} Motion`)).match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  const actual = await position(name), ready = /1b\s*$/.test(ground) && motion?.length === 3 && motion.every(Number.isFinite) && Math.hypot(motion[0], motion[2]) < 0.02
    && Math.abs(motion[1]) <= 0.081 && (!previous || distance(previous, actual) < 0.015);
  stable = ready ? stable + 1 : 0; previous = actual; return stable >= 3;
}, name + ': native teleport/fixture position did not settle', 5000); }
async function health() { const value = Number.parseFloat((await command('data get entity Claude Health')).match(/entity data:\s*([\d.]+)f?/)?.[1]); assert(Number.isFinite(value) && value > 0, 'Body death or unknown health'); return value; }
function nativeEntityHealth(reply) {
  const match = String(reply).match(/\bentity data:\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[fFdD]?\s*$/);
  assert(match, 'Native entity Health did not return a numeric NBT field');
  const value = Number(match[1]); assert(Number.isFinite(value) && value > 0, 'Native entity Health must be finite and positive'); return value;
}
async function fixtureEntityUUID() {
  const reply = await command('data get entity @e[tag=mcbot_hosted_soak_fixture,limit=1] UUID');
  const match = reply.match(/\bentity data:\s*\[I;\s*([^\]]+)\]\s*$/); assert(match, 'Native fixture UUID int-array was unavailable');
  const fields = match[1].split(',').map(value => value.trim());
  assert(fields.length === 4 && fields.every(value => /^-?\d+$/.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647), 'Native fixture UUID must contain four signed 32-bit fields');
  const hex = fields.map(value => BigInt.asUintN(32, BigInt(value)).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function sample() { await safety(); report.samples.push({ at: Date.now(), bodyPosition: await position(), bodyHealth: await health(), peerPosition: await position('C2Tester') }); }
async function toolsSince(offset) { return [...(await driverText()).slice(offset).matchAll(/· ([^\s]+) /g)].map(match => match[1]); }
async function finishPhase(row, offset) { const log = (await driverText()).slice(offset), replies = (await lines(peerFile)).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= row.start);
  row.replies = replies.map(event => ({ ms: Date.parse(event.time) - row.start, message: event.message })); row.firstReplyMs = row.replies.find(reply => reply.message.includes(row.replyCue))?.ms ?? null;
  row.tools = await toolsSince(offset); assert(!row.tools.some(tool => /^(Read|Edit|Write|Bash|PowerShell|Agent|Task)$/i.test(tool)), 'Forbidden host tool invocation');
  const stamp = log.split('\n').find(line => /· [^\s]+ /.test(line))?.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/)?.[1];
  row.toolRequestedMs = stamp ? Math.max(0, new Date(stamp.replace(' ', 'T')).getTime() - row.start) : null; row.elapsedMs = Date.now() - row.start; }
async function request(name, message, tools = [], verify) { const scheduledStage = ['initial-survival-policy', 'three-dimensional-navigation', 'finite-gather', 'native-auto-meal', 'ai-threat-exclusion', 'remaining-materials-decision'].indexOf(name);
  const replyCue = { 'initial-survival-policy': '生存策略', 'follow-interval': '开始跟随', 'fixture-safe-policy': '安全策略', 'three-dimensional-navigation': '半砖导航', 'finite-gather': '原木采集', 'native-auto-meal': '进食试验', 'ai-threat-exclusion': '威胁排除', 'automatic-defense-preempts-follow': '近距防卫', 'remaining-materials-decision': '剩余材料' }[name];
  assert(replyCue, 'Missing natural in-game reply cue for phase'); message += `请在本阶段的游戏回复中提到“${replyCue}”。`;
  const offset = (await driverText()).length, row = { name, message, replyCue, start: Date.now(), scheduledAt: scenarioStart === undefined || scheduledStage < 0 ? null : scenarioStart + scheduledStage * requestedMs / 6,
    result: 'running', firstReplyMs: null, toolRequestedMs: null, actionAcceptedMs: null, terminalReceiptMs: null, nativeLastWriteMs: null, replies: [], tools: [] }; report.phases.push(row);
  assert(message.length <= 256, 'Actual protocol player chat exceeds the native 256-character boundary');
  assert(!isAddressedStop({type:'chat',text:`C2Tester: ${message}`},{name:'Claude',nickname:'小克'}), 'Non-stop evaluation message accidentally invokes the host hard-stop shortcut');
  await send({ type: 'chat', message }); try { await until(async () => {
    const log = (await driverText()).slice(offset); let lastRequired = -1;
    for (const tool of tools) { const index = log.lastIndexOf(`· ${tool} `); if (index < 0) return false; lastRequired = Math.max(lastRequired, index); }
    if (!/本轮结束/.test(log.slice(Math.max(0, lastRequired)))) return false;
    return (await lines(peerFile)).some(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= row.start && event.message.includes(replyCue));
  }, name + ': no phase-bound required tools, natural game reply and subsequent model turn close', 75000);
    await finishPhase(row, offset); assert(row.replies.length, name + ': no actual game reply'); for (const tool of tools) assert(row.tools.includes(tool), name + ': no ' + tool);
    await verify?.(row); row.result = 'passed'; console.log('PASS ' + name); return row;
  } catch (error) { row.result = 'failed'; row.error = redact(error.message); throw error; }
  finally { await finishPhase(row, offset); await checkpoint(); } }
async function receipt(row, name, timeout = 45000) { let record;
  await until(async () => { record = (await operations()).find(value => value.timestamp >= row.start && value.operation.name === name); return !!record; }, name + ': no native terminal receipt', timeout);
  row.terminalReceiptMs = record.timestamp - row.start; row.operation = record.operation; assert.equal(record.operation.status, 'succeeded', record.operation.summary);
  const progress = record.operation.result; row.actionRequestedMs = progress?.actionRequestedAt === undefined ? null : progress.actionRequestedAt - row.start;
  row.actionAcceptedMs = progress?.actionAcceptedAt === undefined ? null : progress.actionAcceptedAt - row.start; return record.operation; }
async function acceptedPolicy(row, expected) {
  const responses = (await lines(observerFile)).filter(record => record.kind === 'response' && record.name === 'set-reflexes' && record.accepted === true && record.requestedAt >= row.start);
  const actual = responses.find(record => Object.entries(expected).every(([field, value]) => JSON.stringify(record.policy[field]) === JSON.stringify(value)));
  assert(actual, 'No observed successful effective policy matching the actual phase settings'); row.acceptedPolicy = actual; return actual.policy;
}
async function walk() { const before = await position('C2Tester'), body = await position(), started = Date.now(); await send({ type: 'look-at', username: 'Claude' });
  await until(async () => (await lines(peerFile)).some(event => event.type === 'looked' && Date.parse(event.time) >= started), 'Owned peer native look', 4000);
  const toward = { x: body.x - before.x, z: body.z - before.z }, length = Math.hypot(toward.x, toward.z); assert(length > 0.2, 'Peer and Body too close for bounded walk orientation');
  const dx = toward.x / length, dz = toward.z / length, target = { x: 2614.5 - before.x, z: 2614.5 - before.z };
  const vectors = [{ direction: 'forward', x: dx, z: dz }, { direction: 'back', x: -dx, z: -dz }, { direction: 'left', x: dz, z: -dx }, { direction: 'right', x: -dz, z: dx }];
  const chosen = vectors.filter(vector => { const projected = { x: before.x + vector.x * 2.25, y: before.y, z: before.z + vector.z * 2.25 };
    return projected.x >= 2601 && projected.x <= 2627 && projected.z >= 2601 && projected.z <= 2627 && distance(projected, body) >= 1.8;
  }).sort((a, b) => b.x * target.x + b.z * target.z - a.x * target.x - a.z * target.z)[0];
  assert(chosen, 'No bounded native peer walking direction stays within the fixture');
  await send({ type: 'walk', direction: chosen.direction, ms: 450 });
  await until(async () => (await lines(peerFile)).some(event => event.type === 'position' && event.reason === 'walk-finished' && Date.parse(event.time) >= started), 'Peer native walking', 5000);
  const after = await position('C2Tester'); assert(distance(before, after) > 0.15, 'Native peer walk did not move'); report.peerWalks.push({ at: started, direction: chosen.direction, ms: 450, before, after });
  await until(async () => distance(await position(), after) <= 3, 'Program persistent follow did not settle after actual peer walk', 15000); }
async function follow() { return request('follow-interval', '小克，这是新任务：用companion-mode持续跟随C2Tester，distance:2.5，不捡东西、不采集；先回应一句。', ['companion-mode'], async () => { await until(async () => distance(await position(), await position('C2Tester')) <= 3, 'Follow did not settle', 15000); }); }
async function gapUntil(at) { while (Date.now() < at) { await sample(); await walk(); const remaining = at - Date.now(); if (remaining > 0) await wait(Math.min(10000, remaining)); }
  const children = await childrenOf(driver.child.pid); report.ownedChildren.push({ at: Date.now(), children: children.filter(child => child.parentPid === driver.child.pid) }); await checkpoint(); }
const checkpoint = () => fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe({ dir, ...report }), null, 2) + '\n');
async function idlePolicy() { return request('fixture-safe-policy', '小克，读取get-survival-state，再用当前expectedRevision设置autoDefend:false、autoEat:false、armed:false。只执行上述策略更改，不追加模式指令，旧任务由程序收尾。先回应一句。', ['get-survival-state', 'set-reflexes']); }
async function ensureForced() { for (const x of [2600, 2616, 2632]) for (const z of [2600, 2616, 2632]) { const reply = await command(`forceload query ${x} ${z}`);
  assert(/is (?:not )?marked for force loading/i.test(reply), 'Forcechunk ownership unavailable'); if (/is not marked/i.test(reply)) { await fixture(`forceload add ${x} ${z}`); forced.push({ x, z }); } } }

try {
  const names = await alone(); assert(names.includes('Claude') && !names.includes('C2Tester'), 'Body must be online and peer name unowned'); await ensureForced();
  await fixture(`kill ${mob}`); await fixture('fill 2600 201 2600 2628 211 2628 air'); await fixture('fill 2600 200 2600 2628 200 2628 stone');
  await fixture('tp Claude 2609.5 201 2614.5'); await fixture('effect give Claude minecraft:instant_health 1 5 true'); await fixture('effect give Claude minecraft:saturation 1 5 true');
  await settled(); await fixture('clear Claude'); await fixture('item replace entity Claude inventory.3 with minecraft:diamond_axe'); await fixture('item replace entity Claude inventory.4 with minecraft:bread 16');
  peer = launch('owned-protocol-peer', process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile]);
  await until(async () => (await lines(peerFile)).some(event => event.type === 'spawn'), 'Peer join', 20000); await fixture('tp C2Tester 2612.5 201 2614.5'); await settled('C2Tester');
  const policy = getAgentProtocol('claude').command({ body: 'server', hostedConfigFile: mcpConfig, model, effort: 'low' });
  assert.equal(policy.a[policy.a.indexOf('--tools') + 1], ''); assert(policy.a.includes('--restricted') && policy.a.includes('--strict-mcp-config'));
  report.commandPolicy = { productBuilder: true, emptyBuiltIns: true, restricted: true, strictMcp: true, configDirSelectedOnly: '.claude-b' };
  const env = { ...process.env, COMPANION_RUNTIME_DIR: runtime }; for (const key of Object.keys(env)) if (/^ANTHROPIC_|^CLAUDE_CONFIG_DIR$|^CLAUDE_CODE_(?:OAUTH|USE_)|^COMPANION_AGENT_CMD$|^ENABLE_TOOL_SEARCH$/i.test(key)) delete env[key];
  driver = launch('owned-product-host', process.execPath, [path.join(root, 'scripts/companion.mjs'), '--agent', 'claude', '--body', 'server', '--name', 'Claude', '--nickname', '小克', '--mcp-config', mcpConfig,
    '--config-dir', configDir, '--model', model, '--effort', 'low', '--headless'], { env });
  ownHost = (await childrenOf(process.pid)).find(child => child.pid === driver.child.pid && child.parentPid === process.pid);
  assert(ownHost && ownHost.name.toLowerCase() === path.basename(process.execPath).toLowerCase(), 'Owned host identity unavailable'); driver.record.ownedIdentity = ownHost;
  await until(async () => /本轮结束/.test(await driverText()), 'Actual Agent startup', 75000);
  report.startupMs = Date.now() - startedAt; scenarioStart = Date.now(); scenarioDeadline = scenarioStart + requestedMs + 180000; report.scenarioStarted = new Date(scenarioStart).toISOString();
  await request('initial-survival-policy', '小克，先get-survival-state查询生命、威胁和策略版本，再set-reflexes以当前expectedRevision设autoEat:true、autoDefend:false、armed:true。告诉我当前没有防卫任务，不移动。', ['get-survival-state', 'set-reflexes']); await follow();
  await gapUntil(scenarioStart + requestedMs / 6);
  await idlePolicy(); await fixture('tp Claude 2609.5 201 2614.5'); await fixture('tp C2Tester 2618.5 201 2614.5');
  await settled(); await settled('C2Tester');
  await fixture('fill 2610 201 2613 2610 201 2615 minecraft:stone_slab[type=bottom]'); await fixture('fill 2611 201 2613 2612 201 2615 stone');
  await request('three-dimensional-navigation', '小克，这是有限新任务：用move-to-position走到x2612.5,y202,z2614.5，tolerance:0.35,timeoutMs:20000。前面是半砖和一格石台，不挖不放不瞬移。先回应，交给程序完成后结束本轮。', ['move-to-position'], async row => {
    await receipt(row, 'move-to-position'); assert(distance(await position(), { x: 2612.5, y: 202, z: 2614.5 }) < 0.8); row.gamePosition = await position(); row.health = await health(); });
  await follow(); await gapUntil(scenarioStart + requestedMs * 2 / 6);
  await idlePolicy(); await fixture('fill 2610 201 2613 2612 201 2615 air'); await fixture('tp Claude 2614.5 201 2614.5'); await fixture('tp C2Tester 2612.5 201 2614.5');
  await settled(); await settled('C2Tester');
  await fixture('setblock 2616 201 2614 oak_log'); await fixture('setblock 2616 202 2614 oak_log');
  await request('finite-gather', '小克，这是新有限任务：用discover-resources只发现五格内minecraft:oak_log，再gather-resources目标minecraft:oak_log,count:2,maxSteps:24。只允许这两块本轮专门放的原木，不挖平台；先回应，任务running后结束本轮，别循环叫模型挖。', ['discover-resources', 'gather-resources'], async row => { await receipt(row, 'gather-resources'); row.nativeInventory = await command('data get entity Claude Inventory'); });
  await follow(); await gapUntil(scenarioStart + requestedMs * 3 / 6);
  await idlePolicy(); await fixture('item replace entity Claude inventory.4 with minecraft:bread 16'); await fixture('effect give Claude minecraft:saturation 1 5 true');
  await request('native-auto-meal', '小克，get-survival-state读饥饿和背包；先set-reflexes当前expectedRevision设autoEat:true、autoDefend:false、armed:true，再companion-mode持续跟随C2Tester距离2.5。稍后测试夹具会产生饥饿，由程序自动安全进食并抢占旧跟随；先回应，不用模型循环eat-food，也不要丢物或恢复采集。', ['get-survival-state', 'set-reflexes', 'companion-mode'], async row => {
    const beforeHunger=await command('data get entity Claude foodLevel');
    await fixture('effect give Claude minecraft:hunger 10 255 true');
    try {
      // Saturation is a real buffer. A fixed two-second effect can leave food at 20.
      await until(async()=>Number.parseInt((await command('data get entity Claude foodLevel')).match(/entity data:\s*(\d+)/)?.[1],10)<=6,'Fixture did not reach the actual urgent hunger threshold',9000);
      row.hungerFixture={before:beforeHunger,urgent:await command('data get entity Claude foodLevel')};
    } finally { await fixture('effect clear Claude minecraft:hunger'); }
    await receipt(row, 'eat'); await until(async () => { const food = Number.parseInt((await command('data get entity Claude foodLevel')).match(/entity data:\s*(\d+)/)?.[1], 10); return food >= 16 && food <= 20; }, 'Native confirmed bread meal did not reach the valid no-waste state (full health, food16..20)', 15000);
    await wait(1800); row.nativeFood = await command('data get entity Claude foodLevel'); row.nativeInventory = await command('data get entity Claude Inventory'); });
  await follow(); await gapUntil(scenarioStart + requestedMs * 4 / 6);
  await idlePolicy(); await fixture('effect give Claude minecraft:instant_health 1 5 true'); await fixture('tp Claude 2614.5 201 2614.5'); await fixture('tp C2Tester 2614.5 201 2618.5');
  await settled(); await settled('C2Tester');
  await fixture('summon minecraft:husk 2616.5 201 2614.5 {Tags:["mcbot_hosted_soak_fixture"],PersistenceRequired:1b,NoAI:1b,Silent:1b}');
  const excludedMobUUID = await fixtureEntityUUID();
  const excludedMobHealthBefore = nativeEntityHealth(await command(`data get entity ${excludedMobUUID} Health`));
  assert.equal(excludedMobHealthBefore, 20, 'Fresh owned vanilla husk must have its native twenty health before exclusion');
  await request('ai-threat-exclusion', '小克，get-survival-state找附近本轮husk的entityId；set-reflexes当前expectedRevision设置autoDefend:true、excludedEntityIds:[该UUID]、armed:true。只排除这只，别攻击或defend-self，告诉我为何中立/玩家默认排除。', ['get-survival-state', 'set-reflexes'], async row => {
    const observed = (await lines(observerFile)).filter(record => record.kind === 'response' && record.name === 'get-survival-state' && record.accepted === true && record.requestedAt >= row.start);
    const husks = [...new Set(observed.flatMap(record => record.threats ?? []).filter(threat => threat.type === 'minecraft:husk').map(threat => threat.entityId))];
    assert.equal(husks.length, 1, 'Actual Agent observations did not bind exactly one fixture husk UUID');
    assert.equal(husks[0], excludedMobUUID, 'Observed excluded husk UUID differs from the independently read native fixture UUID');
    await acceptedPolicy(row, { autoDefend: true, armed: true, excludedEntityIds: [husks[0]] }); row.excludedEntityId = husks[0];
    await wait(1800); assert(!(await operations()).some(record => record.timestamp >= row.start && record.operation.name === 'defend-self'), 'Excluded threat was attacked');
    row.nativeFixtureEntityId = excludedMobUUID; row.mobHealthBefore = excludedMobHealthBefore;
    row.mobHealth = nativeEntityHealth(await command(`data get entity ${excludedMobUUID} Health`));
    assert.equal(row.mobHealth, 20, 'Excluded fixture native health changed from twenty'); assert.equal(row.mobHealth, excludedMobHealthBefore, 'Excluded fixture native health changed'); });
  await idlePolicy(); await fixture(`kill ${mob}`);
  await request('automatic-defense-preempts-follow', '小克，这是新策略：先get-survival-state并set-reflexes当前expectedRevision设autoDefend:true、excludedEntityIds:[]、armed:true,maxAttacks:2，再用companion-mode持续跟随C2Tester，distance2.5。稍后夹具会出现近敌，让程序自行有限防卫，不要逐击defend-self调用，防卫后别自动恢复旧跟随，先回应。', ['companion-mode', 'get-survival-state', 'set-reflexes'], async row => {
    const body = await position(); await fixture(`summon minecraft:husk ${body.x + 2} ${body.y} ${body.z} {Tags:["mcbot_hosted_soak_fixture"],PersistenceRequired:1b,NoAI:1b,Silent:1b}`);
    const op = await receipt(row, 'defend-self'); assert(op.result.confirmedHits >= 1, 'No native direct damage confirmation'); row.reflexEvents = (await journal()).filter(event => event.timestamp >= row.start && ['survival', 'task'].includes(event.type));
    assert(row.reflexEvents.some(event => /近距自卫已停止原任务/.test(event.text)), 'Automatic defense did not actually preempt old follow');
    row.bodyPosition = await position(); row.health = await health(); });
  await idlePolicy(); await fixture(`kill ${mob}`); await follow(); await gapUntil(scenarioStart + requestedMs * 5 / 6);
  await request('remaining-materials-decision', '小克，查询get-survival-state和背包，说明刚才原木任务剩余量以及防卫为何不会重放旧采集；保持当前跟随，不新采集，不切模式，不修改策略。先回应一句。', ['get-survival-state']);
  await gapUntil(Math.max(Date.now(), scenarioStart + requestedMs));
  const stopOffset = (await driverText()).length, stopAt = Date.now(), stopped = { name: 'independent-host-hard-stop', start: stopAt, result: 'running', firstReplyMs: null, toolRequestedMs: null, actionAcceptedMs: null, terminalReceiptMs: null, nativeLastWriteMs: null };
  report.phases.push(stopped); await send({ type: 'chat', message: '小克，停下。' });
  await until(async () => { const log = (await driverText()).slice(stopOffset), reason = log.indexOf('玩家叫停（独立聊天通道）：直接撤销身体控制'), confirmed = log.indexOf('身体控制已撤销');
    assert(!/Agent 退出，等待新的明确任务/.test(log), 'Unexpected Agent exit was mistaken for the player hard-stop path');
    return reason >= 0 && confirmed > reason;
  }, 'Independent player-chat hard-stop reason followed by confirmed host revocation', 12000, true);
  stopped.stopConfirmedMs = Date.now() - stopAt; await wait(750); const held = await position(), inventory = await command('data get entity Claude Inventory');
  await wait(1500); assert(distance(held, await position()) < 0.2, 'Old follow resumed after hard stop'); assert.equal(await command('data get entity Claude Inventory'), inventory, 'Old survival/gather intent resumed after hard stop');
  stopped.result = 'passed'; stopped.bodyPosition = held; stopped.elapsedMs = Date.now() - stopAt;
  report.scenarioEnded = new Date().toISOString(); report.actualScenarioMs = Date.now() - scenarioStart;
  report.formalThirtyMinuteEvidence = minutes === 30 && report.actualScenarioMs >= 1800000 && report.phases.every(row => row.result === 'passed');
  assert(minutes !== 30 || report.formalThirtyMinuteEvidence, 'Requested thirty-minute duration was not achieved'); report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(redact(error.message)); }
finally {
  report.scenarioEnded ??= scenarioStart === undefined ? null : new Date().toISOString(); report.actualScenarioMs ??= scenarioStart === undefined ? null : Date.now() - scenarioStart;
  if (driver && !driver.done) { driver.record.intentional = true; await fs.writeFile(path.join(runtime, 'companion-Claude.stop'), '').catch(() => {});
    await until(() => driver.done, 'Owned host graceful close', 12000, true).catch(error => report.cleanup.push(redact(error.message)));
    if (!driver.done) { try { const current = (await childrenOf(process.pid)).find(child => child.pid === driver.child.pid);
      assert(ownHost && current?.created === ownHost.created && current?.parentPid === process.pid && driver.child.exitCode === null && driver.child.signalCode === null, 'Owned host PID identity no longer proven');
      await helper('cleanup-owned-host-tree', 'taskkill', ['/PID', String(driver.child.pid), '/T', '/F']); driver.record.forced = true;
      await until(() => driver.done, 'Owned host forced close', 4000, true); } catch (error) { report.cleanup.push('Owned host cleanup refused/failed: ' + redact(error.message)); } } }
  if (peer && !peer.done) { peer.record.intentional = true; await send({ type: 'quit' }).catch(() => {}); await Promise.race([peer.closed, wait(3500)]);
    if (!peer.done) { peer.record.forced = true; peer.child.kill(); await Promise.race([peer.closed, wait(3000)]); } }
  await fixture('effect clear Claude minecraft:hunger').catch(error => report.cleanup.push('Hunger cleanup failed: ' + redact(error.message)));
  await fixture(`kill ${mob}`).catch(error => report.cleanup.push('Own mob cleanup failed: ' + redact(error.message)));
  for (const { x, z } of forced) await fixture(`forceload remove ${x} ${z}`).catch(error => report.cleanup.push('Own forcechunk cleanup failed: ' + redact(error.message)));
  report.cleanup.push('Only newly owned forcechunks removed. Fixture changes and server remain for root save/stop. No gameplay retry or account fallback.');
  report.hostAgentExitReasons = redact(await driverText()).split('\n').filter(line => /agent 进程退出|换新会话|身体控制已撤销/.test(line));
  report.events = await journal(); report.operationReceipts = await operations();
  report.mcpObservations = await lines(observerFile); const schemas = report.mcpObservations.filter(record => record.kind === 'response' && record.name === 'tools/list' && record.accepted === true);
  if (schemas.length) { report.tools.names = schemas[0].names; report.tools.observedCount = schemas[0].names.length;
    if (schemas.some(record => record.names.length !== 39 || JSON.stringify(record.names) !== JSON.stringify(schemas[0].names))) { report.result = 'failed'; process.exitCode = 1; report.cleanup.push('Observed tools/list schemas were not the consistent capability-gated 39-tool contract'); } }
  for (const owner of [driver, peer]) if (owner && (!owner.done || owner.record.forced || owner.record.exitCode !== 0 || owner.record.signal !== null)) { report.result = 'failed'; process.exitCode = 1; report.cleanup.push('Abnormal process exit: ' + owner.record.label); }
  report.cleanupComplete = (!driver || driver.done) && (!peer || peer.done) && !report.cleanup.some(value => /failed|refused|close|Abnormal/i.test(value));
  if (!report.cleanupComplete) { report.result = 'failed'; process.exitCode = 1; }
  if (report.result !== 'passed') report.formalThirtyMinuteEvidence = false;
  report.finished = new Date().toISOString(); report.totalMs = Date.now() - startedAt; await checkpoint();
  await fs.writeFile(path.join(root, 'output/server-navigation-defense-hosted-soak-latest.json'), JSON.stringify(safe({ dir, ...report }), null, 2) + '\n'); console.log('Evidence: ' + dir);
}
