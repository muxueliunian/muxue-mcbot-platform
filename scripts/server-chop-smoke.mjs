#!/usr/bin/env node
// 原地连砍实测：平坦隔离服高空平台上立一棵 4 节原木的树干（紧挨着 Bot）和 6 格外一截 2 节的树桩，
// 用真实的 discover-resources + gather-resources 要 6 个原木，看它站着把够得着的 4 节都砍完才去捡，
// 再走去砍树桩。每 100ms 记一次 Bot 位置和各节原木还在不在。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-chop-smoke.mjs --allow-fixture');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-chop-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], samples: [],
  limitations: ['没有使用真实模型；人工树干没有树叶，自然树另看试玩。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid/i.test(reply), 'Fixture rejected: ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pos(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到位置：' + reply);
  return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
}
const isLog = async ([x, y, z]) => (await command(`execute if block ${x} ${y} ${z} minecraft:oak_log`)).includes('passed');
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}

// 平台顶面 y=200，Bot 站在 (3300.5, 201, 3300.5)；树干在东边 2 格 (3302, 201..204, 3300)，树桩在 (3306, 201..202, 3304)
const [X0, X1, Z0, Z1, Y, M] = [3294, 3310, 3294, 3310, 200, 3];
const start = [3300.5, Y + 1, 3300.5];
const trunk = [1, 2, 3, 4].map(h => [3302, Y + h, 3300]);
const stump = [1, 2].map(h => [3306, Y + h, 3304]);
const park = () => command(`tp ServerBot ${X0 + 5.5} -60 ${Z0 + 5.5}`);
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  for (const p of [...trunk, ...stump]) await fixture(`setblock ${p.join(' ')} minecraft:oak_log`);
  await command('kill @e[type=item,x=3302,y=200,z=3302,distance=..20]');
  client = new Client({ name: 'server-chop-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'ServerBot', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  await command(`tp ServerBot ${start.join(' ')} -90 0`); await wait(1500);
  const found = await tool('discover-resources', { blockIds: ['minecraft:oak_log'], radius: 8 });
  check('找到树干和树桩一共 6 节原木', !found.error && found.value.candidates?.length === 6, found.value);
  let op = await tool('gather-resources', { resourceRef: found.value.resourceRef, item: 'minecraft:oak_log', count: 6, timeoutMs: 90000 });
  check('采集开始', !op.error && op.value.status === 'running', op.value);
  const deadline = Date.now() + 100000;
  while (op.value.status === 'running' && Date.now() < deadline) {
    const sample = { t: Date.now(), bot: await pos('ServerBot'), trunk: await Promise.all(trunk.map(isLog)), stump: await Promise.all(stump.map(isLog)) };
    report.samples.push(sample);
    await wait(100);
    op = await tool('get-operation', { operationId: op.value.operationId, details: true });
  }
  report.operation = op.value; await save();
  check('采集成功，捡到 6 个原木', op.value.status === 'succeeded' && op.value.result?.pickedUpCount === 6, op.value);
  const moved = s => Math.hypot(s.bot[0] - start[0], s.bot[2] - start[2]);
  const trunkGone = report.samples.find(s => s.trunk.every(v => !v));
  check('树干 4 节都砍掉了', !!trunkGone, report.samples.at(-1));
  const firstMove = report.samples.find(s => moved(s) > 0.5);
  check('站在原地把树干 4 节都砍完才挪动（中途没去捡）', !firstMove || firstMove.t >= trunkGone.t, { firstMove, trunkGone });
  const stumpCut = report.samples.find(s => s.stump.some(v => !v));
  check('砍完树干、捡完掉落之后才走去砍树桩', !!stumpCut || op.value.status === 'succeeded', { stumpCut });
  check('砍树桩之前已经离开起点（走过去了）', !stumpCut || moved(stumpCut) > 1, stumpCut && { bot: stumpCut.bot });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try { await park(); await wait(500); await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`); await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
