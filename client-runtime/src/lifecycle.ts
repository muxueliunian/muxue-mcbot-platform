import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BodyError, type Body } from './body.js';
import { EventJournal } from './events.js';
import type { CompanionMode } from './companion-mode.js';
import type { SurvivalReflexes } from './survival-reflexes.js';

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function acquireRuntimeLock(runtimeDir: string, username: string): () => void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, `client-body-${username}.lock`);
  const value = JSON.stringify({ pid: process.pid, id: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, value, { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8') === value) fs.unlinkSync(file); } catch {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = fs.readFileSync(file, 'utf8');
      let holder: { pid: number };
      try { holder = JSON.parse(previous); } catch { throw new BodyError('LOCKED', '控制锁格式无效；请确认没有控制器运行后手动处理'); }
      if (!Number.isSafeInteger(holder.pid) || pidAlive(holder.pid)) throw new BodyError('LOCKED', '同一玩家已有本机 Body 控制器');
      if (fs.readFileSync(file, 'utf8') === previous) fs.unlinkSync(file);
    }
  }
  throw new BodyError('LOCKED', '无法取得身体控制锁');
}
export function hostedHeartbeatFresh(file: string, now = Date.now(), alive = pidAlive): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; updatedAt: number };
    return Number.isFinite(value.updatedAt) && Math.abs(now - value.updatedAt) <= 60_000 && alive(value.pid);
  } catch { return false; }
}
export class RuntimeMonitor {
  private timer?: ReturnType<typeof setTimeout>;
  private senseTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly body: Body, private readonly events: EventJournal, private readonly options: {
    intervalMs?: number; heartbeatFile?: string; heartbeatFresh?: () => boolean; companion?: CompanionMode; reflexes?: SurvivalReflexes; onFatal: (error: Error) => void;
  }) {}
  start(): void { this.schedule(); this.scheduleSense(); }
  private scheduleSense(): void {
    if (this.closed || !this.options.reflexes) return;
    this.senseTimer = setTimeout(() => { void this.sense(); }, this.options.intervalMs ?? 500);
    this.senseTimer.unref();
  }
  /** Compact survival sampling has its own schedule; slow ordinary observe/poll cannot starve it. */
  private async sense(): Promise<void> {
    if (this.closed) return;
    try {
      const alive = this.options.heartbeatFresh?.() ?? (!this.options.heartbeatFile || hostedHeartbeatFresh(this.options.heartbeatFile));
      if (!alive) throw new BodyError('HOST_LOST', '托管驱动心跳已过期，已释放身体控制权');
      await this.options.reflexes?.tick();
    } catch (error) { await this.fail(error as Error); }
    finally { this.scheduleSense(); }
  }
  private async fail(error: Error): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.senseTimer);
    this.options.reflexes?.disarm('runtime-lost'); this.options.companion?.fail(error, undefined, true);
    this.events.add('disconnect', error.message); await this.body.close(); this.options.onFatal(error);
  }
  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => { void this.tick(); }, this.options.intervalMs ?? 500);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.closed) return;
    try {
      const alive = this.options.heartbeatFresh?.() ?? (!this.options.heartbeatFile || hostedHeartbeatFresh(this.options.heartbeatFile));
      if (!alive) throw new BodyError('HOST_LOST', '托管驱动心跳已过期，已释放身体控制权');
      await this.options.reflexes?.tick();
      const companionEpoch = this.options.companion?.observationEpoch();
      // A mode transition has no stable body generation. Defer chat/state to the next tick.
      if (companionEpoch === null) return;
      const observation = await this.body.observe();
      if (this.closed) return;
      this.events.ingest(observation);
      await this.options.companion?.update(observation, companionEpoch);
      for (const pending of this.body.pendingOperations()) {
        const operation = await this.body.operation(pending.operationId);
        if (operation.status !== 'running') this.events.notifyOperation(operation, this.body.hello.backend === 'server');
      }
    } catch (error) {
      await this.fail(error as Error);
    } finally { this.schedule(); }
  }
  stop(): void { this.closed = true; clearTimeout(this.timer); clearTimeout(this.senseTimer); this.options.reflexes?.disarm('runtime-stopped'); }
}
