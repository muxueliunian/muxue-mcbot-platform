// stdout 只含 MCP 协议消息；日志/错误都在 stderr；大图片完整往返
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'stdio-server.mjs');
const MAIN = path.join(HERE, '..', 'dist', 'main.js');

// 极简 JSON-RPC 客户端：直接读原始 stdout 字节，每一行都必须是合法的 JSON-RPC 消息
function startServer(args) {
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutBuf = Buffer.alloc(0);
  let stderr = '';
  const rawLines = [];
  const messages = [];
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    let idx;
    while ((idx = stdoutBuf.indexOf(0x0a)) >= 0) {
      const line = stdoutBuf.subarray(0, idx).toString('utf8');
      stdoutBuf = stdoutBuf.subarray(idx + 1);
      rawLines.push(line);
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
      messages.push(msg);
      for (const w of waiters.splice(0)) w();
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const found = messages.find((m) => m && m.id === id);
      if (found) return found;
      await new Promise((r) => { waiters.push(r); setTimeout(r, 200); });
    }
    throw new Error(`no response to ${method}; stderr:\n${stderr}`);
  };
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const init = async () => {
    const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    notify('notifications/initialized', {});
    return r;
  };
  // 关闭 stdin 后等进程自己退出；5 秒还没退出就强制结束，并返回 false
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    child.stdin.end();
    return await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve(false); }, 5000);
      child.once('exit', () => { clearTimeout(t); resolve(true); });
    });
  };
  return { child, request, init, close, rawLines, messages, get stderr() { return stderr; }, get pending() { return stdoutBuf; } };
}

function assertOnlyProtocol(s, noise = null) {
  assert.equal(s.pending.length, 0, 'stdout 末尾不应有未换行的残留');
  s.rawLines.forEach((line, i) => {
    const m = s.messages[i];
    assert.ok(m && m.jsonrpc === '2.0' && (('id' in m && ('result' in m || 'error' in m)) || 'method' in m), `stdout 第 ${i + 1} 行不是合法 JSON-RPC：${line.slice(0, 120)}`);
  });
  // 伪造的"协议形状"日志一条都不能出现在 stdout
  if (noise) assert.ok(!s.rawLines.some((l) => noise.test(l)), 'stdout 混入了日志');
}

test('测试服务端：各种形状的日志全部进 stderr，stdout 只有协议；大图片字节完整；错误可见', async () => {
  const s = startServer([FIXTURE]);
  try {
    const init = await s.init();
    assert.equal(init.result.serverInfo.name, 'stdio-fixture');
    const noisy = await s.request('tools/call', { name: 'noisy', arguments: { tag: 'a' } });
    assert.deepEqual(noisy.result.content, [{ type: 'text', text: 'noisy done a' }]);

    const bytes = 3_000_000;
    const img = await s.request('tools/call', { name: 'image', arguments: { bytes } });
    assert.equal(img.result.content[0].text, `png ${bytes}`);
    const block = img.result.content[1];
    assert.equal(block.type, 'image');
    assert.equal(block.mimeType, 'image/png');
    assert.ok(!block.data.startsWith('data:'));
    const decoded = Buffer.from(block.data, 'base64');
    const expected = Buffer.alloc(bytes);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(expected);
    for (let i = 8; i < bytes; i++) expected[i] = (i * 31 + 7) & 0xff;
    assert.ok(decoded.equals(expected), '图片字节应与原始数据完全一致');

    const tooBig = await s.request('tools/call', { name: 'image', arguments: { bytes: 4_000_000 } });
    assert.equal(tooBig.result.isError, true);
    const fails = await s.request('tools/call', { name: 'fails', arguments: {} });
    assert.equal(fails.result.isError, true);
    assert.match(fails.result.content[0].text, /boom/);

    await new Promise((r) => setTimeout(r, 200));
    assertOnlyProtocol(s, /fake|startup noise|"raw":|not": "protocol|timestamp noise|callback write/);
    for (const expectedLog of ['startup noise', 'startup timestamp noise', '"fake":"a"', 'fake timestamp log a', 'multi\nline', '{"raw":"buffer a"}', 'callback write a', 'callback fired a', 'real error a', 'fake/after-connect']) {
      assert.ok(s.stderr.includes(expectedLog), `stderr 应包含：${expectedLog}`);
    }
  } finally {
    await s.close();
  }
});

test('真实入口 dist/main.js：连不上游戏服务器时 stdout 仍只有协议，工具列表完整', async () => {
  // 本地假端口：接受连接后立即关闭，不是 Minecraft 服务器
  const sink = net.createServer((sock) => sock.destroy());
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const port = sink.address().port;
  const s = startServer([MAIN, '--host', '127.0.0.1', '--port', String(port), '--username', 'TestBot', '--runtime-dir', path.join(HERE, '..', 'node_modules', '.cache', 'mcbot-test-runtime')]);
  try {
    const init = await s.init();
    assert.equal(init.result.serverInfo.name, 'mcbot-mcp-server');
    const list = await s.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['dig-block', 'mine-blocks', 'build', 'move-to-position', 'run-script', 'register-region', 'list-regions', 'check-action', 'stop-action']) {
      assert.ok(names.includes(n), `缺少工具 ${n}`);
    }
    const mine = list.result.tools.find((t) => t.name === 'mine-blocks');
    assert.ok(mine.inputSchema.properties.unlockRegions);
    assert.ok(mine.inputSchema.properties.background);
    const call = await s.request('tools/call', { name: 'get-position', arguments: {} });
    assert.equal(call.result.isError, true);
    await new Promise((r) => setTimeout(r, 300));
    assertOnlyProtocol(s);
    assert.match(s.stderr, /没有配置 --world-id/);
    assert.match(s.stderr, /\[mcp-server\]/);
    assert.equal(await s.close(), true, 'stdin 关闭后应自行退出');
    assert.match(s.stderr, /MCP Client has disconnected/);
  } finally {
    await s.close();
    sink.close();
  }
});
