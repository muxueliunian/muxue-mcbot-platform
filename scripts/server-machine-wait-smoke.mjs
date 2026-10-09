#!/usr/bin/env node
// 8b “放好就走、到时回来取”的隔离服实测：熔炉放料不等，运行端记账；到时间读炉子（machine-status，不走过去），
// 好了发 machine 事件；燃料不够时报“停了”；回去不带 input 取出后销账。平坦世界，不启停服务器、不调用模型、不计算哈希。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-machine-wait-smoke.mjs --allow-fixture');
  console.log('固定25568/25578；夹具区 x6400 z6400 y200 以上；约 2 分钟。');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert.equal(connection.username, 'Claude');
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-machine-wait-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], facts: {}, calls: [], cleanup: [],
  limitations: ['没有使用真实模型和测试玩家。', '没测区块卸载和换维度（离线测试覆盖）；只有原版熔炉实现了不开界面读进度。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 1500) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) {
  const list = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(n => n.trim()).filter(Boolean) ?? [];
  assert(list.every(name => name === 'Claude'), '有其他玩家在线，拒绝修改夹具');
  const reply = await command(text); report.calls.push({ fixture: text, reply: redact(reply) });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|No entity was found|Unknown block|Unknown item/i.test(reply), '夹具命令被拒绝：' + redact(reply)); return reply;
}
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  const value = JSON.parse(reply.content[0].text); report.calls.push({ tool: name, args, error: !!reply.isError, value });
  return { error: !!reply.isError, value };
}
async function settle(op, ms = 60000) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(500); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}
async function hello() {
  const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
  return (await response.json()).result;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = (inventory, id) => inventory.filter(s => s.id === id).reduce((n, s) => n + s.count, 0);
const inventory = async () => (await tool('get-status', { details: true })).value.inventory;
const machines = async () => (await tool('get-status', {})).value.machines ?? [];
/** Machine events within the time limit (wait-for-events returns at most 30 s at a time). */
async function machineEvents(seconds) {
  const end = Date.now() + seconds * 1000, found = [];
  while (Date.now() < end && !found.length) {
    const reply = await tool('wait-for-events', { timeoutSeconds: Math.min(30, Math.max(1, Math.ceil((end - Date.now()) / 1000))), types: ['machine'] });
    const events = Array.isArray(reply.value) ? reply.value : reply.value.events ?? [];
    found.push(...events.filter(e => e.type === 'machine'));
  }
  return found;
}
const at = ([x, y, z]) => `${x} ${y} ${z}`, xyz = ([x, y, z]) => ({ x, y, z });
const FURNACE = [6402, 201, 6400], SHORT = [6398, 201, 6400];
let forced = [];
try {
  const h = await hello();
  check('服务端声明 machine-status（只读进度）', h.capabilities.includes('machine-status') && h.capabilities.includes('smelt-item'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'machine-wait-fixture', version: '1' }); await client.connect(transport);
  const survival = (await tool('get-survival-state', { details: false })).value;
  await tool('set-reflexes', { expectedRevision: survival.policy.revision, autoEat: false, autoDefend: false, armed: false }); await tool('stop-action');
  await tool('wait-for-events', { timeoutSeconds: 0 });

  await fixture('forceload add 6390 6390 6415 6415'); forced.push('6390 6390 6415 6415');
  await command('time set day'); await command('gamerule doMobSpawning false');
  await fixture('fill 6392 200 6392 6412 200 6408 minecraft:stone');
  await fixture('fill 6392 201 6392 6412 204 6408 minecraft:air');
  await command('kill @e[type=item,x=6400,y=201,z=6400,distance=..16]');
  await fixture('gamemode survival Claude'); await fixture('clear Claude');
  await fixture('tp Claude 6400.5 201 6400.5'); await wait(500);
  await fixture(`setblock ${at(FURNACE)} minecraft:furnace[facing=west]`);
  await fixture(`setblock ${at(SHORT)} minecraft:furnace[facing=east]`);
  await fixture('give Claude minecraft:raw_iron 6'); await fixture('give Claude minecraft:coal 1'); await fixture('give Claude minecraft:oak_planks 1');

  // 1. 放 3 个粗铁、不等：回执说 30 秒，运行端记账
  const started = Date.now();
  const load = await settle(await tool('smelt-item', { input: 'minecraft:raw_iron', count: 3, fuel: 'minecraft:coal', furnace: xyz(FURNACE) }));
  report.facts.load = load.value;
  check('不等：放进 3 个粗铁和煤，回执说约 30 秒', load.value.status === 'succeeded' && load.value.result?.queued === 3 && load.value.result?.readyInSeconds === 30, load.value);
  const waiting = await machines();
  report.facts.waiting = waiting;
  check('get-status 列出等着的熔炉和剩余时间', waiting.length === 1 && waiting[0].position.x === FURNACE[0] && waiting[0].readyInSeconds >= 25 && waiting[0].readyInSeconds <= 32, waiting);

  // 2. 燃料只够一个半：放 3 个粗铁、只有 1 块木板（300 tick），到时间应报“停了”
  const short = await settle(await tool('smelt-item', { input: 'minecraft:raw_iron', count: 3, fuel: 'minecraft:oak_planks', furnace: xyz(SHORT) }));
  report.facts.short = short.value;
  check('燃料不够也放进去了：回执写 fuelShortItems', short.value.status === 'succeeded' && (short.value.result?.fuelShortItems ?? 0) > 0, short.value);

  // 3. 到时间之前没有事件；到时间收到两条 machine 事件
  const stood = (await tool('get-status', {})).value.position;
  const early = await machineEvents(20);
  check('20 秒内没有 machine 事件（还没到时间）', early.length === 0, early);
  const events = [...early];
  while (events.length < 2 && Date.now() - started < 75_000) events.push(...await machineEvents(Math.max(1, Math.ceil((75_000 - (Date.now() - started)) / 1000))));
  const elapsed = Math.round((Date.now() - started) / 1000);
  report.facts.events = { elapsed, events };
  const done = events.find(e => e.text.includes(`${FURNACE[0]}, ${FURNACE[1]}, ${FURNACE[2]}`)), stalled = events.find(e => e.text.includes(`${SHORT[0]}, ${SHORT[1]}, ${SHORT[2]}`));
  check(`到时间（第 ${elapsed} 秒内）收到“烧好了”：3 个铁锭，说了怎么取`, /烧好了.*3 个 iron_ingot.*smelt-item furnace=/.test(done?.text ?? ''), events);
  check('燃料不够的那台报“停了、没燃料”和还剩几个', /停了.*还剩 \d 个 raw_iron.*没燃料/.test(stalled?.text ?? ''), events);
  const now = (await tool('get-status', {})).value.position;
  check('Bot 一直站在原地（读进度不用走过去）', Math.hypot(now.x - stood.x, now.z - stood.z) < 0.2, { stood, now });

  // 4. 回去取：不带 input，取出 3 个铁锭，账上划掉
  const ingots = count(await inventory(), 'minecraft:iron_ingot');
  const collect = await settle(await tool('smelt-item', { furnace: xyz(FURNACE) }));
  report.facts.collect = collect.value;
  check('不带 input 取出 3 个铁锭', collect.value.status === 'succeeded' && collect.value.result?.collected === 3 && count(await inventory(), 'minecraft:iron_ingot') === ingots + 3, collect.value);
  await wait(4000);
  const after = await machines();
  report.facts.after = after;
  check('取完后这台不在等着的列表里，停了的那台还在（已告知）', !after.some(m => m.position.x === FURNACE[0]) && after.some(m => m.position.x === SHORT[0] && m.told), after);
  check('取完没有多余的 machine 事件', (await machineEvents(1)).length === 0);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack ?? error.message); process.exitCode = 1; console.error(redact(error.message));
} finally {
  for (const pos of [FURNACE, SHORT]) { try { await command(`setblock ${at(pos)} minecraft:air`); report.cleanup.push({ cleared: pos }); } catch (error) { report.cleanup.push({ clearFailed: pos, error: redact(error.message) }); } }
  try { await command('kill @e[type=item,x=6400,y=201,z=6400,distance=..16]'); } catch {}
  for (const range of forced) { try { await command(`forceload remove ${range}`); report.cleanup.push({ forceloadRemoved: range }); } catch (error) { report.cleanup.push({ forceloadRemoveFailed: range, error: redact(error.message) }); } }
  try { await client?.close(); } catch {}
  report.finished = new Date().toISOString(); await save();
  console.log(`${report.result}: ${report.checks.filter(c => c.passed).length} checks; report ${path.relative(root, dir)}/report.json`);
}
