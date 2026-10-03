import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BodyError, type Body, type Observation, type Operation, type GroundItem, type Components, type PickupReceipt } from './body.js';
import type { EventJournal } from './events.js';
import { GatherTasks } from './gather-tasks.js';

type Context = Pick<Observation, 'instanceId' | 'sessionId' | 'worldId' | 'dimension' | 'controlGeneration'>;
export interface PickupOptions { items: string[]; radius?: number }
export interface PickupState { items: string[]; radius: number; pickedUpCount?: number; lastConfirmedPickedUpCount?: number; lastItem?: string; code?: string; lastCode?: string; countStatus: 'confirmed' | 'partial-or-unknown'; totals: Array<{ item: string; count: number; maxStackSize: number; variant: number }> }
type PickupTracker = { state: PickupState; cursor: number; generations: Set<number>; count: number; variants: Array<{ item: string; count: number; maxStackSize: number; components: Components }>; attempted: Set<string>; pending?: { item: GroundItem; cursor: number; receipts: PickupReceipt[] } };
type Intent = { action: 'follow' | 'wait'; player?: string; expectedEntityId?: string; distance?: number; context: Context; pickup?: { items: string[]; radius: number } };
export interface CompanionState {
  state: 'idle' | 'following' | 'waiting' | 'paused' | 'blocked' | 'stopped';
  intent?: 'follow' | 'wait'; player?: string; distance?: number; operationId?: string;
  stage?: 'starting' | 'active'; code?: string; reason?: string;
  activity?: 'following' | 'picking-up' | 'switching'; pickup?: PickupState;
}
export interface CompanionRequest { action: 'follow' | 'wait' | 'pause' | 'resume'; player?: string; distance?: number; pickup?: PickupOptions; say?: string }
const terminalControl = new Set(['CANCELLED', 'WORLD_CHANGED', 'WRONG_INSTANCE', 'STALE_CONTROL', 'LEASE_LOST', 'LEASE_EXPIRED', 'TRANSPORT_LOST', 'INVALID_RESPONSE', 'STOP_UNCONFIRMED', 'HOST_LOST', 'CLOSED']);
const contextOf = (state: Context): Context => ({ instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration });

/** Owns the same Body task lock as finite tasks. Motion is maintained by the game, not a model loop. */
export class CompanionMode {
  private value: CompanionState = { state: 'idle' };
  private intent?: Intent;
  private token?: string;
  private epoch = 0;
  private observationRevision = 0;
  private changing = false;
  private stopping?: Promise<{ stopped: true }>;
  private terminal?: Operation;
  private pickup?: PickupTracker;
  private childActive = false;
  private readonly gather: GatherTasks;
  constructor(private readonly body: Body, private readonly events: EventJournal, gather?: GatherTasks) { this.gather = gather ?? new GatherTasks(body, events); }
  snapshot(): CompanionState { return structuredClone({ ...this.value, ...(this.pickup ? { pickup: this.pickupState() } : {}) }); }
  private pickupState(): PickupState | undefined {
    if (!this.pickup) return undefined;
    const { state, count, variants } = this.pickup;
    return { ...state, ...(state.countStatus === 'confirmed' ? { pickedUpCount: count } : { pickedUpCount: undefined, lastConfirmedPickedUpCount: count }), totals: variants.map(({ components: _private, ...item }, i) => ({ ...item, variant: i + 1 })) };
  }
  read(): CompanionState { if (this.terminal) this.events.deliverOperation(this.terminal); return this.snapshot(); }
  observationEpoch(): number | null { return this.changing || this.stopping ? null : this.observationRevision; }
  private publish(value: CompanionState, notify = true): void {
    this.value = value;
    if (!['blocked', 'stopped'].includes(value.state)) this.terminal = undefined;
    if (notify) this.events.add('companion_state', JSON.stringify(value), value.operationId);
  }
  private check(epoch: number): void { if (epoch !== this.epoch) throw new BodyError('CANCELLED', '陪伴指令已撤销，未恢复旧动作'); }
  private release(): void { if (this.token) this.body.releaseTask?.(this.token); this.token = undefined; }
  private acquire(): void {
    if (this.token) return;
    if (!this.body.acquireTask || !this.body.releaseTask) throw new BodyError('UNSUPPORTED', '持续陪伴需要共享任务写锁');
    const token = randomUUID(); this.body.acquireTask(token); this.token = token;
  }
  private async observe(epoch: number, expected?: Context): Promise<Observation> {
    this.check(epoch); const state = await this.body.observe(); this.check(epoch);
    if (!state.connected || state.health <= 0 || (expected && !isDeepStrictEqual(contextOf(state), expected))) throw new BodyError('WORLD_CHANGED', '陪伴身体／世界／维度／控制代次已改变；旧意图已废弃');
    return state;
  }
  private identity(state: Observation, player: string, expectedEntityId?: string): string {
    const target = state.entities.find(entity => entity.type === 'minecraft:player' && entity.name === player && entity.name !== state.username);
    if (!target) throw new BodyError('PLAYER_NOT_VISIBLE', '目标玩家不在当前附近观察中；未自动重试');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.id) || (expectedEntityId && target.id !== expectedEntityId)) throw new BodyError('STALE_TARGET', '目标玩家身份已改变；请发出新的明确跟随指令');
    return target.id;
  }
  private base(state: CompanionState['state'], stage?: CompanionState['stage']): CompanionState {
    return { state, intent: this.intent?.action, ...(this.intent?.player ? { player: this.intent.player, distance: this.intent.distance } : {}), ...(stage ? { stage } : {}) };
  }
  private initPickup(state: Observation, options?: PickupOptions): void {
    if (!options) { this.pickup = undefined; return; }
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts || !state.groundItems || state.controlGeneration === undefined) throw new BodyError('UNSUPPORTED', '持续拾取缺少原生收据／地面观察');
    this.pickup = { state: { items: [...options.items], radius: options.radius ?? 3, pickedUpCount: 0, countStatus: 'confirmed', totals: [] }, cursor: state.pickupCursor, generations: new Set([state.controlGeneration]), count: 0, variants: [], attempted: new Set() };
  }
  private ingestPickup(state: Observation): void {
    const pickup = this.pickup; if (!pickup) return;
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts) throw new BodyError('UNSUPPORTED', '持续拾取缺少原生收据');
    if (pickup.cursor < state.pickupOldestCursor || state.pickupCursor < pickup.cursor) throw new BodyError('PICKUP_GAP', '持续拾取收据历史缺口；仅保留最后确认数量');
    for (const receipt of [...state.pickupReceipts].sort((a, b) => a.seq - b.seq)) {
      if (receipt.seq <= pickup.cursor) continue;
      if (receipt.seq !== pickup.cursor + 1 || receipt.seq > state.pickupCursor || receipt.stack.count !== receipt.pickedUpCount || receipt.pickedUpCount < 1 || !Number.isSafeInteger(receipt.pickedUpCount)) throw new BodyError('PICKUP_GAP', '持续拾取收据数量或序列不完整');
      if (receipt.sessionId !== this.intent?.context.sessionId || receipt.dimension !== this.intent?.context.dimension || !pickup.generations.has(receipt.controlGeneration)) throw new BodyError('WORLD_CHANGED', '拾取收据不属于当前陪伴会话／已确认控制代次');
      pickup.cursor = receipt.seq;
      if (pickup.pending && receipt.entityId === pickup.pending.item.entityId && receipt.seq > pickup.pending.cursor) pickup.pending.receipts.push(structuredClone(receipt));
      // Item selection limits active pursuit; ordinary Minecraft collision pickup is not physically disabled.
      if (!pickup.state.items.includes(receipt.stack.id)) continue;
      if (receipt.stack.components === undefined || receipt.stack.maxStackSize === undefined) throw new BodyError('PICKUP_UNKNOWN', '拾取片段缺少实际组件或堆叠上限');
      pickup.count += receipt.pickedUpCount; pickup.state.lastItem = receipt.stack.id;
      let variant = pickup.variants.find(item => item.item === receipt.stack.id && item.maxStackSize === receipt.stack.maxStackSize && isDeepStrictEqual(item.components, receipt.stack.components));
      if (!variant) { variant = { item: receipt.stack.id, count: 0, maxStackSize: receipt.stack.maxStackSize, components: structuredClone(receipt.stack.components) }; pickup.variants.push(variant); }
      variant.count += receipt.pickedUpCount;
    }
    if (pickup.cursor !== state.pickupCursor) throw new BodyError('PICKUP_GAP', '持续拾取最新游标没有完整收据');
    // Older own generations have already been accounted for; keep only the current confirmed generation.
    if (state.controlGeneration !== undefined) pickup.generations = new Set([state.controlGeneration]);
  }
  /** The token stays owned throughout this short stop/change-generation transaction. */
  private async internalStop(epoch: number): Promise<Observation> {
    this.check(epoch); this.changing = true; this.observationRevision++;
    this.publish({ ...this.value, activity: 'switching', operationId: undefined }, false);
    try {
      await this.body.stop(); this.check(epoch);
      const state = await this.observe(epoch);
      const old = this.intent!.context, next = contextOf(state);
      if (old.instanceId !== next.instanceId || old.sessionId !== next.sessionId || old.worldId !== next.worldId || old.dimension !== next.dimension || next.controlGeneration !== (old.controlGeneration ?? -1) + 1) throw new BodyError('WORLD_CHANGED', '内部停止不属于原陪伴会话的下一控制代次');
      this.intent!.context = next;
      if (this.pickup) { this.pickup.generations.add(next.controlGeneration!); this.ingestPickup(state); }
      return state;
    } finally { this.observationRevision++; if (epoch === this.epoch) this.changing = false; }
  }
  private async say(epoch: number, message?: string): Promise<void> {
    if (!message) return;
    const sent = await this.body.act('send-chat', { message }, this.token); this.check(epoch);
    if (sent.status !== 'succeeded') throw new BodyError(sent.status === 'unknown' ? 'INVALID_RESPONSE' : 'CHAT_FAILED', sent.summary);
  }
  /** Immediate accepted result; the in-flight game action remains protected by the task token. */
  async request(request: CompanionRequest): Promise<CompanionState> {
    if (this.changing || this.stopping) throw new BodyError('BUSY', '陪伴模式正在切换或停止，请等待确认');
    if (request.action === 'follow' && (!request.player || !/^[A-Za-z0-9_]{1,16}$/.test(request.player) || (request.distance !== undefined && (!Number.isFinite(request.distance) || request.distance < 1.5 || request.distance > 6)))) throw new BodyError('INVALID_ARGUMENT', '跟随需要明确玩家；距离范围为1.5..6');
    if (request.action !== 'follow' && (request.player !== undefined || request.distance !== undefined || request.pickup !== undefined)) throw new BodyError('INVALID_ARGUMENT', '只有新的follow指令可指定玩家、距离和拾取配置');
    if (request.pickup) {
      if (!['companion-pickup', 'pickup-item'].every(cap => this.body.hello.capabilities.includes(cap))) throw new BodyError('UNSUPPORTED', '游戏端没有持续拾取玩家边界保护能力');
      const radius = request.pickup.radius ?? 3;
      if (!Array.isArray(request.pickup.items) || request.pickup.items.length < 1 || request.pickup.items.length > 8 || request.pickup.items.some(item => !/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(item)) || !Number.isFinite(radius) || radius < 1.5 || radius > 4 || (request.distance ?? 2.5) > radius) throw new BodyError('INVALID_ARGUMENT', '拾取需要1..8个明确物品ID、1.5..4半径，跟随距离不能大于拾取半径');
    }
    if ((request.action === 'resume' || request.action === 'pause') && !this.intent) throw new BodyError('NO_COMPANION_INTENT', '没有可暂停或恢复的陪伴意图；需要新的明确指令');
    if (request.action === 'resume' && !['paused', 'blocked'].includes(this.value.state)) throw new BodyError('INVALID_STATE', '只有暂停或受阻的陪伴可显式恢复');
    if (request.action === 'pause' && this.value.state === 'paused') { await this.say(this.epoch, request.say); return this.snapshot(); }
    this.changing = true;
    const epoch = ++this.epoch;
    this.observationRevision++;
    let acquired = false;
    try {
      // Acquire before any awaits; this serializes with finite task and atomic action starts.
      this.acquire(); acquired = true;
      if (this.childActive) { this.gather.cancel(); this.childActive = false; }
      if (this.intent && request.action !== 'resume') {
        await this.body.stop(); this.check(epoch);
        this.gather.stopped();
        if (request.action === 'follow' || request.action === 'wait') this.intent = undefined;
      }
      const initial = await this.observe(epoch, request.action === 'resume' ? this.intent!.context : undefined);
      if (request.action === 'pause') {
        this.intent!.context = contextOf(initial);
        if (this.pickup) { this.pickup.generations.add(initial.controlGeneration!); this.ingestPickup(initial); }
        await this.say(epoch, request.say); this.release();
        this.publish(this.base('paused')); return this.snapshot();
      }
      if (request.action === 'follow') {
        this.intent = { action: 'follow', player: request.player!, expectedEntityId: this.identity(initial, request.player!), distance: request.distance ?? 2.5, context: contextOf(initial), ...(request.pickup ? { pickup: { items: [...request.pickup.items], radius: request.pickup.radius ?? 3 } } : {}) };
        this.initPickup(initial, request.pickup);
      } else if (request.action === 'wait') { this.intent = { action: 'wait', context: contextOf(initial) }; this.pickup = undefined; }
      else if (this.intent!.action === 'follow') {
        this.identity(initial, this.intent!.player!, this.intent!.expectedEntityId);
        if (this.pickup) { this.pickup.cursor = initial.pickupCursor!; this.pickup.generations = new Set([initial.controlGeneration!]); this.pickup.attempted.clear(); this.pickup.state.code = undefined; }
      }
      if (initial.container) throw new BodyError('BUSY', '请先关闭当前菜单，再开始陪伴');
      await this.say(epoch, request.say);
      const intent = this.intent!, token = this.token!;
      if (intent.action === 'wait') { this.publish(this.base('waiting', 'active')); return this.snapshot(); }
      this.publish(this.base('following', 'starting'));
      void this.start(epoch, token, intent);
      return this.snapshot();
    } catch (error) {
      if (acquired && epoch === this.epoch) this.fail(error as Error);
      throw error;
    } finally { this.changing = false; }
  }
  private async start(epoch: number, token: string, intent: Intent): Promise<void> {
    try {
      // Reobserve after chat/setup, not a stale target from the beginning of a request.
      const state = await this.observe(epoch, intent.context); this.identity(state, intent.player!, intent.expectedEntityId); this.check(epoch);
      const op = await this.body.act('follow-companion', { player: intent.player!, expectedEntityId: intent.expectedEntityId!, distance: intent.distance }, token);
      this.check(epoch); this.accept(op, intent);
    } catch (error) { if (epoch === this.epoch) this.fail(error as Error); }
  }
  private accept(op: Operation, intent: Intent): void {
    if (op.sessionId !== intent.context.sessionId || op.controlGeneration !== intent.context.controlGeneration || op.name !== 'follow-companion') throw new BodyError('WORLD_CHANGED', '陪伴回执不属于当前会话和代次');
    if (op.status !== 'running') {
      const code = (op.result as { code?: string } | undefined)?.code;
      this.fail(new BodyError(op.status === 'unknown' ? 'INVALID_RESPONSE' : op.status === 'cancelled' ? 'CANCELLED' : code ?? 'FOLLOW_FAILED', op.summary), op); return;
    }
    const result = op.result as { state?: string; player?: string; expectedEntityId?: string; distance?: number } | undefined;
    if (!result || !['following', 'waiting'].includes(result.state ?? '') || result.player !== intent.player || result.expectedEntityId !== intent.expectedEntityId || result.distance !== intent.distance) throw new BodyError('INVALID_RESPONSE', '持续跟随回执缺少完整状态或目标身份');
    this.publish({ ...this.base(result.state as 'following' | 'waiting', 'active'), ...(this.pickup ? { activity: 'following' as const } : {}), operationId: op.operationId }, false);
  }
  /** RuntimeMonitor refreshes state in the background; near/far transitions never wake the model. */
  async update(state: Observation, observedEpoch: number | null = this.observationRevision): Promise<void> {
    if (observedEpoch !== this.observationRevision || this.changing || this.stopping || !this.intent) return;
    const epoch = this.epoch, intent = this.intent, id = this.value.operationId;
    try {
      if (!state.connected || state.health <= 0 || !isDeepStrictEqual(contextOf(state), intent.context)) throw new BodyError('WORLD_CHANGED', '陪伴会话或控制代次改变；旧意图已废弃');
      if (this.pickup && !['paused', 'blocked'].includes(this.value.state)) this.ingestPickup(state);
      if (this.childActive) return;
      if (!id || !['following', 'waiting'].includes(this.value.state)) return;
      const op = await this.body.operation(id); this.check(epoch);
      if (observedEpoch !== this.observationRevision || this.changing || this.stopping || this.childActive) return;
      this.accept(op, intent);
      if (this.pickup && this.value.state === 'waiting' && this.value.stage === 'active') {
        const target = state.entities.find(entity => entity.id === intent.expectedEntityId && entity.name === intent.player && entity.type === 'minecraft:player');
        if (!target) throw new BodyError('STALE_COMPANION', '陪伴玩家身份或在线状态改变');
        const radius = this.pickup.state.radius;
        if (Math.hypot(state.position.x - target.position.x, state.position.y - target.position.y, state.position.z - target.position.z) > radius) return;
        const item = state.groundItems?.find(item => this.pickup!.state.items.includes(item.stack.id) && item.visibility === 'visible' && !this.pickup!.attempted.has(item.entityId) && Math.hypot(item.position.x - target.position.x, item.position.y - target.position.y, item.position.z - target.position.z) <= radius);
        if (item) { this.pickup.attempted.add(item.entityId); this.pickup.pending = { item: structuredClone(item), cursor: this.pickup.cursor, receipts: [] }; this.childActive = true; void this.pickupItem(epoch, structuredClone(item)); }
      }
    } catch (error) { if (epoch === this.epoch && observedEpoch === this.observationRevision) { if (this.pickup) await this.block(error as Error, epoch); else this.fail(error as Error); } }
  }
  private async pickupItem(epoch: number, item: GroundItem): Promise<void> {
    let child: Operation | undefined;
    try {
      const state = await this.internalStop(epoch); this.check(epoch);
      this.identity(state, this.intent!.player!, this.intent!.expectedEntityId);
      const target = state.entities.find(entity => entity.id === this.intent!.expectedEntityId)!;
      const radius = this.pickup!.state.radius;
      this.publish({ ...this.base('waiting', 'active'), activity: 'picking-up' }, false);
      child = await this.gather.collectCompanionItem(item, { taskToken: this.token!, context: this.intent!.context, entityId: item.entityId, source: item, center: target.position, companionGuard: { player: this.intent!.player!, expectedEntityId: this.intent!.expectedEntityId!, maxDistance: radius }, check: () => this.check(epoch), priorPicked: snapshot => {
        this.check(epoch); this.ingestPickup(snapshot);
        const pending = this.pickup!.pending!;
        if (pending.cursor < snapshot.pickupOldestCursor!) throw new BodyError('PICKUP_GAP', '选定UUID的收据窗口已缺失');
        for (const receipt of pending.receipts) {
          if (receipt.stack.id !== item.stack.id || !isDeepStrictEqual(receipt.stack.components, item.stack.components)) throw new BodyError('VARIANT_CHANGED', '选定UUID自然收取时组件变体已改变');
          if (receipt.stack.maxStackSize !== item.stack.maxStackSize) throw new BodyError('MAX_STACK_CHANGED', '选定UUID自然收取时有效上限已改变');
        }
        return pending.receipts.reduce((sum, receipt) => sum + receipt.pickedUpCount, 0);
      } });
      this.check(epoch);
      const latest = await this.observe(epoch, this.intent!.context); this.ingestPickup(latest);
      if (child.status !== 'succeeded') {
        const code = (child.result as { code?: string } | undefined)?.code ?? (child.status === 'unknown' ? 'UNKNOWN' : 'STEP_FAILED');
        if (!['COMPANION_OUT_OF_RANGE', 'TARGET_CONSUMED'].includes(code) || child.status === 'unknown') throw new BodyError(code, child.summary);
        this.identity(latest, this.intent!.player!, this.intent!.expectedEntityId);
        this.pickup!.state.lastCode = code;
      }
      await this.internalStop(epoch); this.check(epoch);
      this.pickup!.pending = undefined;
      this.childActive = false;
      this.publish({ ...this.base('following', 'starting'), activity: 'following' }, false);
      await this.start(epoch, this.token!, this.intent!);
    } catch (error) { if (epoch === this.epoch) await this.block(error as Error, epoch, child); }
  }
  /** A scheduling failure may happen while follow/child is still running: stop before unlocking. */
  private async block(error: Error, epoch: number, operation?: Operation): Promise<void> {
    if (epoch !== this.epoch) return;
    this.childActive = false; this.gather.cancel();
    const blockedEpoch = ++this.epoch; this.changing = true; this.observationRevision++;
    try {
      await this.body.stop(); this.check(blockedEpoch); this.gather.stopped();
      const state = await this.observe(blockedEpoch);
      if (this.intent) {
        const old = this.intent.context, next = contextOf(state);
        if (old.instanceId !== next.instanceId || old.sessionId !== next.sessionId || old.worldId !== next.worldId || old.dimension !== next.dimension || next.controlGeneration !== (old.controlGeneration ?? -1) + 1) throw new BodyError('WORLD_CHANGED', '阻断收尾不能采用外部会话／控制代次');
        this.intent.context = next;
      }
      if (this.pickup) { this.pickup.generations.add(state.controlGeneration!); try { this.ingestPickup(state); } catch { this.pickup.state.countStatus = 'partial-or-unknown'; } }
      this.fail(error, operation);
    } catch (stopError) { if (blockedEpoch === this.epoch) this.fail(stopError as Error, undefined, true); }
    finally { this.observationRevision++; this.changing = false; }
  }
  /** Lease/process loss is terminal; no persisted or automatic resume. */
  fail(error: Error, operation?: Operation, controlLost = false): void {
    const code = error instanceof BodyError ? error.code : 'INVALID_RESPONSE';
    if (['idle', 'stopped'].includes(this.value.state) && !this.intent && !this.token) return;
    ++this.epoch;
    this.observationRevision++;
    if (this.childActive) { this.gather.cancel(); this.childActive = false; }
    if (this.pickup) {
      this.pickup.state.code = code;
      if (['PICKUP_GAP', 'PICKUP_UNKNOWN', 'UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'LEASE_EXPIRED', 'INVALID_RESPONSE', 'TRANSPORT_LOST'].includes(code)) this.pickup.state.countStatus = 'partial-or-unknown';
    }
    const terminal = controlLost || terminalControl.has(code);
    if (terminal) this.intent = undefined;
    this.release(); this.terminal = operation;
    this.publish({ ...this.base(terminal ? 'stopped' : 'blocked'), ...(operation ? { operationId: operation.operationId } : {}), code, reason: error.message }, false);
    const failureState = this.snapshot();
    if (operation) this.events.notifyCompanionOperation(operation, failureState);
    else this.events.add('companion', JSON.stringify(failureState));
    // An untrusted running receipt or lost context cannot leave an unowned movement behind.
    if (terminal) { this.pickup = undefined; void this.body.close().catch(() => {}); }
  }
  /** Explicit stop clears intent synchronously and keeps the lock until in-flight work is fenced. */
  stop(): Promise<{ stopped: true }> {
    if (this.stopping) return this.stopping;
    ++this.epoch; this.intent = undefined;
    this.observationRevision++;
    if (this.childActive) { this.gather.cancel(); this.childActive = false; }
    this.terminal = undefined;
    this.pickup = undefined;
    if (this.value.state !== 'idle' && this.value.state !== 'stopped') this.publish({ state: 'stopped' });
    this.stopping = (async () => {
      try { const result = await this.body.stop(); this.gather.stopped(); return result; }
      finally { this.release(); }
    })().finally(() => { this.stopping = undefined; this.changing = false; this.observationRevision++; });
    return this.stopping;
  }
}
