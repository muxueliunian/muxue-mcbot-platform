import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BodyError, type Body, type BodyHello, type Position, type Observation, type ActionName, type ActionArguments, type Operation } from './body.js';

const position = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
const stack = z.object({ slot: z.number().int().nonnegative(), id: z.string(), count: z.number().int().nonnegative() });
const helloSchema = z.object({
  protocol: z.literal(1), platform: z.object({ minecraft: z.string(), loader: z.string(), loaderVersion: z.string() }),
  capabilities: z.array(z.string()), connected: z.boolean(), username: z.string().nullable(), sessionId: z.string().nullable(),
});
const observationSchema = z.object({
  sessionId: z.string(), worldId: z.string(), connected: z.boolean(), username: z.string(), dimension: z.string(),
  health: z.number(), food: z.number(), position, yaw: z.number(), pitch: z.number(), inventory: z.array(stack),
  entities: z.array(z.object({ id: z.string(), type: z.string(), name: z.string(), position })),
  chat: z.array(z.object({ seq: z.number().int(), time: z.number(), username: z.string().optional(), message: z.string() })),
  chatCursor: z.number().int(), container: z.object({ id: z.string(), type: z.string(), slots: z.array(stack), carried: z.object({ id: z.string(), count: z.number().int().nonnegative() }) }).nullable(),
  block: z.object({ position, state: z.enum(['loaded', 'unloaded']), id: z.string().optional(), properties: z.record(z.unknown()).optional() }).optional(),
  source: z.literal('client-observed'),
});
const operationSchema = z.object({
  operationId: z.string(), sessionId: z.string(), name: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'unknown']), summary: z.string(), result: z.unknown().optional(),
});
export interface Connection { protocol: 1; endpoint: string; token: string }
export function parseConnection(value: unknown): Connection {
  const parsed = z.object({ protocol: z.literal(1), endpoint: z.string(), token: z.string().min(16) }).parse(value);
  const url = new URL(parsed.endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/v1' || url.search || url.hash) {
    throw new BodyError('INVALID_ENDPOINT', '控制通道必须是本机 loopback HTTP /v1，禁止重定向和远程地址');
  }
  return parsed;
}
export async function readConnection(file: string): Promise<Connection> {
  return parseConnection(JSON.parse(await readFile(file, 'utf8')));
}
interface ClientOptions {
  connection: Connection; username: string; worldId: string;
  requestTimeoutMs?: number; heartbeatIntervalMs?: number;
  claimWaitMs?: number;
  fetch?: typeof fetch; now?: () => number; onLost?: (error: BodyError) => void;
}
/** Owns a single lease. A lost lease is terminal: callers must explicitly reconnect. */
export class ClientBody implements Body {
  hello!: BodyHello;
  private lease = '';
  private sessionId = '';
  private state: 'new' | 'active' | 'lost' | 'closed' = 'new';
  private leaseExpiresAt = 0;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatPending = false;
  private exclusive?: string;
  private pendingAction?: Promise<Operation>;
  private stopping?: Promise<{ stopped: true }>;
  private lostReason?: BodyError;
  private readonly operations = new Map<string, Operation>();
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private readonly connection: Connection;
  constructor(private readonly options: ClientOptions) {
    this.connection = parseConnection(options.connection);
    this.transport = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  static async connect(options: ClientOptions): Promise<ClientBody> {
    const body = new ClientBody(options);
    await body.connect();
    return body;
  }
  private async connect(): Promise<void> {
    this.hello = helloSchema.parse(await this.rpc('hello', {}));
    if (!this.hello.connected || !this.hello.sessionId) throw new BodyError('NOT_CONNECTED', '请先让真实客户端进入世界，再启动控制器');
    if (this.hello.username !== this.options.username) throw new BodyError('WRONG_PLAYER', '真实客户端玩家名与 --username 不匹配，拒绝接管');
    this.sessionId = this.hello.sessionId;
    const deadline = this.now() + (this.options.claimWaitMs ?? 12000);
    const controllerId = randomUUID();
    let claim;
    for (;;) {
      try {
        claim = z.object({ leaseId: z.string().min(1), ttlMs: z.number().positive() }).parse(await this.rpc('claim', {
          controllerId, username: this.options.username, worldId: this.options.worldId,
        }));
        break;
      } catch (error) {
        // Only an explicit busy refusal is safe to repeat. A timed-out claim might have succeeded.
        if (!(error instanceof BodyError) || !['LEASE_BUSY', 'BUSY'].includes(error.code) || this.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    this.lease = claim.leaseId;
    this.leaseExpiresAt = this.now() + claim.ttlMs;
    this.state = 'active';
    try { await this.observe(); } catch (error) { await this.close(); throw error; }
    this.scheduleHeartbeat();
  }
  private scheduleHeartbeat(): void {
    if (this.state !== 'active') return;
    this.heartbeatTimer = setTimeout(() => { void this.heartbeat(); }, this.options.heartbeatIntervalMs ?? 2000);
    this.heartbeatTimer.unref();
  }
  async heartbeat(): Promise<void> {
    if (this.heartbeatPending || this.state !== 'active') return;
    this.heartbeatPending = true;
    try {
      this.assertActive();
      const reply = z.object({ ttlMs: z.number().positive() }).parse(await this.rpc('heartbeat', { leaseId: this.lease }));
      if (this.state !== 'active') return;
      this.leaseExpiresAt = this.now() + reply.ttlMs;
    } catch (error) { this.lose(this.asError(error)); }
    finally { this.heartbeatPending = false; this.scheduleHeartbeat(); }
  }
  private assertActive(): void {
    if (this.state !== 'active') throw this.lostReason ?? new BodyError('LEASE_LOST', '控制租约已结束；重新查询客户端并显式重启，不得重放旧动作');
    if (this.now() >= this.leaseExpiresAt) {
      const error = new BodyError('LEASE_EXPIRED', '控制租约已过期，未发送动作');
      this.lose(error); throw error;
    }
  }
  private asError(error: unknown): BodyError {
    return error instanceof BodyError ? error : new BodyError('INVALID_RESPONSE', '客户端控制响应无效，已停止控制');
  }
  private lose(error: BodyError): void {
    if (this.state === 'lost' || this.state === 'closed') return;
    this.state = 'lost';
    this.lostReason = error;
    clearTimeout(this.heartbeatTimer);
    this.exclusive = undefined;
    // Releasing is safe and idempotent; never replay the failed mutation.
    if (this.lease) void this.rpc('release', { leaseId: this.lease }).catch(() => {});
    this.options.onLost?.(error);
  }
  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(this.connection.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 4000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.connection.token}` },
        body: JSON.stringify({ method, params }),
      });
    } catch { throw new BodyError('TRANSPORT_LOST', '客户端控制请求超时或断开；结果未知，未自动重发'); }
    if (!response.ok) throw new BodyError('HTTP_ERROR', `客户端控制请求失败（HTTP ${response.status}）`);
    let reply: unknown;
    try { reply = await response.json(); } catch { throw new BodyError('INVALID_RESPONSE', '客户端控制响应不是有效 JSON'); }
    const parsed = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), result: z.unknown() }),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
    ]).parse(reply);
    if (!parsed.ok) throw new BodyError(parsed.error.code, parsed.error.message);
    return parsed.result;
  }
  private invalidateIfNeeded(error: unknown): void {
    if (!(error instanceof BodyError) || !['BUSY', 'INVALID_ARGUMENT', 'OUT_OF_REACH', 'UNSUPPORTED', 'BLOCK_CHANGED', 'WRONG_CONTAINER', 'ITEM_CHANGED'].includes(error.code)) this.lose(this.asError(error));
  }
  async observe(block?: Position): Promise<Observation> {
    this.assertActive();
    try {
      const observed = observationSchema.parse(await this.rpc('observe', { leaseId: this.lease, ...(block ? { block } : {}) }));
      this.assertActive();
      if (!observed.connected || observed.sessionId !== this.sessionId || observed.worldId !== this.options.worldId || observed.username !== this.options.username) {
        throw new BodyError('WORLD_CHANGED', '客户端已退出或切换世界代次；旧动作已撤销，请显式重启控制');
      }
      return observed;
    } catch (error) { this.invalidateIfNeeded(error); throw this.asError(error); }
  }
  async act<N extends ActionName>(name: N, args: ActionArguments[N]): Promise<Operation> {
    this.assertActive();
    if (!this.hello.capabilities.includes(name)) throw new BodyError('UNSUPPORTED', `客户端未实现 ${name}`);
    if (this.stopping) throw new BodyError('BUSY', '正在停止，请等停止确认后发送新的明确动作');
    if (name === 'send-chat' && args && 'message' in args && (args.message.startsWith('/') || /[\r\n]/.test(args.message))) {
      throw new BodyError('INVALID_ARGUMENT', 'send-chat 只允许普通单行聊天，不接受命令');
    }
    const exclusive = name !== 'send-chat';
    if (exclusive && this.exclusive) throw new BodyError('BUSY', '已有身体动作运行；先查询 get-operation 或 stop-action');
    const operationId = randomUUID();
    if (exclusive) this.exclusive = operationId;
    const execute = async (): Promise<Operation> => {
      try {
        const op = operationSchema.parse(await this.rpc('act', { leaseId: this.lease, sessionId: this.sessionId, operationId, name, args }));
        this.assertActive();
        this.validateOperation(op, operationId, name);
        this.remember(op);
        return op;
      } catch (error) {
        const bodyError = this.asError(error);
        this.invalidateIfNeeded(error);
        if (exclusive && this.exclusive === operationId) this.exclusive = undefined;
        if (['TRANSPORT_LOST', 'HTTP_ERROR', 'INVALID_RESPONSE', 'LEASE_LOST', 'WORLD_CHANGED'].includes(bodyError.code)) {
          const unknown: Operation = { operationId, sessionId: this.sessionId, name, status: 'unknown', summary: `${bodyError.message}；不要重复执行，先核对实际世界状态` };
          this.remember(unknown); return unknown;
        }
        throw bodyError;
      }
    };
    const pending = execute();
    if (exclusive) this.pendingAction = pending;
    try { return await pending; }
    finally { if (this.pendingAction === pending) this.pendingAction = undefined; }
  }
  private validateOperation(op: Operation, id: string, name?: string): void {
    if (op.sessionId !== this.sessionId || op.operationId !== id || (name && op.name !== name)) throw new BodyError('WORLD_CHANGED', '动作回执不属于当前世界或请求，结果不可采用');
  }
  private remember(op: Operation): void {
    this.operations.set(op.operationId, op);
    if (this.operations.size > 256) {
      const terminal = [...this.operations.values()].find(item => item.status !== 'running');
      if (terminal) this.operations.delete(terminal.operationId);
    }
    if (op.status !== 'running' && this.exclusive === op.operationId) this.exclusive = undefined;
  }
  async operation(operationId: string): Promise<Operation> {
    this.assertActive();
    if (!this.operations.has(operationId)) throw new BodyError('UNKNOWN_OPERATION', '该动作不属于当前控制器；禁止用旧代次动作 ID 重发');
    try {
      const op = operationSchema.parse(await this.rpc('operation', { leaseId: this.lease, sessionId: this.sessionId, operationId }));
      this.assertActive(); this.validateOperation(op, operationId); this.remember(op); return op;
    } catch (error) { this.invalidateIfNeeded(error); throw this.asError(error); }
  }
  pendingOperations(): readonly Operation[] { return [...this.operations.values()].filter(op => op.status === 'running'); }
  stop(): Promise<{ stopped: true }> {
    if (this.stopping) return this.stopping;
    this.assertActive();
    const pending = this.pendingAction;
    const stop = async (): Promise<{ stopped: true }> => {
      try {
        const request = async () => z.object({ stopped: z.literal(true) }).parse(await this.rpc('stop', { leaseId: this.lease }));
        await request();
        if (pending) { await pending; this.assertActive(); await request(); }
        this.assertActive();
        for (const op of this.operations.values()) if (op.status === 'running') this.remember({ ...op, status: 'cancelled', summary: '用户已停止动作' });
        this.exclusive = undefined;
        return { stopped: true };
      } catch (error) { this.lose(this.asError(error)); throw this.asError(error); }
    };
    this.stopping = stop().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed'; clearTimeout(this.heartbeatTimer);
    if (this.lease) { try { await this.rpc('release', { leaseId: this.lease }); } catch { /* Client watchdog expires independently. */ } }
    this.exclusive = undefined;
  }
}
