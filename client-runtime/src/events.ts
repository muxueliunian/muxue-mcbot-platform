import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Observation, Operation } from './body.js';
import { summarizeOperation } from './model-view.js';

export interface GameEvent { session: string; seq: number; timestamp: number; type: string; text: string; operationId?: string }
/** Companion-compatible journal; each runtime process has its own cursor generation. */
export class EventJournal {
  readonly session = randomUUID();
  private seq = 0;
  private chatCursor?: number;
  private gameSession?: string;
  private records: GameEvent[] = [];
  private waiters = new Set<() => void>();
  private logFile?: string;
  private cursorFile?: string;
  private consumedFile?: string;
  private taskDeliveredFile?: string;
  private operationTraceFile?: string;
  private deliveredOperations = new Set<string>();
  private notifiedOperations = new Set<string>();
  private tracedOperations = new Set<string>();
  constructor(runtimeDir?: string, private readonly username?: string, private readonly botPlayers: string[] = [], private readonly attachmentChatCursor?: number) {
    if (!runtimeDir || !username) return;
    fs.mkdirSync(runtimeDir, { recursive: true });
    this.logFile = path.join(runtimeDir, `events-${username}.jsonl`);
    this.cursorFile = path.join(runtimeDir, `cursor-${username}.txt`);
    this.consumedFile = path.join(runtimeDir, `consumed-${username}.txt`);
    this.taskDeliveredFile = path.join(runtimeDir, `task-delivered-${username}.json`);
    this.operationTraceFile = path.join(runtimeDir, `operations-${username}.jsonl`);
    fs.writeFileSync(this.logFile, '');
    fs.writeFileSync(this.cursorFile, '');
    fs.writeFileSync(this.consumedFile, '');
    this.writeTaskReceipts();
  }
  add(type: string, text: string, operationId?: string): GameEvent {
    const record = { session: this.session, seq: ++this.seq, timestamp: Date.now(), type, text, ...(operationId ? { operationId } : {}) };
    this.records.push(record);
    if (this.records.length > 200) this.records.shift();
    if (this.logFile) fs.appendFileSync(this.logFile, JSON.stringify(record) + '\n');
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return record;
  }
  private remember(set: Set<string>, id: string): void {
    set.add(id);
    if (set.size > 512) set.delete(set.values().next().value!);
  }
  private writeTaskReceipts(): void {
    if (!this.taskDeliveredFile) return;
    const temporary = `${this.taskDeliveredFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ session: this.session, operationIds: [...this.deliveredOperations] }));
    fs.renameSync(temporary, this.taskDeliveredFile);
  }
  /** A synchronous tool result delivered this terminal result, not unrelated chat. */
  deliverOperation(operation: Operation): void {
    if (operation.status === 'running') return;
    this.traceOperation(operation);
    this.remember(this.deliveredOperations, operation.operationId);
    this.writeTaskReceipts();
  }
  private traceOperation(operation: Operation): void {
    if (this.tracedOperations.has(operation.operationId)) return;
    this.remember(this.tracedOperations, operation.operationId);
    if (this.operationTraceFile) {
      if (fs.existsSync(this.operationTraceFile) && fs.statSync(this.operationTraceFile).size > 5_000_000) {
        fs.renameSync(this.operationTraceFile, `${this.operationTraceFile}.previous`);
      }
      fs.appendFileSync(this.operationTraceFile, JSON.stringify({ session: this.session, timestamp: Date.now(), operation }) + '\n');
    }
  }
  notifyOperation(operation: Operation, compact = true): void {
    if (operation.status === 'running' || this.notifiedOperations.has(operation.operationId)) return;
    this.remember(this.notifiedOperations, operation.operationId);
    this.traceOperation(operation);
    if (this.deliveredOperations.has(operation.operationId)) return;
    this.add('task', JSON.stringify(compact ? summarizeOperation(operation) : operation), operation.operationId);
  }
  notifyCompanionOperation(operation: Operation, state: object): void {
    if (operation.status === 'running' || this.notifiedOperations.has(operation.operationId)) return;
    this.remember(this.notifiedOperations, operation.operationId);
    this.traceOperation(operation);
    if (this.deliveredOperations.has(operation.operationId)) return;
    this.add('companion', JSON.stringify(state), operation.operationId);
  }
  ingest(observation: Observation): void {
    if (this.gameSession !== observation.sessionId) {
      this.gameSession = observation.sessionId;
      // Pre-attachment chat is observation, not a new command to replay.
      this.chatCursor = this.attachmentChatCursor ?? observation.chatCursor;
      const body = observation.source === 'server-observed' ? '服务端角色' : '真实客户端';
      this.add('spawn', `已接管${body} ${observation.username}，维度 ${observation.dimension}；请查询当前状态，不要重放接管前聊天。`);
      if (this.attachmentChatCursor === undefined) return;
    }
    for (const chat of observation.chat) {
      if (chat.seq <= (this.chatCursor ?? 0)) continue;
      this.chatCursor = Math.max(this.chatCursor ?? 0, chat.seq);
      if (chat.username && (chat.username === this.username || this.botPlayers.includes(chat.username))) continue;
      // Unknown plugin/system chat retains its text, but cannot become an authenticated player command.
      this.add(chat.username ? 'chat' : 'system_chat', chat.username ? `${chat.username}: ${chat.message}` : chat.message);
    }
    this.chatCursor = Math.max(this.chatCursor ?? 0, observation.chatCursor);
  }
  latestSeq(): number { return this.seq; }
  deliveredSeq(): number {
    if (!this.cursorFile) return 0;
    try {
      const [session, seq] = fs.readFileSync(this.cursorFile, 'utf8').trim().split(/\s+/);
      return session === this.session ? Number(seq) || 0 : 0;
    } catch { return 0; }
  }
  markConsumed(seq: number): void {
    if (this.consumedFile) fs.writeFileSync(this.consumedFile, `${this.session} ${seq}`);
  }
  since(cursor: number, types?: string[]): GameEvent[] {
    return this.records.filter(event => event.seq > cursor && (!types || types.includes(event.type))
      && !(['task', 'companion'].includes(event.type) && event.operationId && this.deliveredOperations.has(event.operationId)));
  }
  async wait(cursor: number, timeoutMs: number, types?: string[]): Promise<GameEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (!this.since(cursor, types).length && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.waiters.delete(finish); resolve(); };
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
        this.waiters.add(finish);
      });
    }
    return this.since(cursor, types);
  }
}
