// ClientBody 的托管接线：真实驱动器 + 假 Codex；不启动模型、Minecraft 或 MCP 身体。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodySessionScope, effectiveConfigDir, parseArgs, readSessionState,
  resumableConversation, runtimeFiles, stripAnsi } from '../../scripts/companion.mjs';
import { CODEX_CLIENT_TOOLS, CODEX_GAME_TOOLS, codexThreadConfig } from '../../scripts/agents/codex-app-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.resolve(HERE, '../../scripts/companion.mjs');
const FAKE = path.join(HERE, 'fixtures/fake-codex.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}

test('ClientBody 参数拒绝尚未接通的托管 Agent，强制关闭旧服务器探测', () => {
  const args = parseArgs(['--agent', 'codex', '--body', 'client', '--server-check-seconds', '1']);
  assert.equal(args.body, 'client');
  assert.equal(args.serverCheckSeconds, 0);
  assert.equal(args.effort, 'low');
  assert.equal(parseArgs(['--agent', 'codex']).body, 'mineflayer');
  assert.ok(parseArgs(['--agent', 'codex']).serverCheckSeconds > 0, '旧身体仍保留原有在线探测');
  assert.throws(() => parseArgs(['--agent', 'claude', '--body', 'client']), /仅接通 Codex/);
  assert.throws(() => parseArgs(['--agent', 'codex', '--body', 'unknown']), /--body/);
});

test('ClientBody 会话只在相同身体、世界、客户端文件和身份内恢复', () => {
  const args = parseArgs(['--agent', 'codex', '--body', 'client', '--name', 'ClientTest']);
  const connection = path.resolve('runtime/client-test/connection.json');
  const scope = bodySessionScope(args, ['--world-id', 'world-a', '--connection-file', connection]);
  assert.deepEqual(scope, {
    body: 'client', worldId: 'world-a', username: 'ClientTest',
    connectionFile: process.platform === 'win32' ? connection.toLowerCase() : connection,
  });
  assert.deepEqual(bodySessionScope(args, ['--world-id=world-a', `--connection-file=${connection}`]), scope);
  assert.equal(bodySessionScope({ body: 'mineflayer' }, []), null);
  assert.throws(() => bodySessionScope(args, ['--world-id', 'world-a']), /connection-file/);
  assert.throws(() => bodySessionScope(args, ['--connection-file', connection]), /world-id/);

  const now = Date.now();
  const state = { conversationId: 'old-thread', provider: 'codex', configDir: '/test-account', lastRequestAt: now - 1000, bodyScope: scope };
  const options = { provider: 'codex', configDir: '/test-account', resumeWindowMs: 60000, bodyScope: { ...scope } };
  assert.equal(resumableConversation(state, now, options), 'old-thread');
  for (const [key, value] of Object.entries({ body: 'mineflayer', worldId: 'world-b', connectionFile: `${connection}.other`, username: 'OtherBot' })) {
    assert.equal(resumableConversation(state, now, { ...options, bodyScope: { ...scope, [key]: value } }), '', `${key} 改变不能恢复`);
  }
  const { bodyScope: omitted, ...legacyState } = state;
  assert.equal(resumableConversation(legacyState, now, options), '', '旧 Mineflayer 会话不能流入 ClientBody');
  assert.equal(resumableConversation(state, now, { ...options, bodyScope: null }), '', 'ClientBody 会话不能流入旧身体');
  assert.equal(resumableConversation(legacyState, now, { ...options, bodyScope: null }), 'old-thread', '原身体会话恢复行为保留');
});

test('Codex 按身体开放工具，客户端动作可用且旧记忆和自动采集工具不混入', () => {
  const server = { command: process.execPath, args: ['not-executed.mjs'] };
  const config = codexThreadConfig({}, server, process.cwd(), 'client');
  assert.deepEqual(config.mcp_servers.minecraft.enabled_tools, CODEX_CLIENT_TOOLS);
  for (const name of ['get-block', 'get-operation', 'dig-block', 'place-block', 'open-container', 'get-container', 'click-slot', 'close-container']) {
    assert.ok(config.mcp_servers.minecraft.enabled_tools.includes(name), name);
  }
  for (const name of ['memory-context', 'memory-recall', 'give-item', 'collect-items', 'go-to-player', 'run-script']) {
    assert.equal(config.mcp_servers.minecraft.enabled_tools.includes(name), false, name);
  }
  assert.deepEqual(codexThreadConfig({}, server, process.cwd()).mcp_servers.minecraft.enabled_tools, CODEX_GAME_TOOLS);
});

test('ClientBody 真实驱动接线：新会话、客户端提示和工具进入 RPC，不探测服务器或修改原配置', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-client-driver-'));
  const runtime = path.join(dir, 'runtime');
  const codexHome = path.join(dir, 'codex-home');
  const memory = path.join(dir, 'memory');
  for (const folder of [runtime, codexHome, memory]) fs.mkdirSync(folder, { recursive: true });
  const F = runtimeFiles(runtime, 'ClientTest');
  const connectionFile = path.join(dir, 'connection.json');
  const configFile = path.join(dir, 'mcp.json');
  const source = { mcpServers: { minecraft: { command: process.execPath,
    args: ['not-executed-client-runtime.mjs', '--connection-file', connectionFile, '--world-id', 'world-a', '--username', 'ClientTest'] },
    unrelated: { command: 'not-executed-unrelated', args: [] } } };
  const originalBytes = Buffer.from(JSON.stringify(source));
  fs.writeFileSync(configFile, originalBytes);
  // 同身份的旧身体会话存在时，也必须改开 ClientBody 新会话。
  fs.writeFileSync(F.session, JSON.stringify({ conversationId: 'mineflayer-old-thread', provider: 'codex',
    configDir: effectiveConfigDir('codex', codexHome), lastRequestAt: Date.now(), contextTokens: 500 }));
  const agentLog = path.join(dir, 'agent.jsonl');
  const records = () => {
    try { return fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  const requests = (method) => records().filter((record) => record.kind === 'request' && record.method === method);
  let tcpConnections = 0;
  const canary = net.createServer((socket) => { tcpConnections += 1; socket.destroy(); });
  await new Promise((resolve, reject) => { canary.once('error', reject); canary.listen(0, '127.0.0.1', resolve); });
  let driver;
  let output = '';
  let exited;
  try {
    driver = spawn(process.execPath, [DRIVER, '--agent', 'codex', '--body', 'client', '--name', 'ClientTest',
      '--nickname', 'Client', '--mcp-config', configFile, '--headless', '--mc-host', '127.0.0.1',
      '--mc-port', String(canary.address().port), '--server-check-seconds', '0.05', '--server-wait-minutes', '0.001'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        COMPANION_RUNTIME_DIR: runtime, COMPANION_MEMORY_DIR: memory,
        COMPANION_AGENT_CMD: JSON.stringify([process.execPath, FAKE]),
        CODEX_HOME: codexHome, FAKE_AGENT_LOG: agentLog, FAKE_CODEX_CONTROL: path.join(dir, 'control.jsonl') },
    });
    driver.stdout.on('data', (data) => { output += data; });
    driver.stderr.on('data', (data) => { output += data; });
    exited = new Promise((resolve) => driver.once('exit', resolve));
    await waitFor(() => readSessionState(F.session).conversationId.startsWith('fake-codex-')
      && readSessionState(F.session).lastRequestAt > 0, '新客户端启动轮完成');
    assert.equal(requests('thread/resume').length, 0);
    assert.equal(requests('thread/start').length, 1);
    const thread = requests('thread/start')[0];
    assert.deepEqual(thread.params.config.mcp_servers.minecraft.enabled_tools, CODEX_CLIENT_TOOLS);
    assert.equal(thread.params.config.mcp_servers.inherited.enabled, false);
    const hostedArgs = thread.params.config.mcp_servers.minecraft.args;
    assert.ok(hostedArgs.includes('--hosted'));
    assert.equal(hostedArgs[hostedArgs.indexOf('--connection-file') + 1], connectionFile);
    assert.equal(hostedArgs[hostedArgs.indexOf('--world-id') + 1], 'world-a');
    assert.equal(hostedArgs[hostedArgs.indexOf('--runtime-dir') + 1], runtime);
    const startup = records().find((record) => record.kind === 'turn');
    assert.match(startup.text, /ClientBody.*真实 Minecraft 客户端/);
    assert.match(startup.text, /驱动器不负责进服或退出/);
    assert.match(startup.text, /running.*get-operation/);
    assert.match(startup.text, /unknown.*不盲目重发/);
    assert.doesNotMatch(startup.text, /你会被自动下线|会自动进服|调用 memory-context/);
    const saved = readSessionState(F.session);
    assert.deepEqual(saved.bodyScope, bodySessionScope({ body: 'client', name: 'ClientTest' }, source.mcpServers.minecraft.args));

    fs.appendFileSync(F.events, JSON.stringify({ session: 'fake-client-session', seq: 1,
      timestamp: Date.now(), type: 'chat', text: 'tester: 检查客户端状态' }) + '\n');
    await waitFor(() => records().some((record) => record.kind === 'turn' && record.text.includes('检查客户端状态')), '客户端聊天唤醒');
    assert.equal(tcpConnections, 0, '明确配置了在线 TCP 哨兵也不能探测，客户端连接由用户管理');
    assert.deepEqual(fs.readFileSync(configFile), originalBytes, '逐字节保留原 MCP 配置');
    assert.deepEqual(records().filter((record) => record.kind === 'violation'), []);
    fs.writeFileSync(F.stop, '');
    let timer;
    try {
      assert.equal(await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 10000); })]), 0, stripAnsi(output));
    } finally { clearTimeout(timer); }
    assert.equal(fs.existsSync(F.lock), false);
  } finally {
    if (driver && driver.exitCode === null && driver.signalCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(driver.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else driver.kill();
    }
    await new Promise((resolve) => canary.close(resolve));
    if (driver && exited) await exited;
    // 只清理本测试 mkdtemp 创建的目录，确认绝对路径在系统临时目录内。
    const tempRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(path.resolve(dir)), tempRoot);
    assert.ok(path.basename(dir).startsWith('mcbot-client-driver-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
