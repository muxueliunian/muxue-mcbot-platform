#!/usr/bin/env node
// 真实模组资源实测（第 8a 步）：隔离服装上 Biomes O' Plenty（加前置 TerraBlender、GlitchCore）和 Mekanism，
// 平坦世界高空平台上摆 Mekanism 的锇矿、深层锡矿、萤石矿，和一棵带树叶的 6 节 BOP 冷杉树（旁边放去皮冷杉原木和冷杉木），
// 用真实的 discover-resources 按标签发现，看种类和掉落（模组自己的掉落表）对不对，再真的采锇、萤石和砍整棵冷杉。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、装了上面四个模组、没装要求客户端的其他 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-mod-resources-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-mod-resources-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], cases: {},
  limitations: ['没有使用真实模型；树和矿是用命令摆的，不是模组自然生成的地形。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 10000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid|Unknown block/i.test(reply), 'Fixture rejected: ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function finish(op, ms = 100000) {
  const deadline = Date.now() + ms;
  while (op.value.status === 'running' && Date.now() < deadline) { await wait(250); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}
async function countItem(id) { const reply = await command(`clear Claude ${id} 0`); const m = reply.match(/Found (\d+)/); return m ? Number(m[1]) : 0; }
const block = async ([x, y, z], id) => (await command(`execute if block ${x} ${y} ${z} ${id}`)).includes('passed');

// 平台顶面 y=200，Bot 站在 (3600.5, 201, 3600.5)；冷杉在 (3605, 201..206, 3605)
const [X0, X1, Z0, Z1, Y, M] = [3590, 3612, 3590, 3612, 200, 3];
const start = [3600.5, Y + 1, 3600.5];
const ores = { 'mekanism:osmium_ore': [3602, Y + 1, 3598], 'mekanism:deepslate_tin_ore': [3602, Y + 1, 3600], 'mekanism:fluorite_ore': [3602, Y + 1, 3602] };
const notLogs = { 'biomesoplenty:stripped_fir_log': [3597, Y + 1, 3600], 'biomesoplenty:fir_wood': [3598, Y + 1, 3603] };
const trunk = [1, 2, 3, 4, 5, 6].map(h => [3605, Y + h, 3605]);
const leaves = [];
for (const [h, r] of [[4, 2], [5, 1], [6, 1]]) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (dx || dz) leaves.push([3605 + dx, Y + h, 3605 + dz]);
leaves.push([3605, Y + 7, 3605]);
const park = () => command(`tp Claude ${X0 + 5.5} -60 ${Z0 + 5.5}`);
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 12} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  for (const [id, p] of [...Object.entries(ores), ...Object.entries(notLogs)]) await fixture(`setblock ${p.join(' ')} ${id}`);
  for (const p of trunk) await fixture(`setblock ${p.join(' ')} biomesoplenty:fir_log`);
  // 天然树叶：不是 persistent，砍完树干会自己腐烂
  for (const p of leaves) await fixture(`setblock ${p.join(' ')} biomesoplenty:fir_leaves[distance=1]`);
  await command(`kill @e[type=item,x=${start[0]},y=${Y},z=${start[2]},distance=..30]`);
  client = new Client({ name: 'server-mod-resources-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  await command(`tp Claude ${start.join(' ')} -90 0`); await wait(1500);
  await command('clear Claude');
  await fixture('item replace entity Claude hotbar.0 with minecraft:iron_pickaxe');
  await fixture('item replace entity Claude hotbar.1 with minecraft:iron_axe');
  await fixture('item replace entity Claude hotbar.2 with minecraft:dirt 16');
  await wait(500);

  // 1. #c:ores：Mekanism 的矿都认，掉落按它自己的掉落表
  const found = await tool('discover-resources', { blockIds: ['#c:ores'], radius: 8 });
  report.cases.ores = found.value;
  const byId = Object.fromEntries((found.value.candidates ?? []).map(candidate => [candidate.id, candidate]));
  check('#c:ores 认出 Mekanism 的锇矿、深层锡矿、萤石矿', !found.error && Object.keys(ores).every(id => byId[id]?.kind === 'ore'), found.value);
  const drop = (id, item) => byId[id]?.drops?.find(value => value.item === item);
  check('锇矿掉粗锇、锡矿掉粗锡，都是普通产物', drop('mekanism:osmium_ore', 'mekanism:raw_osmium')?.preference === 'no_silk_touch' && !!drop('mekanism:deepslate_tin_ore', 'mekanism:raw_tin'), byId);
  check('萤石矿每块至少 2 个萤石（模组掉落表 2～4）', drop('mekanism:fluorite_ore', 'mekanism:fluorite_gem')?.least >= 2, byId['mekanism:fluorite_ore']);
  check('不报矿石块本身', Object.keys(ores).every(id => !drop(id, id)), byId);
  const osmium = await tool('discover-resources', { blockIds: ['#c:ores/osmium'], radius: 8 });
  check('#c:ores/osmium 只找到锇矿', !osmium.error && osmium.value.candidates?.length === 1 && osmium.value.candidates[0].id === 'mekanism:osmium_ore', osmium.value);

  // 2. #minecraft:logs：BOP 冷杉 6 节，去皮冷杉原木和冷杉木不算
  const logs = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 8 });
  report.cases.logs = logs.value;
  const ids = (logs.value.candidates ?? []).map(candidate => candidate.id);
  check('#minecraft:logs 找到 BOP 冷杉 6 节', !logs.error && ids.filter(id => id === 'biomesoplenty:fir_log').length === 6, logs.value);
  check('去皮冷杉原木和冷杉木不当作树', !ids.includes('biomesoplenty:stripped_fir_log') && !ids.includes('biomesoplenty:fir_wood'), ids);

  // 3. 真的采：粗锇 1、萤石 2（一块就够）
  for (const [label, blockId, item, count, maxBlocks] of [['锇矿', 'mekanism:osmium_ore', 'mekanism:raw_osmium', 1, 1], ['萤石矿', 'mekanism:fluorite_ore', 'mekanism:fluorite_gem', 2, 1]]) {
    const scan = await tool('discover-resources', { blockIds: [blockId], radius: 8 });
    const before = await countItem(item);
    let op = await tool('gather-resources', { resourceRef: scan.value.resourceRef, item, count, timeoutMs: 60000 });
    op = await finish(op);
    report.cases[label] = op.value;
    const got = await countItem(item) - before;
    const [x, y, z] = ores[blockId];
    const drops = op.value.status === 'succeeded' ? undefined : { item: await command(`data get entity @e[type=item,x=${x},y=${y},z=${z},distance=..12,sort=nearest,limit=1]`), bot: await command('data get entity Claude Pos') };
    check(`${label}：采到 ${count} 个以上，挖了 ${maxBlocks} 块`, op.value.status === 'succeeded' && got >= count && op.value.result?.minedBlocks === maxBlocks && !(await block(ores[blockId], blockId)), { status: op.value.status, summary: op.value.summary, got, minedBlocks: op.value.result?.minedBlocks, drops, result: op.value.result });
  }

  // 4. BOP 冷杉整棵砍完
  const treeScan = await tool('discover-resources', { blockIds: ['biomesoplenty:fir_log'], radius: 8 });
  const beforeLogs = await countItem('biomesoplenty:fir_log');
  let op = await tool('gather-resources', { resourceRef: treeScan.value.resourceRef, item: 'biomesoplenty:fir_log', count: 6, timeoutMs: 120000 });
  op = await finish(op, 130000);
  report.cases.tree = op.value;
  const left = []; for (const p of trunk) if (await block(p, 'biomesoplenty:fir_log')) left.push(p);
  const got = await countItem('biomesoplenty:fir_log') - beforeLogs, stuck = op.value.result?.stuckHigh ?? 0;
  check('BOP 冷杉 6 节都砍掉了，拿到的加上卡在树叶上的正好 6 个', left.length === 0 && op.value.result?.minedBlocks === 6 && got + stuck === 6, { left, got, stuck, status: op.value.status, summary: op.value.summary, result: op.value.result });
  check('垫高的柱子都收回了', (op.value.result?.pillarPlaced ?? 0) === (op.value.result?.pillarRecovered ?? 0), op.value.result);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try { await park(); await wait(500); await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 12} ${Z1 + M} air`); await command(`kill @e[type=item,x=${start[0]},y=${Y},z=${start[2]},distance=..30]`); await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
