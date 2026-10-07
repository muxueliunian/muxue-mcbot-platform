#!/usr/bin/env node
// 按标签认资源实测（第 8a 步）：平坦隔离服高空平台上摆原版的各种矿石、去皮原木和六面树皮木，再用一个临时数据包
// 把紫水晶块加进 #c:ores、骨块加进 #minecraft:logs，冒充“模组矿石”和“模组原木”。用真实的 discover-resources
// 按标签发现，看候选的种类和掉落（服务器掉落表算的）对不对，再真的采钻石、青金石、假模组矿和一棵 6 节的假模组树。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。测完删掉数据包并 /reload。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-resource-tags-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-resource-tags-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], cases: {},
  limitations: ['没有使用真实模型；“模组”方块是用数据包把原版方块加进标签冒充的，没有装真的模组。'] };
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
async function countItem(id) { const reply = await command(`clear ServerBot ${id} 0`); const m = reply.match(/Found (\d+)/); return m ? Number(m[1]) : 0; }
const block = async ([x, y, z], id) => (await command(`execute if block ${x} ${y} ${z} ${id}`)).includes('passed');

// 临时数据包：冒充模组的矿石和原木
assert.equal(props['level-name'], 'world', '要在平坦世界 world 上跑');
const pack = path.join(serverDir, 'world', 'datapacks', 'mcbot-8a-tags');
async function installPack() {
  await fs.mkdir(path.join(pack, 'data/c/tags/block'), { recursive: true });
  await fs.mkdir(path.join(pack, 'data/minecraft/tags/block'), { recursive: true });
  await fs.writeFile(path.join(pack, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 48, description: 'mcbot 8a smoke: pretend modded ore and log' } }));
  await fs.writeFile(path.join(pack, 'data/c/tags/block/ores.json'), JSON.stringify({ replace: false, values: ['minecraft:amethyst_block'] }));
  await fs.writeFile(path.join(pack, 'data/minecraft/tags/block/logs.json'), JSON.stringify({ replace: false, values: ['minecraft:bone_block'] }));
  await command('reload'); await wait(3000);
  await command('datapack enable "file/mcbot-8a-tags"'); await wait(2000);
  const list = await command('datapack list enabled');
  assert(list.includes('mcbot-8a-tags'), '数据包没启用：' + list);
}
async function removePack() {
  await command('datapack disable "file/mcbot-8a-tags"').catch(() => {});
  await fs.rm(pack, { recursive: true, force: true });
  await command('reload').catch(() => {}); await wait(3000);
}

// 平台顶面 y=200，Bot 站在 (3500.5, 201, 3500.5)
const [X0, X1, Z0, Z1, Y, M] = [3490, 3512, 3490, 3512, 200, 3];
const start = [3500.5, Y + 1, 3500.5];
const ores = { 'minecraft:diamond_ore': [3502, Y + 1, 3498], 'minecraft:lapis_ore': [3502, Y + 1, 3500], 'minecraft:gold_ore': [3502, Y + 1, 3502],
  'minecraft:emerald_ore': [3498, Y + 1, 3502], 'minecraft:deepslate_redstone_ore': [3498, Y + 1, 3498], 'minecraft:amethyst_block': [3500, Y + 1, 3503] };
const notLogs = { 'minecraft:stripped_oak_log': [3497, Y + 1, 3500], 'minecraft:oak_wood': [3503, Y + 1, 3501] };
const tree = [1, 2, 3, 4, 5, 6].map(h => [3505, Y + h, 3505]);
const park = () => command(`tp ServerBot ${X0 + 5.5} -60 ${Z0 + 5.5}`);
const near = id => Object.entries(ores).find(([key]) => key === id)[1];
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await park(); await wait(500);
  await installPack();
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 12} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  for (const [id, p] of [...Object.entries(ores), ...Object.entries(notLogs)]) await fixture(`setblock ${p.join(' ')} ${id}`);
  for (const p of tree) await fixture(`setblock ${p.join(' ')} minecraft:bone_block`);
  await command(`kill @e[type=item,x=${start[0]},y=${Y},z=${start[2]},distance=..30]`);
  client = new Client({ name: 'server-resource-tags-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'ServerBot', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  await command(`tp ServerBot ${start.join(' ')} -90 0`); await wait(1500);
  await command('clear ServerBot');
  await fixture('item replace entity ServerBot hotbar.0 with minecraft:iron_pickaxe');
  await fixture('item replace entity ServerBot hotbar.1 with minecraft:iron_axe');
  await fixture('item replace entity ServerBot hotbar.2 with minecraft:dirt 16');
  await wait(500);

  // 1. 按 #c:ores 发现：原版矿石全都认，掉落按掉落表算；假模组矿也认；不报精准采集的矿石块
  const found = await tool('discover-resources', { blockIds: ['#c:ores'], radius: 8 });
  report.cases.ores = found.value;
  const byId = Object.fromEntries((found.value.candidates ?? []).map(candidate => [candidate.id, candidate]));
  check('#c:ores 找到全部 6 种矿（含数据包加进标签的紫水晶块）', !found.error && Object.keys(ores).every(id => byId[id]?.kind === 'ore'), found.value);
  const drop = (id, item) => byId[id]?.drops?.find(value => value.item === item);
  check('钻石矿掉钻石、金矿掉粗金、绿宝石矿掉绿宝石，都是普通产物', drop('minecraft:diamond_ore', 'minecraft:diamond')?.preference === 'no_silk_touch' && drop('minecraft:gold_ore', 'minecraft:raw_gold') && drop('minecraft:emerald_ore', 'minecraft:emerald'), byId);
  check('青金石每块至少 4 个、红石至少 4 个（掉落表里的最少数量）', drop('minecraft:lapis_ore', 'minecraft:lapis_lazuli')?.least >= 4 && drop('minecraft:deepslate_redstone_ore', 'minecraft:redstone')?.least >= 4, byId);
  check('矿石不报矿石块本身（精准采集不支持）', Object.keys(ores).filter(id => id !== 'minecraft:amethyst_block').every(id => !drop(id, id)), byId);
  check('假模组矿紫水晶块掉它自己', !!drop('minecraft:amethyst_block', 'minecraft:amethyst_block'), byId['minecraft:amethyst_block']);

  // 2. 按 #minecraft:logs 发现：假模组原木（骨块）整棵 6 节都算，去皮原木和六面树皮木不算
  const logs = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 8 });
  report.cases.logs = logs.value;
  const ids = (logs.value.candidates ?? []).map(candidate => candidate.id);
  check('#minecraft:logs 找到假模组树 6 节（扫描带以上的也顺着树干找到）', !logs.error && ids.filter(id => id === 'minecraft:bone_block').length === 6 && logs.value.candidates.every(candidate => candidate.kind === 'log'), logs.value);
  check('去皮原木和六面树皮木不当作树', !ids.includes('minecraft:stripped_oak_log') && !ids.includes('minecraft:oak_wood'), ids);
  const planks = await tool('discover-resources', { blockIds: ['minecraft:oak_planks'], radius: 8 });
  check('明确点名木板（不是天然资源）被拒绝', planks.error && /UNSUPPORTED|not a natural/.test(JSON.stringify(planks.value)), planks.value);

  // 3. 要矿石块本身被拒绝，并说出能掉什么
  const again = await tool('discover-resources', { blockIds: ['minecraft:diamond_ore'], radius: 8 });
  const silk = await tool('gather-resources', { resourceRef: again.value.resourceRef, item: 'minecraft:diamond_ore', count: 1 });
  check('要钻石矿块本身被拒绝，并说出能掉 minecraft:diamond', silk.error && JSON.stringify(silk.value).includes('minecraft:diamond'), silk.value);

  // 4. 真的采：钻石 1、青金石 4（一块就够）、假模组矿 1
  for (const [label, blockId, item, count, maxBlocks] of [['钻石', 'minecraft:diamond_ore', 'minecraft:diamond', 1, 1], ['青金石', 'minecraft:lapis_ore', 'minecraft:lapis_lazuli', 4, 1], ['假模组矿', 'minecraft:amethyst_block', 'minecraft:amethyst_block', 1, 1]]) {
    const scan = await tool('discover-resources', { blockIds: [blockId], radius: 8 });
    const before = await countItem(item);
    let op = await tool('gather-resources', { resourceRef: scan.value.resourceRef, item, count, timeoutMs: 60000 });
    op = await finish(op);
    report.cases[label] = op.value;
    const got = await countItem(item) - before;
    check(`${label}：采到 ${count} 个以上，挖了 ${maxBlocks} 块`, op.value.status === 'succeeded' && got >= count && op.value.result?.minedBlocks === maxBlocks && !(await block(near(blockId), blockId)), { status: op.value.status, summary: op.value.summary, got, minedBlocks: op.value.result?.minedBlocks });
  }

  // 5. 假模组树整棵砍完（6 节，上面的要垫高）
  const treeScan = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 8 });
  const beforeBone = await countItem('minecraft:bone_block');
  let op = await tool('gather-resources', { resourceRef: treeScan.value.resourceRef, item: 'minecraft:bone_block', count: 6, timeoutMs: 120000 });
  op = await finish(op, 130000);
  report.cases.tree = op.value;
  const left = []; for (const p of tree) if (await block(p, 'minecraft:bone_block')) left.push(p);
  const bones = await countItem('minecraft:bone_block') - beforeBone, stuck = op.value.result?.stuckHigh ?? 0;
  check('假模组树 6 节都砍掉了，拿到的加上卡在高处的正好 6 个', left.length === 0 && op.value.result?.minedBlocks === 6 && bones + stuck === 6, { left, bones, stuck, status: op.value.status, summary: op.value.summary, result: op.value.result });
  check('垫高的柱子都收回了', (op.value.result?.pillarPlaced ?? 0) === (op.value.result?.pillarRecovered ?? 0), op.value.result);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try { await park(); await wait(500); await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 12} ${Z1 + M} air`); await command(`kill @e[type=item,x=${start[0]},y=${Y},z=${start[2]},distance=..30]`); await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); } catch {}
  try { await removePack(); } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
