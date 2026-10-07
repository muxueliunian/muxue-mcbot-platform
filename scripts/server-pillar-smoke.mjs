#!/usr/bin/env node
// 垫高实测：平坦隔离服高空平台上
//   1. 一棵 9 节原木的树（顶上 4 层有树叶）：gather-resources 要 9 个原木，看它找到整棵树、站在原木上垫高砍完、再挖掉柱子下来，原木全拿到、树叶不动；
//   2. 头顶 7 格悬空的一块石头：pillar-up 垫高、dig-block 挖掉、pillar-down 下来，泥土收回、圆石捡到；
//   3. pillar-up 3 格再 pillar-down，回到原来的高度、方块一个不少；
//   4. 仿 10-07 试玩那棵云杉：6 节树干被密树叶包住、只有下面两节看得见，扫描带里被挡住的原木也算同一棵树，整棵砍完；
//   5. 两棵挨着的云杉（10-07 第四轮试玩）：要一棵树的量，只砍完一棵，另一棵不动。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-pillar-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-pillar-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {},
  limitations: ['没有使用真实模型；人工搭的树和悬空石头，自然树（大树、斜枝）另看试玩。'] };
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
const isBlock = async ([x, y, z], id) => (await command(`execute if block ${x} ${y} ${z} ${id}`)).includes('passed');
const countItem = async id => { const reply = await command(`clear Claude ${id} 0`); const m = reply.match(/Found (\d+)/); return m ? Number(m[1]) : 0; };
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms = 150000) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(500); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}

// 平台顶面 y=200（人站 201），四周 3 格清空；场地在 X/Z 3400 附近
const [X0, X1, Z0, Z1, Y, M] = [3394, 3414, 3394, 3414, 200, 3];
const park = () => command(`tp Claude ${X0 + 5.5} -60 ${Z0 + 5.5}`);
async function ground() {
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 16} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} grass_block`);
  await command(`kill @e[type=item,x=3404,y=205,z=3404,distance=..30]`);
}
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await command('gamerule doTileDrops true'); await command('time set day');
  client = new Client({ name: 'server-pillar-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  const names = (await client.listTools()).tools.map(t => t.name);
  check('pillar-up／pillar-down 工具已发布', names.includes('pillar-up') && names.includes('pillar-down'), names);

  // 1. 整棵树：树干 (3404, 201..209, 3404)，树叶在 y 206..209 的 5x5（中间是树干），顶上 210 一层 3x3
  await ground();
  const trunk = Array.from({ length: 9 }, (_, i) => [3404, Y + 1 + i, 3404]);
  await fixture(`fill 3402 ${Y + 6} 3402 3406 ${Y + 9} 3406 oak_leaves[persistent=true]`);
  await fixture(`fill 3403 ${Y + 10} 3403 3405 ${Y + 10} 3405 oak_leaves[persistent=true]`);
  for (const p of trunk) await fixture(`setblock ${p.join(' ')} oak_log`);
  await command('clear Claude');
  await command(`tp Claude 3401.5 ${Y + 1} 3404.5 -90 0`); await wait(1500);
  const found = await tool('discover-resources', { blockIds: ['minecraft:oak_log'], radius: 6, maxResults: 32 });
  check('发现时顺着树干找到整棵树的 9 节原木（扫描带以上的标为看不见）', !found.error && found.value.candidates?.length === 9 && found.value.candidates.some(c => c.visible === false), found.value.candidates?.map(c => [c.position.y, c.visible]));
  let op = await settle(await tool('gather-resources', { resourceRef: found.value.resourceRef, item: 'minecraft:oak_log', count: 9, timeoutMs: 120000 }));
  report.runs.tree = op.value;
  const left = []; for (const p of trunk) if (await isBlock(p, 'minecraft:oak_log')) left.push(p[1]);
  const end = await pos('Claude');
  check('整棵树砍完：9 节原木都没了', left.length === 0, { left, op: op.value });
  check('采集成功，实际拿到 9 个原木（垫脚用的也收回来了）', op.value.status === 'succeeded' && op.value.result?.pickedUpCount >= 9 && await countItem('minecraft:oak_log') >= 9, { status: op.value.status, summary: op.value.summary, result: op.value.result, logs: await countItem('minecraft:oak_log') });
  check('真的垫高了，柱子也都挖回来了', (op.value.result?.pillarPlaced ?? 0) >= 3 && op.value.result?.pillarRecovered === op.value.result?.pillarPlaced, op.value.result);
  check('最后回到地面（y=201）', Math.abs(end[1] - (Y + 1)) < 0.01, { end });
  let placedLeft = 0; for (let y = Y + 1; y <= Y + 9; y++) if (!(await isBlock([3404, y, 3404], 'minecraft:air'))) placedLeft++;
  check('树干那一列没有留下垫脚方块', placedLeft === 0, { placedLeft });
  let leaves = 0; for (let x = 3402; x <= 3406; x++) for (let z = 3402; z <= 3406; z++) for (let y = Y + 6; y <= Y + 9; y++) if (await isBlock([x, y, z], 'minecraft:oak_leaves')) leaves++;
  check('树叶没被当成目标砍掉（5x5x4 去掉树干还剩 96 片）', leaves === 96, { leaves });

  // 2. 挖头顶够不着的指定方块：石头悬在头顶 7 格 (3404, 208, 3404)，pillar-up 3 格、换石镐、dig-block、pillar-down
  await ground();
  await fixture(`setblock 3404 ${Y + 8} 3404 stone`);
  await command('clear Claude'); await command('give Claude stone_pickaxe'); await command('give Claude dirt 16');
  await command(`tp Claude 3404.5 ${Y + 1} 3404.5`); await wait(1500);
  const climbed = await tool('pillar-up', { blocks: 3 });
  check('pillar-up 3 格垫到 y=204', !climbed.error && climbed.value.placed === 3 && Math.abs((await pos('Claude'))[1] - (Y + 4)) < 0.01, climbed.value);
  const inv = (await tool('list-inventory')).value;
  const pick = (Array.isArray(inv) ? inv : inv.inventory ?? []).find(item => item.id === 'minecraft:stone_pickaxe');
  const selected = await tool('select-slot', { slot: pick.slot, expectedItem: pick.id, expectedCount: pick.count, expectedComponents: pick.components ?? {} });
  const dug = await settle(await tool('dig-block', { x: 3404, y: Y + 8, z: 3404, expectedBlock: 'minecraft:stone', expectedProperties: {}, timeoutMs: 15000 }));
  report.runs.highDig = { selected: selected.value, dug: dug.value };
  check('站在柱子上用石镐挖掉了头顶的石头', !dug.error && dug.value.status === 'succeeded' && await isBlock([3404, Y + 8, 3404], 'minecraft:air'), dug.value);
  const back = await tool('pillar-down');
  await wait(1500);
  // 圆石从 7 格高处落下带随机水平速度，可能落在柱子旁边一两格：没顺带碰到就用 collect-items 捡（pillar-down 只收柱子）。
  if (await countItem('minecraft:cobblestone') === 0) report.runs.highDig.collected = (await settle(await tool('collect-items', { item: 'minecraft:cobblestone', count: 1, radius: 4 }))).value;
  await wait(500);
  check('pillar-down 回到地面，泥土 16 个一个不少，圆石也捡到了', !back.error && back.value.recovered === 3 && Math.abs((await pos('Claude'))[1] - (Y + 1)) < 0.01 && await countItem('minecraft:dirt') === 16 && await countItem('minecraft:cobblestone') === 1,
    { back: back.value, dirt: await countItem('minecraft:dirt'), cobblestone: await countItem('minecraft:cobblestone'), bot: await pos('Claude'), drops: await command('execute as @e[type=item,x=3404,y=204,z=3404,distance=..12] run data get entity @s Pos'), items: await command('execute as @e[type=item,x=3404,y=204,z=3404,distance=..12] run data get entity @s Item.id') });

  // 3. 手动垫高 3 格再下来
  await ground();
  await command('clear Claude'); await command('give Claude dirt 8');
  await command(`tp Claude 3404.5 ${Y + 1} 3404.5`); await wait(1500);
  const up = await tool('pillar-up', { blocks: 3 });
  const high = await pos('Claude');
  check('pillar-up 3 格：站到 y=204、用掉 3 个泥土', !up.error && up.value.placed === 3 && Math.abs(high[1] - (Y + 4)) < 0.01 && await countItem('minecraft:dirt') === 5, { up: up.value, high });
  const down = await tool('pillar-down');
  const low = await pos('Claude');
  await wait(1000);
  check('pillar-down 回到 y=201，3 个泥土收回', !down.error && down.value.recovered === 3 && Math.abs(low[1] - (Y + 1)) < 0.01 && await countItem('minecraft:dirt') === 8, { down: down.value, low, dirt: await countItem('minecraft:dirt') });
  const again = await tool('pillar-down');
  check('没有自己搭的柱子时 pillar-down 拒绝，不往下挖', again.error || /NOT_FOUND|没有记着/.test(JSON.stringify(again.value)), again.value);

  // 4. 云杉：树干 (3404, 201..206, 3404)，树叶从 203 起层层包住树干（下面两节看得见，上面四节被挡住），顶上 207、208；Bot 站在西边 3 格
  await ground();
  const spruce = Array.from({ length: 6 }, (_, i) => [3404, Y + 1 + i, 3404]);
  for (const [y, r] of [[Y + 3, 2], [Y + 4, 1], [Y + 5, 2], [Y + 6, 1], [Y + 7, 1]]) await fixture(`fill ${3404 - r} ${y} ${3404 - r} ${3404 + r} ${y} ${3404 + r} spruce_leaves[persistent=true]`);
  await fixture(`setblock 3404 ${Y + 8} 3404 spruce_leaves[persistent=true]`);
  for (const p of spruce) await fixture(`setblock ${p.join(' ')} spruce_log`);
  await command('clear Claude');
  await command(`tp Claude 3401.5 ${Y + 1} 3404.5 -90 0`); await wait(1500);
  const sprucePlan = await tool('discover-resources', { blockIds: ['minecraft:spruce_log'], radius: 6, maxResults: 32 });
  check('云杉：扫描带里被树叶挡住的原木也算进这棵树，6 节都找到', !sprucePlan.error && sprucePlan.value.candidates?.length === 6, sprucePlan.value.candidates ? { candidates: sprucePlan.value.candidates.map(c => [c.position.y, c.visible]), budget: sprucePlan.value.budget } : sprucePlan.value);
  op = await settle(await tool('gather-resources', { resourceRef: sprucePlan.value.resourceRef, item: 'minecraft:spruce_log', count: 6, timeoutMs: 120000 }));
  report.runs.spruce = op.value;
  const spruceLeft = []; for (const p of spruce) if (await isBlock(p, 'minecraft:spruce_log')) spruceLeft.push(p[1]);
  // 树叶是人工放的（不会腐烂），顶上那节的掉落可能卡在树叶上：那时要如实报出卡住的数量，而不是笼统的“候选用完”
  const spruceLogs = await countItem('minecraft:spruce_log'), stuck = op.value.result?.stuckHigh ?? 0;
  check('云杉整棵砍完：6 节都挖了，拿到的加上如实报告卡在树叶上的正好 6 个', spruceLeft.length === 0 && op.value.result?.minedBlocks === 6 && !op.value.result?.unreachable && spruceLogs + stuck === 6 && (op.value.status === 'succeeded' ? spruceLogs >= 6 : stuck > 0 && /卡在高处/.test(op.value.summary)), { spruceLeft, spruceLogs, stuck, status: op.value.status, summary: op.value.summary, result: op.value.result, logs: await countItem('minecraft:spruce_log'), drops: await command('execute as @e[type=item,x=3404,y=205,z=3404,distance=..12] run data get entity @s Pos'), bot: await pos('Claude') });
  let spruceColumn = 0; for (let y = Y + 1; y <= Y + 6; y++) if (!(await isBlock([3404, y, 3404], 'minecraft:air'))) spruceColumn++;
  check('云杉那一列没有留下垫脚方块，柱子都收回了', spruceColumn === 0 && (op.value.result?.pillarRecovered ?? 0) === (op.value.result?.pillarPlaced ?? 0), { spruceColumn, result: op.value.result });
  // 5. 两棵挨着的云杉（树干相距 3 格，树叶连在一起）：要 7 个原木，只砍完西边那一棵，东边那棵一节不动
  await ground();
  const west = Array.from({ length: 7 }, (_, i) => [3403, Y + 1 + i, 3404]), east = Array.from({ length: 7 }, (_, i) => [3406, Y + 1 + i, 3404]);
  await fixture(`fill 3401 ${Y + 4} 3402 3408 ${Y + 7} 3406 spruce_leaves[persistent=true]`);
  await fixture(`fill 3402 ${Y + 8} 3403 3407 ${Y + 8} 3405 spruce_leaves[persistent=true]`);
  for (const p of [...west, ...east]) await fixture(`setblock ${p.join(' ')} spruce_log`);
  await command('clear Claude');
  await command(`tp Claude 3400.5 ${Y + 1} 3404.5 -90 0`); await wait(1500);
  const pair = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 8, maxResults: 32 });
  check('两棵树的 14 节原木都找到了', !pair.error && pair.value.candidates?.length === 14, pair.value.candidates?.map(c => [c.position.x, c.position.y]));
  op = await settle(await tool('gather-resources', { resourceRef: pair.value.resourceRef, item: 'minecraft:spruce_log', count: 7, timeoutMs: 120000 }));
  report.runs.twoTrees = op.value;
  const westLeft = [], eastLeft = [];
  for (const p of west) if (await isBlock(p, 'minecraft:spruce_log')) westLeft.push(p[1]);
  for (const p of east) if (await isBlock(p, 'minecraft:spruce_log')) eastLeft.push(p[1]);
  check('先开砍的那棵整棵砍完，另一棵一节都没动', (westLeft.length === 0 && eastLeft.length === 7) || (eastLeft.length === 0 && westLeft.length === 7), { westLeft, eastLeft, status: op.value.status, summary: op.value.summary, result: op.value.result });
  const pairLogs = await countItem('minecraft:spruce_log'), pairStuck = (op.value.result?.stuckHigh ?? 0) + (op.value.result?.stuckInLeaves ?? 0);
  check('7 个原木：拿到的加上如实报告卡住的正好 7 个，柱子收回', pairLogs + pairStuck === 7 && (op.value.result?.pillarRecovered ?? 0) === (op.value.result?.pillarPlaced ?? 0), { pairLogs, pairStuck, result: op.value.result });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try { await park(); await wait(500); await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 16} ${Z1 + M} air`); await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); await command('clear Claude'); } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
