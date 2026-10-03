import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClientBody, readConnection } from './client-body.js';
import { ServerBody, readServerConnection, type ServerLease } from './server-body.js';
import { EventJournal } from './events.js';
import { acquireRuntimeLock, RuntimeMonitor, hostedHeartbeatFresh } from './lifecycle.js';
import { createMcpServer } from './mcp.js';
import { CompanionMode } from './companion-mode.js';
import { GatherTasks } from './gather-tasks.js';
import { BodyError, type Body } from './body.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    body: { type: 'string', default: 'client' }, 'controller-id': { type: 'string' },
    'respawn-only': { type: 'boolean', default: false },
    'connection-file': { type: 'string' }, username: { type: 'string' }, 'world-id': { type: 'string' },
    nickname: { type: 'string' }, 'runtime-dir': { type: 'string', default: 'runtime' }, 'bot-players': { type: 'string', default: '' },
    'memory-dir': { type: 'string' }, 'memory-agent': { type: 'string' }, hosted: { type: 'boolean', default: false },
  } });
  if (!['client', 'server'].includes(values.body!)) throw new Error('--body 只允许 client 或 server');
  const bodyLabel = values.body === 'server' ? 'ServerBody' : 'ClientBody';
  if (!values['connection-file'] || !values.username || !values['world-id']) throw new Error('必填参数：--connection-file <文件> --username <角色名> --world-id <资料标识>');
  if (!/^[A-Za-z0-9_]{1,16}$/.test(values.username)) throw new Error('username 只允许 1–16 位英文、数字或下划线');
  if (values['respawn-only']) {
    if (values.body !== 'server' || values.hosted) throw new Error('--respawn-only 仅用于独立显式 --body server；不能作为托管／MCP 自动恢复');
    const result = await ServerBody.respawn({ connection: await readServerConnection(values['connection-file']), username: values.username, worldId: values['world-id'] });
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }
  const runtimeDir = path.resolve(values['runtime-dir']!);
  const heartbeatFile = path.join(runtimeDir, `companion-${values.username}.json`);
  if (values.hosted && !hostedHeartbeatFresh(heartbeatFile)) throw new Error('托管驱动心跳不存在或过期，未接管身体');
  const releaseLock = acquireRuntimeLock(runtimeDir, values.username);
  let body: Body | undefined;
  let lease: ServerLease | undefined;
  const controlFile = path.join(runtimeDir, `server-control-${values.username}.json`);
  const removeControlFile = () => {
    if (!lease) return;
    try {
      const current = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
      if (current.leaseId === lease.leaseId && current.controllerId === lease.controllerId && current.instanceId === lease.instanceId) fs.unlinkSync(controlFile);
    } catch {}
  };
  let monitor: RuntimeMonitor | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  let events: EventJournal | undefined;
  let companion: CompanionMode | undefined;
  let closing = false;
  let lost = false;
  const loseControl = (error: Error) => {
    if (lost || closing) return;
    lost = true;
    companion?.fail(error, undefined, true);
    monitor?.stop();
    process.stderr.write(`${bodyLabel} 控制已结束：${error.message}；请手动重启托管。\n`);
    try { events?.add('disconnect', error.message); } catch {}
    // Keep MCP alive with terminal errors, so an Agent retry cannot reacquire a changed world.
    void body?.close();
    removeControlFile();
  };
  const shutdown = async (reason?: Error) => {
    if (closing) return;
    closing = true;
    monitor?.stop();
    if (reason) {
      process.stderr.write(`${bodyLabel} 停止：${reason.message}\n`);
      try { events?.add('disconnect', reason.message); } catch {}
      process.exitCode = 1;
    }
    await body?.close();
    removeControlFile();
    await server?.close();
    releaseLock();
  };
  try {
    const shared = { username: values.username, worldId: values['world-id'], onLost: loseControl };
    body = values.body === 'server'
      ? await ServerBody.connect({ ...shared, connection: await readServerConnection(values['connection-file']), controllerId: values['controller-id'], onLease: acquired => {
        lease = acquired;
        const temporary = `${controlFile}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify({ ...acquired, connectionFile: path.resolve(values['connection-file']!) }), { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, controlFile);
        } finally { try { fs.unlinkSync(temporary); } catch {} }
      } })
      : await ClientBody.connect({ ...shared, connection: await readConnection(values['connection-file']) });
    if (closing) { await body.close(); return; }
    events = new EventJournal(values.hosted ? runtimeDir : undefined, values.username, values['bot-players']!.split(',').filter(Boolean), lease?.chatCursor);
    events.ingest(await body.observe());
    const gather = new GatherTasks(body, events);
    if (body.hello.capabilities.includes('follow-companion')) companion = new CompanionMode(body, events, gather);
    server = createMcpServer(body, events, { chatFloor: lease?.chatCursor, companion, gather });
    monitor = new RuntimeMonitor(body, events, {
      ...(values.hosted ? { heartbeatFile } : {}),
      companion,
      onFatal: error => { if (error instanceof BodyError && error.code === 'HOST_LOST') void shutdown(error); else loseControl(error); },
    });
    const transport = new StdioServerTransport();
    transport.onclose = () => { void shutdown(); };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.stdin.once('end', () => { void shutdown(); });
    await server.connect(transport);
    monitor.start();
  } catch (error) { await shutdown(error as Error); }
}
void main().catch(error => { process.stderr.write(`Body 启动失败：${error.message}\n`); process.exitCode = 1; });
