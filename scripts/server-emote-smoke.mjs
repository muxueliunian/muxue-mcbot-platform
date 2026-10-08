#!/usr/bin/env node
// 表情、外观和场景提示实测（第 8j 步）：隔离服装着核心、YSM 2.6.5 和 MCBOT 的 YSM 适配时
//   1. hello 列出内置手势、YSM 动画来源和 custom 里的模型；
//   2. 运行端带 --appearance 启动时，接管后套用 YSM 模型（YSM 不回话，只能确认指令发出去了，样子要在客户端看）；
//   3. 内置手势：wave、nod、shake、spin 做完朝向复原，crouch 途中真的蹲下，jump 途中离地；名字不对就拒绝、不动身；
//   4. YSM 动画 extra6 播 2 秒（服务端确认已发出，动画本身要在客户端看）；
//   5. 头顶露天时，开始下雨、太阳下山各给一次 scene 事件。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、服务器上没有其他玩家。会在 5000,200,5000 搭一块玻璃平台，测完拆掉、天气和时间改回白天晴天。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-emote-smoke.mjs --allow-fixture');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = await readJson(connectionFile);
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-emote-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [],
  limitations: ['没有使用真实模型；YSM 对 model set 和 play 都不回话，模型和动画的样子要在装了 YSM 的客户端上看。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid/i.test(reply), 'Fixture rejected: ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const numbers = reply => { const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到：' + reply); return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, ''))); };
const rotation = async () => numbers(await command('data get entity Claude Rotation'));
const feetY = async () => numbers(await command('data get entity Claude Pos'))[1];
const sneaking = async () => /passed/i.test(await command('execute as Claude if predicate {condition:"minecraft:entity_properties",entity:"this",predicate:{flags:{is_sneaking:true}}}'));
async function alone() { const reply = await command('list'); const names = (reply.match(/:\s*(.*)$/)?.[1] || '').split(',').map(s => s.trim()).filter(Boolean); assert(names.every(n => n === 'Claude'), '服务器上有别的玩家，不搭夹具：' + reply); }
async function hello() {
  const r = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
  return (await r.json()).result;
}
let client, transport, stderr = '', home;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
const code = reply => reply.value.code || reply.value.error?.code || reply.value.result?.code || String(reply.value.text || '').match(/[A-Z_]{4,}/)?.[0];
const angle = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

try {
  await alone();
  const h = await hello();
  check('hello 列出六个内置手势', ['wave', 'nod', 'shake', 'crouch', 'jump', 'spin'].every(g => h.emotes?.builtin?.includes(g)), h.emotes);
  check('hello 列出 YSM 动画来源和提示', h.emotes?.sources?.some(s => s.id === 'yes_steve_model:animation' && /extra0/.test(s.hint)), h.emotes?.sources);
  const models = h.appearances?.find(s => s.id === 'yes_steve_model:model');
  check('hello 列出服务器 custom 里的 YSM 模型', models?.choices?.length > 0, h.appearances);
  const model = models.choices[0];
  check('emote 和 set-appearance 是服务端能力', h.capabilities.includes('emote') && h.capabilities.includes('set-appearance'));

  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID(), '--appearance', `yes_steve_model:model=${model}`], cwd: root, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  client = new Client({ name: 'emote-smoke', version: '1' });
  await client.connect(transport);
  await wait(500);
  check('接管后套用了选好的 YSM 模型（指令已发出）', stderr.includes(`外观：yes_steve_model:model ${model}`), redact(stderr).slice(-400));
  const tools = (await client.listTools()).tools;
  const emote = tools.find(t => t.name === 'emote');
  check('MCP 有 emote 工具，没有 set-appearance', emote && !tools.some(t => t.name === 'set-appearance'), emote?.description);

  home = numbers(await command('data get entity Claude Pos'));
  await fixture('time set 1000'); await fixture('weather clear');
  await fixture('forceload add 4999 4999 5001 5001');
  await fixture('fill 4998 199 4998 5002 199 5002 minecraft:glass');
  await fixture('fill 4998 200 4998 5002 203 5002 minecraft:air');
  await fixture('tp Claude 5000.5 200 5000.5 0 0');
  await wait(1500);

  for (const name of ['wave', 'nod', 'shake', 'spin']) {
    const before = await rotation();
    const done = await tool('emote', { name });
    const after = await rotation();
    check(`${name} 做完，朝向复原`, !done.error && done.value.status === 'succeeded' && angle(before[0], after[0]) < 2 && Math.abs(before[1] - after[1]) < 2, { done: done.value, before, after });
  }
  let crouched = false;
  const crouch = tool('emote', { name: 'crouch' });
  for (let i = 0; i < 10 && !crouched; i++) { crouched = await sneaking(); await wait(80); }
  const crouchDone = await crouch;
  check('crouch 途中真的蹲下，做完站直', crouched && crouchDone.value.status === 'succeeded' && !(await sneaking()), crouchDone.value);
  const ground = await feetY(); let highest = ground;
  const jump = tool('emote', { name: 'jump' });
  for (let i = 0; i < 12; i++) { highest = Math.max(highest, await feetY()); await wait(60); }
  const jumpDone = await jump;
  check('jump 途中离地，落回平台', jumpDone.value.status === 'succeeded' && highest > ground + 0.3 && Math.abs(await feetY() - ground) < 0.1, { ground, highest });
  const faced = await tool('emote', { name: 'wave', player: 'Nobody' });
  check('player 不在附近：拒绝，不做', faced.error || faced.value.status === 'failed', faced.value);
  const unknown = await tool('emote', { name: 'dance' });
  check('没有 source 时不认识的名字被拒绝', unknown.error || unknown.value.status === 'failed', unknown.value);
  const dance = await tool('emote', { name: 'extra6', source: 'yes_steve_model:animation', seconds: 2 });
  check('YSM 动画 extra6：指令已发出，回执带来源和时长', !dance.error && dance.value.status === 'succeeded' && dance.value.result?.seconds === 2, dance.value);
  await wait(2500);

  await tool('wait-for-events', { timeoutSeconds: 0 });
  await fixture('weather rain');
  const rain = await tool('wait-for-events', { timeoutSeconds: 8, types: ['scene'] });
  check('露天开始下雨：一次 scene 事件', JSON.stringify(rain.value).includes('下雨了'), rain.value);
  // Rain fades out over a few seconds; the test server also has doDaylightCycle off, so the sunset is two time jumps.
  await fixture('weather clear'); await wait(6000);
  await fixture('time set 11700'); await wait(2000); await fixture('time set 11900');
  const sunset = await tool('wait-for-events', { timeoutSeconds: 15, types: ['scene'] });
  check('太阳下山：一次 scene 事件', JSON.stringify(sunset.value).includes('太阳快下山了'), sunset.value);
} finally {
  try { await client?.close(); } catch {}
  try { if (home) await fixture(`tp Claude ${home.join(' ')}`); await fixture('time set 1000'); await fixture('weather clear'); await fixture('fill 4998 199 4998 5002 199 5002 minecraft:air'); await fixture('forceload remove 4999 4999 5001 5001'); } catch (e) { console.log('清理失败：' + e.message); }
  report.finished = new Date().toISOString(); report.stderr = redact(stderr).slice(-2000);
  await save();
  console.log(`${report.checks.filter(c => c.passed).length} 项通过；报告 ${path.relative(root, path.join(dir, 'report.json'))}`);
}
