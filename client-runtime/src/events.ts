import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Observation, Operation } from './body.js';
import { summarizeOperation } from './model-view.js';
import type { Place } from './places.js';

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
  private sleepers?: Set<string>;
  private asleep?: boolean;
  private home?: () => Place | undefined;
  private bedtimeSent = false;
  private sunsetSent = false;
  private weatherSeen?: { raining: boolean; thundering: boolean };
  private sceneDayTime?: number;
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
  /** Local terminal audit only: no model wake and no claim that a tool delivered this result. */
  recordOperation(operation: Operation): void {
    if (operation.status === 'running') return;
    this.traceOperation(operation);
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
    this.ingestSleep(observation);
    this.ingestBedtime(observation);
    this.ingestScene(observation);
  }
  /**
   * Things a person outdoors would notice and might remark on: the sun setting, rain or thunder starting. Only what the
   * body can see (sky overhead, Overworld-like dimension); each once, and the first observation is a baseline.
   */
  private ingestScene(observation: Observation): void {
    const weather = observation.weather, dayTime = observation.time?.dayTime;
    if (!weather?.natural || dayTime === undefined) { this.weatherSeen = undefined; this.sceneDayTime = undefined; return; }
    const first = this.sceneDayTime === undefined, sunset = dayTime >= 11800 && dayTime < 13000;
    this.sceneDayTime = dayTime;
    if (!sunset) this.sunsetSent = dayTime >= 13000 && dayTime < 23000;
    else if (first) this.sunsetSent = true;
    else if (!this.sunsetSent) {
      this.sunsetSent = true;
      if (weather.sky && !weather.raining && !observation.sleeping) this.add('scene', '太阳快下山了，天边红红的。想说就随口说一句；陪着玩家时可以提醒天快黑了。不用特意做什么。');
    }
    const before = this.weatherSeen;
    this.weatherSeen = { raining: weather.raining, thundering: weather.thundering };
    if (!before || !weather.sky || observation.sleeping) return;
    if (weather.thundering && !before.thundering) this.add('scene', '打雷了，雷雨天外面会刷怪。想说就随口说一句，陪着玩家时可以提醒小心。');
    else if (weather.raining && !before.raining) this.add('scene', '下雨了。想说就随口说一句，不用特意做什么。');
  }
  /** Where home is (a remembered place named home or 家), for the bedtime nudge. */
  useHome(home: () => Place | undefined): void { this.home = home; }
  /** Once per night, when beds work and the body is awake near home: wake the model so it can go to bed. */
  private ingestBedtime(observation: Observation): void {
    if (!observation.time?.canSleep) { this.bedtimeSent = false; return; }
    if (this.bedtimeSent || observation.sleeping) return;
    const home = this.home?.();
    if (!home || home.dimension !== observation.dimension) return;
    const distance = Math.hypot(home.position.x - observation.position.x, home.position.z - observation.position.z);
    if (distance > 32 || Math.abs(home.position.y - observation.position.y) > 12) return;
    this.bedtimeSent = true;
    this.add('bedtime', `天黑了，你在家附近（离「${home.name}」约 ${Math.round(distance)} 格）。可以用 sleep-in-bed 去床上睡；正陪着玩家时先说一声，或等玩家上床再一起睡。`);
  }
  /** A nearby player getting into bed, and the body getting up (morning, damage, wake-up), wake the model. */
  private ingestSleep(observation: Observation): void {
    const sleepers = new Set(observation.entities.filter(entity => entity.type === 'minecraft:player' && entity.sleeping === true && entity.name !== this.username && !this.botPlayers.includes(entity.name)).map(entity => entity.name));
    // The first observation is a baseline: someone already asleep at attachment is not news.
    if (this.sleepers) for (const name of sleepers) if (!this.sleepers.has(name)) this.add('player_sleep', `${name} 上床睡觉了。`);
    this.sleepers = sleepers;
    if (observation.sleeping === undefined) return;
    if (this.asleep === true && !observation.sleeping) this.add('woke', `${observation.username} 已起床（天亮、受伤或被叫醒）。`);
    this.asleep = observation.sleeping;
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
