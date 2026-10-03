// 游戏事件队列：记录聊天、受伤、玩家进出、昼夜变化等，供 wait-for-events 工具按游标读取
// 同时把事件写到 runtime/events-<用户名>.jsonl，供 scripts/companion.mjs 驱动器监听
import fs from 'node:fs';
import path from 'node:path';

export interface GameEvent {
  seq: number;
  timestamp: number;
  type: string;
  text: string;
}

const MAX_EVENTS = 200;

export class EventStore {
  private events: GameEvent[] = [];
  private seq = 0;
  private waiters: Array<() => void> = [];
  private listeners: Array<(event: GameEvent) => void> = [];
  // 每次进程启动都不同，驱动器据此判断 seq 是否重新从 0 开始
  readonly session = `${Date.now()}-${process.pid}`;
  private logFile: string | null = null;
  private cursorFile: string | null = null;
  private consumedFile: string | null = null;

  constructor(runtimeDir?: string, username?: string) {
    if (!runtimeDir || !username) return;
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      this.logFile = path.join(runtimeDir, `events-${username}.jsonl`);
      this.cursorFile = path.join(runtimeDir, `cursor-${username}.txt`);
      this.consumedFile = path.join(runtimeDir, `consumed-${username}.txt`);
      fs.writeFileSync(this.logFile, '');
      fs.writeFileSync(this.cursorFile, '');
      fs.writeFileSync(this.consumedFile, '');
    } catch {
      this.logFile = null;
      this.cursorFile = null;
      this.consumedFile = null;
    }
  }

  add(type: string, text: string): void {
    this.seq += 1;
    const event = { seq: this.seq, timestamp: Date.now(), type, text };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, JSON.stringify({ session: this.session, ...event }) + '\n');
      } catch {
        // 写日志失败不影响游戏
      }
    }
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // 监听方出错不影响游戏
      }
    }
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  // 每个新事件都通知 fn（记忆日志用）
  onAdd(fn: (event: GameEvent) => void): void {
    this.listeners.push(fn);
  }

  latestSeq(): number {
    return this.seq;
  }

  // 驱动器已经把这些事件直接发给了 agent，读取它记录的位置，避免 wait-for-events 重复返回
  deliveredSeq(): number {
    if (!this.cursorFile) return 0;
    try {
      const [session, seq] = fs.readFileSync(this.cursorFile, 'utf8').trim().split(/\s+/);
      return session === this.session ? Number(seq) || 0 : 0;
    } catch {
      return 0;
    }
  }

  // wait-for-events 已经把这些事件交给 agent，驱动器据此不再重复发送
  markConsumed(seq: number): void {
    if (!this.consumedFile) return;
    try {
      fs.writeFileSync(this.consumedFile, `${this.session} ${seq}`);
    } catch {
      // 忽略
    }
  }

  since(cursor: number, types?: string[]): GameEvent[] {
    return this.events.filter((e) => e.seq > cursor && (!types || types.includes(e.type)));
  }

  // 等到有新事件或超时
  async waitForNew(cursor: number, timeoutMs: number, types?: string[]): Promise<GameEvent[]> {
    const deadline = Date.now() + timeoutMs;
    let found = this.since(cursor, types);
    while (found.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      found = this.since(cursor, types);
    }
    return found;
  }
}
