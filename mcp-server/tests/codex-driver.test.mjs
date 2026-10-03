// 真 companion 子进程 + 假 Codex app-server；所有路径和配置隔离，无模型或游戏网络请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive, readSessionState, runtimeFiles, stripAnsi } from '../../scripts/companion.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.resolve(HERE, '../../scripts/companion.mjs');
const FAKE = path.join(HERE, 'fixtures', 'fake-codex.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, description, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`等待超时：${description}`);
}

function setup(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-codex-driver-'));
  const runtime = path.join(dir, 'runtime');
  const memory = path.join(dir, 'memory');
  const server = path.join(dir, 'server');
  const codexHome = path.join(dir, 'codex-home');
  for (const folder of [runtime, memory, server, codexHome]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(server, 'server.properties'), 'enable-rcon=false\nrcon.port=1\nrcon.password=test-only\n');
  const configFile = path.join(dir, 'test-mcp.json');
  const originalConfig = { mcpServers: { minecraft: { command: process.execPath, args: ['never-run-mcp-fixture.mjs', '--username', 'CodexBot', '--nickname', 'Codex'] } } };
  fs.writeFileSync(configFile, JSON.stringify(originalConfig));
  const agentLog = path.join(dir, 'agent.jsonl');
  const control = path.join(dir, 'control.jsonl');
  const env = {
    ...process.env,
    COMPANION_RUNTIME_DIR: runtime,
    COMPANION_MEMORY_DIR: memory,
    COMPANION_AGENT_CMD: JSON.stringify([process.execPath, FAKE]),
    MC_SERVER_DIR: server,
    CODEX_HOME: codexHome,
    FAKE_AGENT_LOG: agentLog,
    FAKE_CODEX_CONTROL: control,
    ...extraEnv,
  };
  let sequence = 0;
  const records = () => {
    try { return fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  const F = runtimeFiles(runtime, 'CodexBot');
  return {
    dir, runtime, env, configFile, originalConfig, F, records,
    turns: () => records().filter((record) => record.kind === 'turn'),
    requests: (method) => records().filter((record) => record.kind === 'request' && record.method === method),
    chat: (text) => fs.appendFileSync(F.events, JSON.stringify({ session: 'fake-game', seq: ++sequence, timestamp: Date.now(), type: 'chat', text: `tester: ${text}` }) + '\n'),
    complete: (turn, overrides = {}) => fs.appendFileSync(control, JSON.stringify({ action: 'complete', threadId: turn.threadId, turnId: turn.turnId, ...overrides }) + '\n'),
  };
}

function startDriver(s) {
  const p = spawn(process.execPath, [DRIVER, '--agent', 'codex', '--name', 'CodexBot', '--nickname', 'Codex', '--mcp-config', s.configFile,
    '--headless', '--server-wait-minutes', '0'], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  p.stdout.on('data', (data) => { output += data; });
  p.stderr.on('data', (data) => { output += data; });
  const exited = new Promise((resolve) => p.once('exit', resolve));
  return { p, exited, output: () => stripAnsi(output) };
}

async function stopDriver(s, d) {
  if (d.p.exitCode !== null || d.p.signalCode !== null) return;
  fs.writeFileSync(s.F.stop, '');
  let timer;
  try {
    const result = await Promise.race([d.exited, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 10000); })]);
    assert.equal(result, 0, d.output());
  } finally {
    clearTimeout(timer);
    if (d.p.exitCode === null && d.p.signalCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(d.p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else d.p.kill();
    }
  }
}

async function ready(s, d) {
  await waitFor(() => readSessionState(s.F.session).lastRequestAt > 0, `启动轮完成\n${d.output()}`);
  return s.turns()[0];
}

test('Codex 驱动：完成握手后才提交启动轮，聊天排队后唤醒，配置和心跳隔离', async () => {
  const s = setup({ FAKE_CODEX_INIT_DELAY_MS: '700' });
  const d = startDriver(s);
  try {
    await waitFor(() => s.requests('initialize').length, 'initialize');
    s.chat('握手时已经到达的消息');
    await ready(s, d);
    const eventTurn = await waitFor(() => s.turns().find((turn) => turn.text.includes('握手时已经到达的消息')), '排队的游戏事件');
    assert.match(eventTurn.text, /游戏事件/);
    const methods = s.records().filter((record) => record.kind === 'request').map((record) => record.method);
    assert.ok(methods.indexOf('initialize') < methods.indexOf('initialized'));
    assert.ok(methods.indexOf('initialized') < methods.indexOf('config/read'));
    assert.ok(methods.indexOf('config/read') < methods.indexOf('thread/start'));
    assert.ok(methods.indexOf('thread/start') < methods.indexOf('turn/start'));
    assert.equal(s.requests('config/read')[0].params.includeLayers, false);
    assert.deepEqual(s.records().filter((record) => record.kind === 'violation'), []);
    const thread = s.requests('thread/start')[0];
    assert.equal(thread.params.config.mcp_servers.inherited.enabled, false);
    assert.ok(thread.params.config.mcp_servers.minecraft.args.includes('--hosted'));
    assert.deepEqual(JSON.parse(fs.readFileSync(s.configFile, 'utf8')), s.originalConfig, '不修改原 MCP 配置');
    assert.equal(readSessionState(s.F.session).provider, 'codex');
    assert.match(readSessionState(s.F.session).conversationId, /^fake-codex-/);
    const heartbeat = JSON.parse(fs.readFileSync(s.F.heartbeat, 'utf8'));
    assert.equal(heartbeat.agent, 'codex');
    assert.equal(heartbeat.pid, d.p.pid);
    // Fake Agent 的日志文件与驱动器 stdout 是两条独立 IPC；请求已记录不代表 stdout 已被父测试读到。
    await waitFor(() => /收到/.test(d.output()), '驱动器收到回合完成输出');
  } finally { await stopDriver(s, d); }
  assert.equal(fs.existsSync(s.F.lock), false);
});

test('Codex 驱动：异会话及重复完成通知不能提前放行忙轮的后续事件', async () => {
  const s = setup();
  const d = startDriver(s);
  try {
    const startup = await ready(s, d);
    s.chat('[hold] 第一轮保持运行');
    const active = await waitFor(() => s.turns()[1], '保持运行的轮次');
    s.chat('排队的后续消息');
    await sleep(1900);
    assert.equal(s.turns().length, 2, '忙时不得提前启动下一轮');
    s.complete(active, { threadId: 'unrelated-thread' });
    s.complete(startup);
    await waitFor(() => s.records().filter((record) => record.kind === 'completed').length >= 3, '注入两个无关完成通知');
    await sleep(350);
    assert.equal(s.turns().length, 2, '无关完成通知不能结束当前轮');
    s.complete(active);
    const next = await waitFor(() => s.turns()[2], '真正完成后的排队轮');
    assert.match(next.text, /排队的后续消息/);
    assert.deepEqual(s.records().filter((record) => record.kind === 'violation'), []);
  } finally { await stopDriver(s, d); }
});

test('Codex 驱动：失败轮和 RPC 错误不刷新成功时间，下一条聊天可以继续', async () => {
  const s = setup();
  const d = startDriver(s);
  try {
    await ready(s, d);
    const lastSuccess = readSessionState(s.F.session).lastRequestAt;
    s.chat('[fail] 失败轮');
    await waitFor(() => d.output().includes('fake turn failed'), '失败轮已被处理');
    assert.equal(readSessionState(s.F.session).lastRequestAt, lastSuccess);
    s.chat('[rpc-error] RPC 拒绝');
    await waitFor(() => d.output().includes('fake turn RPC failed'), 'RPC 错误已被处理');
    assert.equal(readSessionState(s.F.session).lastRequestAt, lastSuccess);
    s.chat('错误之后的新消息');
    await waitFor(() => readSessionState(s.F.session).lastRequestAt > lastSuccess, '恢复成功');
    assert.equal(s.turns().length, 4, '不重放失败的动作轮');
    assert.match(s.turns()[3].text, /错误之后的新消息/);
  } finally { await stopDriver(s, d); }
});

test('Codex 驱动：停止忙轮时先 interrupt 当前线程轮次，再关闭进程和释放锁', async () => {
  const s = setup();
  const d = startDriver(s);
  try {
    await ready(s, d);
    s.chat('[hold] 停止测试');
    const active = await waitFor(() => s.turns()[1], '忙轮启动');
    await stopDriver(s, d);
    const interrupt = s.requests('turn/interrupt')[0];
    assert.ok(interrupt, d.output());
    assert.equal(interrupt.params.threadId, active.threadId);
    assert.equal(interrupt.params.turnId, active.turnId);
    const records = s.records();
    const interruptIndex = records.findIndex((record) => record.kind === 'request' && record.method === 'turn/interrupt');
    assert.ok(interruptIndex >= 0 && interruptIndex < records.findIndex((record) => record.kind === 'stdin_closed'));
    assert.equal(fs.existsSync(s.F.lock), false);
  } finally { await stopDriver(s, d); }
});

test('Codex 驱动：同名实例被拒绝，正常重启 resume 旧线程且不重发启动轮', async () => {
  const s = setup();
  const d = startDriver(s);
  try {
    const startup = await ready(s, d);
    const duplicate = startDriver(s);
    try {
      assert.equal(await duplicate.exited, 3, duplicate.output());
      assert.equal(s.records().filter((record) => record.kind === 'start').length, 1);
      assert.equal(JSON.parse(fs.readFileSync(s.F.lock, 'utf8')).pid, d.p.pid);
    } finally { if (duplicate.p.exitCode === null) duplicate.p.kill(); }
    await stopDriver(s, d);
    const resumed = startDriver(s);
    try {
      const request = await waitFor(() => s.requests('thread/resume')[0], '恢复线程');
      assert.equal(request.params.threadId, startup.threadId);
      assert.ok(request.params.config.mcp_servers.minecraft.args.includes('--hosted'), '恢复时也重新绑定托管 MCP');
      await sleep(500);
      assert.equal(s.turns().length, 1, '恢复不重发启动轮');
      s.chat('重启之后的新事件');
      const eventTurn = await waitFor(() => s.turns()[1], '恢复后的事件轮');
      assert.equal(eventTurn.threadId, startup.threadId);
      assert.match(eventTurn.text, /重启之后的新事件/);
      assert.match(eventTurn.text, /驱动器提示/);
    } finally { await stopDriver(s, resumed); }
  } finally { await stopDriver(s, d); }
});

test('Codex 驱动：已接受的动作轮崩溃后不重放，恢复后继续响应新事件', async () => {
  const s = setup();
  const d = startDriver(s);
  try {
    const startup = await ready(s, d);
    s.chat('[crash-once] 只接受一次的动作');
    await waitFor(() => s.records().some((record) => record.kind === 'crash'), 'fake 崩溃');
    const resume = await waitFor(() => s.requests('thread/resume')[0], '崩溃后恢复线程', 15000);
    assert.equal(resume.params.threadId, startup.threadId);
    await sleep(400);
    assert.equal(s.turns().filter((turn) => turn.text.includes('只接受一次的动作')).length, 1);
    s.chat('崩溃之后的新事件');
    const next = await waitFor(() => s.turns().find((turn) => turn.text.includes('崩溃之后的新事件')), '新事件轮');
    assert.equal(next.threadId, startup.threadId);
    assert.match(next.text, /驱动器提示/);
    assert.equal(s.turns().length, 3, '启动轮、已接受但崩溃的轮、新事件轮各一次');
    assert.deepEqual(s.records().filter((record) => record.kind === 'violation'), []);
  } finally { await stopDriver(s, d); }
});

test('Codex 驱动：游戏快捷停止原地停身体并中断忙轮，等待旧轮结束后兜底停止，清除旧队列', async () => {
  const s = setup({ FAKE_CODEX_MANUAL_INTERRUPT: '1' });
  const d = startDriver(s);
  try {
    await ready(s, d);
    s.chat('[hold] 正在执行的旧任务');
    const active = await waitFor(() => s.turns()[1], '旧任务保持运行');
    s.chat('旧排队命令：继续向前走');
    await waitFor(() => d.output().includes('旧排队命令：继续向前走'), '旧命令已进入驱动器队列');
    assert.equal(s.turns().length, 2, '旧命令仍在排队');

    s.chat('Codex 停');
    const toolCalls = () => s.requests('mcpServer/tool/call');
    const stops = () => toolCalls().filter((record) => record.params.tool === 'stop-action');
    await waitFor(() => stops()[0], '宿主立即停止身体');
    const interrupt = await waitFor(() => s.requests('turn/interrupt')[0], '宿主中断模型轮');
    assert.equal(interrupt.params.threadId, active.threadId);
    assert.equal(interrupt.params.turnId, active.turnId);
    assert.deepEqual(stops()[0].params, { threadId: active.threadId, server: 'minecraft', tool: 'stop-action', arguments: {} });
    await sleep(350);
    assert.equal(stops().length, 1, 'interrupt 回应不代表旧模型轮已停止，不能提前确认或放行');
    assert.equal(toolCalls().filter((record) => record.params.tool === 'send-chat').length, 0);
    assert.equal(s.turns().length, 2);
    assert.equal(pidAlive(active.pid), true, '游戏叫停不能结束 Agent 进程');

    s.complete(active, { status: 'interrupted' });
    const confirmation = await waitFor(() => toolCalls().find((record) => record.params.tool === 'send-chat'), '宿主直接确认停止');
    assert.equal(stops().length, 2, '旧轮结束后再次停身体，撤销停止期间可能发出的动作');
    assert.equal(confirmation.params.threadId, active.threadId);
    assert.equal(confirmation.params.server, 'minecraft');
    assert.match(confirmation.params.arguments.message, /已停|停下|停止/);
    const records = s.records();
    const completedIndex = records.findIndex((record) => record.kind === 'completed' && record.turnId === active.turnId);
    const stopIndices = records.flatMap((record, index) => record.kind === 'request' && record.method === 'mcpServer/tool/call' && record.params.tool === 'stop-action' ? [index] : []);
    const confirmationIndex = records.findIndex((record) => record.kind === 'request' && record.method === 'mcpServer/tool/call' && record.params.tool === 'send-chat');
    assert.ok(stopIndices[0] < completedIndex && completedIndex < stopIndices[1] && stopIndices[1] < confirmationIndex);
    assert.equal(s.requests('thread/start').length, 1);
    assert.equal(s.requests('thread/resume').length, 0);
    await sleep(1800);
    assert.equal(s.turns().length, 2, '停止无需额外模型确认轮，也不重放旧队列');
    assert.equal(s.records().filter((record) => record.kind === 'stdin_closed').length, 0);
    assert.equal(s.records().filter((record) => record.kind === 'start').length, 1);

    s.complete(active); // 迟到的成功通知也不能恢复旧任务。
    s.chat('停止之后请报告状态');
    const next = await waitFor(() => s.turns()[2], '停止之后的新消息仍可执行');
    assert.equal(next.pid, active.pid);
    assert.equal(next.threadId, active.threadId);
    assert.match(next.text, /停止之后请报告状态/);
    assert.doesNotMatch(next.text, /旧排队命令|正在执行的旧任务|\[hold\]/);
    assert.equal(s.turns().length, 3);
    assert.deepEqual(s.records().filter((record) => record.kind === 'violation'), []);
  } finally { await stopDriver(s, d); }
});

test('Codex 驱动：模型空闲但身体仍跟随时单独说停下也原地停止，新聊天仍可执行', async () => {
  const s = setup();
  const d = startDriver(s);
  try {
    await ready(s, d);
    s.chat('[follow] 开始跟随');
    const follow = await waitFor(() => s.records().find((record) => record.kind === 'following'), '身体进入持续跟随');
    await waitFor(() => s.records().some((record) => record.kind === 'completed' && record.turnId === follow.turnId), '跟随工具已返回，模型轮结束');
    await sleep(100);
    s.chat('停下');
    const confirmation = await waitFor(() => s.records().find((record) => record.kind === 'host_tool' && record.tool === 'send-chat'), '空闲时宿主确认停止');
    const stops = s.records().filter((record) => record.kind === 'host_tool' && record.tool === 'stop-action');
    assert.ok(stops.length >= 1, '即使没有模型忙轮，也要停止持续身体动作');
    assert.equal(stops.every((record) => record.following === false), true);
    assert.equal(confirmation.following, false);
    assert.equal(s.requests('turn/interrupt').length, 0, '没有模型忙轮无需 interrupt');
    assert.equal(s.requests('thread/start').length, 1);
    assert.equal(s.requests('thread/resume').length, 0);
    assert.equal(s.turns().length, 2, '确认停止无需模型回合');
    assert.equal(s.records().filter((record) => record.kind === 'stdin_closed').length, 0);
    assert.equal(pidAlive(follow.pid), true);

    s.chat('停止后报告背包');
    const next = await waitFor(() => s.turns()[2], '空闲停止之后的新消息');
    assert.equal(next.pid, follow.pid);
    assert.equal(next.threadId, follow.threadId);
    assert.match(next.text, /停止后报告背包/);
    assert.doesNotMatch(next.text, /\[follow\]/);
    assert.deepEqual(s.records().filter((record) => record.kind === 'violation'), []);
  } finally { await stopDriver(s, d); }
});

test('Codex 驱动：旧轮结束后的兜底停止返回 isError，不误报成功并结束托管', async () => {
  const s = setup({ FAKE_CODEX_STOP_ERROR_CALL: '2' });
  const d = startDriver(s);
  try {
    await ready(s, d);
    s.chat('[hold] 停止失败测试');
    const active = await waitFor(() => s.turns()[1], '忙轮启动');
    s.chat('Codex 停');
    await waitFor(() => d.p.exitCode !== null, '无法确认停止时结束托管');
    assert.equal(d.p.exitCode, 0, d.output());
    assert.match(d.output(), /无法确认原地停止.*fake stop-action failed/);
    assert.doesNotMatch(d.output(), /原地停止已确认/);
    const calls = s.requests('mcpServer/tool/call');
    assert.equal(calls.filter((call) => call.params.tool === 'stop-action').length, 2);
    assert.equal(calls.filter((call) => call.params.tool === 'send-chat').length, 0, '失败时不能向玩家报已停止');
    assert.equal(s.turns().length, 2, '不调用模型补写成功确认');
    assert.equal(s.records().filter((record) => record.kind === 'start').length, 1, '不自动重启失败停止的身体');
    assert.equal(pidAlive(active.pid), false);
    assert.equal(fs.existsSync(s.F.lock), false);
  } finally { await stopDriver(s, d); }
});

test('Codex 驱动：interrupt 只有 ACK 没有完成通知时超时，不误报成功并结束托管', async () => {
  const s = setup({ FAKE_CODEX_MANUAL_INTERRUPT: '1' });
  const d = startDriver(s);
  try {
    await ready(s, d);
    s.chat('[hold] 一直不完成的旧轮');
    const active = await waitFor(() => s.turns()[1], '忙轮启动');
    s.chat('Codex 停');
    await waitFor(() => s.requests('turn/interrupt')[0], '中断请求已收到 ACK');
    s.chat('请报告背包');
    await waitFor(() => d.p.exitCode !== null, '等待真实结束超时后关闭托管', 15000);
    assert.equal(d.p.exitCode, 0, d.output());
    assert.match(d.output(), /无法确认原地停止.*停止确认超时/);
    assert.doesNotMatch(d.output(), /原地停止已确认/);
    const calls = s.requests('mcpServer/tool/call');
    assert.equal(calls.filter((call) => call.params.tool === 'stop-action').length, 1, '只有首次立即停止，未完成时不进入成功路径');
    assert.equal(calls.filter((call) => call.params.tool === 'send-chat').length, 0);
    assert.equal(s.turns().length, 2, '等待停止期间的新消息不得提前执行');
    assert.equal(s.records().filter((record) => record.kind === 'start').length, 1);
    assert.equal(pidAlive(active.pid), false);
    assert.equal(fs.existsSync(s.F.lock), false);
  } finally { await stopDriver(s, d); }
});
