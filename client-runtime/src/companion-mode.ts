import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BodyError, type Body, type Observation, type Operation, type GroundItem, type Components, type PickupReceipt, type GuardOptions } from './body.js';
import type { EventJournal } from './events.js';
import { GatherTasks, type BorrowedMining } from './gather-tasks.js';

type Context = Pick<Observation, 'instanceId' | 'sessionId' | 'worldId' | 'dimension' | 'controlGeneration'>;
export interface PickupOptions { items: string[]; radius?: number }
export interface PickupState { items: string[]; radius: number; pickedUpCount?: number; lastConfirmedPickedUpCount?: number; lastItem?: string; code?: string; lastCode?: string; countStatus: 'confirmed' | 'partial-or-unknown'; totals: Array<{ item: string; count: number; maxStackSize: number; variant: number; storedIn?: string }> }
export interface MiningOptions { blockIds: string[]; maxBlocks: number; radius?: number; durationMs?: number }
export interface MiningState { blockIds: string[]; maxBlocks: number; radius: number; durationMs: number; deadline: number; attemptedBlocks: number; remainingBlocks: number; minedBlocks: number; active: boolean; disabledReason?: string; lastCode?: string; countStatus: 'confirmed' | 'partial-or-unknown'; dropAttribution: 'unconfirmed'; newPickedByItem: Array<{ item: string; count: number; maxStackSize: number; variant: number; storedIn?: string }> }
type MiningTracker = { state: MiningState; lastScanAt: number; attempted: Set<string>; cursor: number; generations: Set<number>; variants: Array<{ item: string; count: number; maxStackSize: number; components: Components; storedIn?: string }>; child?: symbol; childMined: number };
// Ores by block ID or tag (#c:ores, modded too); the body scans only ores whatever else is named.
const miningSelector = /^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/;
type PickupTracker = { state: PickupState; cursor: number; generations: Set<number>; count: number; variants: Array<{ item: string; count: number; maxStackSize: number; components: Components; storedIn?: string }>; attempted: Set<string>; pending?: { item: GroundItem; cursor: number; receipts: PickupReceipt[] } };
type Intent = { action: 'follow' | 'wait'; player?: string; expectedEntityId?: string; distance?: number; wander?: boolean; guard?: GuardOptions; context: Context; pickup?: { items: string[]; radius: number } };
/** What the server's guard reports inside the running follow result. */
export interface GuardState { state: string; target?: string; targetId?: string; hits: number; kills: number; shots: number; retreats: number; damage: number }
export interface CompanionState {
  state: 'idle' | 'following' | 'waiting' | 'paused' | 'blocked' | 'stopped';
  intent?: 'follow' | 'wait'; player?: string; distance?: number; operationId?: string;
  stage?: 'starting' | 'active'; code?: string; reason?: string;
  activity?: 'following' | 'picking-up' | 'mining' | 'switching'; pickup?: PickupState; mining?: MiningState;
  guard?: GuardState;
  /** Follow only: whether the guard is switched on in the intent (the server reports its fight state in guard while a follow runs). */
  guardEnabled?: boolean;
  /** Set while the follow/wait steps aside for a tool or reflex (state stays paused): the name of what is using the body. It is picked up again by itself. */
  suspendedFor?: string;
}
/** Held while a tool or reflex uses the body; release lets the follow/wait pick up again once nothing else is running, hold keeps it paused for good (until resume). */
export interface YieldLease { release(): Promise<void>; hold(): void }
export interface CompanionRequest { action: 'follow' | 'wait' | 'pause' | 'resume' | 'stop' | 'guard'; player?: string; distance?: number; wander?: boolean; guard?: GuardOptions | boolean; pickup?: PickupOptions; mining?: MiningOptions; say?: string }
const terminalControl = new Set(['CANCELLED', 'WORLD_CHANGED', 'WRONG_INSTANCE', 'STALE_CONTROL', 'LEASE_LOST', 'LEASE_EXPIRED', 'TRANSPORT_LOST', 'INVALID_RESPONSE', 'STOP_UNCONFIRMED', 'HOST_LOST', 'CLOSED']);
const contextOf = (state: Context): Context => ({ instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration });

/** Owns the same Body task lock as finite tasks. Motion is maintained by the game, not a model loop. */
export class CompanionMode {
  private value: CompanionState = { state: 'idle' };
  private intent?: Intent;
  private token?: string;
  private epoch = 0;
  private observationRevision = 0;
  private changing?: symbol;
  private stopping?: Promise<{ stopped: true }>;
  private stopUnconfirmed = false;
  private terminal?: Operation;
  private pickup?: PickupTracker;
  private mining?: MiningTracker;
  private childActive = false;
  private readonly gather: GatherTasks;
  /** Guard used by follow when the request does not say: the runtime's setting (on by default), false turns it off. */
  guardDefaults: GuardOptions | false = {};
  private lastGuard?: GuardState;
  private fight?: { kills: number; targets: Set<string> };
  private fightNotedAt = -Infinity;
  private suspendedFor?: string;
  private awaitingPlayer = false;
  private resuming = false;
  private idleSince?: number;
  private resumeTimer?: ReturnType<typeof setTimeout>;
  /** The body must have been idle this long before a follow that stepped aside picks up again, so quick back-to-back tool calls do not make it walk off in between. */
  // 模型连着调工具时两次调用之间常隔两三秒，太短会在中间接上跟随、把身体带走
  resumeDelayMs = 3000;
  private readonly leases = new Set<symbol>();
  /** True while finite work outside the body's own bookkeeping (container, gather, survival tasks) is running; set by the MCP layer. */
  busyProbe?: () => boolean;
  constructor(private readonly body: Body, private readonly events: EventJournal, gather?: GatherTasks, private readonly now = Date.now) { this.gather = gather ?? new GatherTasks(body, events, now); }
  snapshot(): CompanionState { return structuredClone({ ...this.value, ...(this.pickup ? { pickup: this.pickupState() } : {}), ...(this.mining ? { mining: this.miningState() } : {}) }); }
  private miningState(): MiningState {
    const mining = this.mining!;
    return { ...mining.state, remainingBlocks: Math.max(0, mining.state.maxBlocks - mining.state.attemptedBlocks), newPickedByItem: mining.variants.map(({ components: _private, ...item }, index) => ({ ...item, variant: index + 1 })) };
  }
  private initMining(state: Observation, options?: MiningOptions): void {
    if (!options) { this.mining = undefined; return; }
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts || !state.groundItems || state.controlGeneration === undefined) throw new BodyError('UNSUPPORTED', '持续陪挖缺少原生收据／地面观察');
    const durationMs = options.durationMs ?? 300000;
    this.mining = { state: { blockIds: [...options.blockIds], maxBlocks: options.maxBlocks, radius: options.radius ?? 4, durationMs, deadline: this.now() + durationMs, attemptedBlocks: 0, remainingBlocks: options.maxBlocks, minedBlocks: 0, active: true, countStatus: 'confirmed', dropAttribution: 'unconfirmed', newPickedByItem: [] }, lastScanAt: -Infinity, attempted: new Set(), cursor: state.pickupCursor, generations: new Set([state.controlGeneration]), variants: [], childMined: 0 };
  }
  private ingestMining(state: Observation): void {
    const mining = this.mining; if (!mining) return;
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts || mining.cursor < state.pickupOldestCursor || state.pickupCursor < mining.cursor) throw new BodyError('PICKUP_GAP', '陪挖拾取收据出现历史缺口；只保留最后确认数量');
    for (const receipt of [...state.pickupReceipts].sort((a, b) => a.seq - b.seq)) {
      if (receipt.seq <= mining.cursor) continue;
      if (receipt.seq !== mining.cursor + 1 || receipt.seq > state.pickupCursor || receipt.stack.count !== receipt.pickedUpCount || !Number.isSafeInteger(receipt.pickedUpCount) || receipt.pickedUpCount < 1) throw new BodyError('PICKUP_GAP', '陪挖收据序列或实际数量不完整');
      if (receipt.sessionId !== this.intent?.context.sessionId || receipt.dimension !== this.intent?.context.dimension || !mining.generations.has(receipt.controlGeneration)) throw new BodyError('WORLD_CHANGED', '陪挖收据不属于当前模式及已确认代次');
      if (receipt.stack.components === undefined || receipt.stack.maxStackSize === undefined) throw new BodyError('PICKUP_UNKNOWN', '陪挖收据缺少实际组件或上限');
      let variant = mining.variants.find(item => item.item === receipt.stack.id && item.maxStackSize === receipt.stack.maxStackSize && item.storedIn === receipt.storedIn && isDeepStrictEqual(item.components, receipt.stack.components));
      if (!variant) { if (mining.variants.length >= 64) throw new BodyError('PICKUP_UNKNOWN', '陪挖实际拾取变体账本超过有限上限'); variant = { item: receipt.stack.id, count: 0, maxStackSize: receipt.stack.maxStackSize, components: structuredClone(receipt.stack.components), ...(receipt.storedIn ? { storedIn: receipt.storedIn } : {}) }; mining.variants.push(variant); }
      variant.count += receipt.pickedUpCount; mining.cursor = receipt.seq;
    }
    if (mining.cursor !== state.pickupCursor) throw new BodyError('PICKUP_GAP', '陪挖最新游标缺少完整收据');
    if (state.controlGeneration !== undefined) mining.generations = new Set([state.controlGeneration]);
  }
  private disableMining(reason: string): void {
    if (!this.mining?.state.active) return;
    this.mining.state.active = false; this.mining.state.disabledReason = reason;
    this.events.add('companion', JSON.stringify({ ...this.base(this.value.state), mining: this.miningState(), reason: '陪挖预算已到，仅关闭采矿并保留原跟随；恢复不会补充预算' }));
  }
  private pickupState(): PickupState | undefined {
    if (!this.pickup) return undefined;
    const { state, count, variants } = this.pickup;
    return { ...state, ...(state.countStatus === 'confirmed' ? { pickedUpCount: count } : { pickedUpCount: undefined, lastConfirmedPickedUpCount: count }), totals: variants.map(({ components: _private, ...item }, i) => ({ ...item, variant: i + 1 })) };
  }
  read(): CompanionState { if (this.terminal) this.events.deliverOperation(this.terminal); return this.snapshot(); }
  observationEpoch(): number | null { return this.changing || this.stopping ? null : this.observationRevision; }
  private beginChange(): symbol {
    const owner = Symbol(); this.changing = owner; this.observationRevision++; return owner;
  }
  private finishChange(owner: symbol): void {
    // fail() advances the cancellation epoch too; cleanup belongs to the transition, not that epoch.
    if (this.changing !== owner) return;
    this.changing = undefined; this.observationRevision++;
  }
  private publish(value: CompanionState, notify = true): void {
    this.value = value;
    if (!['blocked', 'stopped'].includes(value.state)) this.terminal = undefined;
    if (notify) this.events.add('companion_state', JSON.stringify(value), value.operationId);
  }
  private check(epoch: number): void { if (epoch !== this.epoch) throw new BodyError('CANCELLED', '陪伴指令已撤销，未恢复旧动作'); }
  private release(owner = this.token): void { if (this.token !== owner) return; if (owner) this.body.releaseTask?.(owner); this.token = undefined; }
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
    const suspended = state === 'paused' ? this.suspendedFor : undefined;
    return { state, intent: this.intent?.action, ...(this.intent?.player ? { player: this.intent.player, distance: this.intent.distance } : {}), ...(this.intent?.action === 'follow' ? { guardEnabled: !!this.intent.guard } : {}), ...(stage ? { stage } : {}),
      ...(suspended ? { suspendedFor: suspended, reason: this.awaitingPlayer ? `让开去做 ${suspended} 之后，${this.intent?.player ?? '玩家'} 不在附近，回到附近会自动接着跟；不用 resume，想结束用 companion-mode stop` : `暂时让开去做 ${suspended}，做完自动接着${this.intent?.action === 'wait' ? '等' : '跟'}；不用 resume，想结束用 companion-mode stop` } : {}) };
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
      let variant = pickup.variants.find(item => item.item === receipt.stack.id && item.maxStackSize === receipt.stack.maxStackSize && item.storedIn === receipt.storedIn && isDeepStrictEqual(item.components, receipt.stack.components));
      if (!variant) { variant = { item: receipt.stack.id, count: 0, maxStackSize: receipt.stack.maxStackSize, components: structuredClone(receipt.stack.components), ...(receipt.storedIn ? { storedIn: receipt.storedIn } : {}) }; pickup.variants.push(variant); }
      variant.count += receipt.pickedUpCount;
    }
    if (pickup.cursor !== state.pickupCursor) throw new BodyError('PICKUP_GAP', '持续拾取最新游标没有完整收据');
    // Older own generations have already been accounted for; keep only the current confirmed generation.
    if (state.controlGeneration !== undefined) pickup.generations = new Set([state.controlGeneration]);
  }
  /** The token stays owned throughout this short stop/change-generation transaction. */
  private async internalStop(epoch: number): Promise<Observation> {
    this.check(epoch); const owner = this.beginChange();
    this.publish({ ...this.value, activity: 'switching', operationId: undefined }, false);
    try {
      await this.body.stop(); this.check(epoch);
      const state = await this.observe(epoch);
      const old = this.intent!.context, next = contextOf(state);
      if (old.instanceId !== next.instanceId || old.sessionId !== next.sessionId || old.worldId !== next.worldId || old.dimension !== next.dimension || next.controlGeneration !== (old.controlGeneration ?? -1) + 1) throw new BodyError('WORLD_CHANGED', '内部停止不属于原陪伴会话的下一控制代次');
      this.intent!.context = next;
      if (this.pickup) { this.pickup.generations.add(next.controlGeneration!); this.ingestPickup(state); }
      if (this.mining) { this.mining.generations.add(next.controlGeneration!); this.ingestMining(state); }
      return state;
    } finally { this.finishChange(owner); }
  }
  private async say(epoch: number, message?: string): Promise<void> {
    if (!message) return;
    const sent = await this.body.act('send-chat', { message }, this.token); this.check(epoch);
    if (sent.status !== 'succeeded') throw new BodyError(sent.status === 'unknown' ? 'INVALID_RESPONSE' : 'CHAT_FAILED', sent.summary);
  }
  /** Immediate accepted result; the in-flight game action remains protected by the task token. */
  async request(request: CompanionRequest, internal?: { suspendedFor: string }): Promise<CompanionState> {
    if (this.changing || this.stopping || this.stopUnconfirmed) throw new BodyError('BUSY', '陪伴模式正在切换或停止尚未确认，请等待或明确叫停');
    if (request.action === 'follow' && (!request.player || !/^[A-Za-z0-9_]{1,16}$/.test(request.player) || (request.distance !== undefined && (!Number.isFinite(request.distance) || request.distance < 1.5 || request.distance > 6)))) throw new BodyError('INVALID_ARGUMENT', '跟随需要明确玩家；距离范围为1.5..6');
    if (request.action !== 'follow' && (request.player !== undefined || request.distance !== undefined || request.wander !== undefined || (request.guard !== undefined && request.action !== 'guard') || request.pickup !== undefined || request.mining !== undefined)) throw new BodyError('INVALID_ARGUMENT', '只有新的follow指令可指定玩家、距离、拾取／陪挖配置；保护用 action guard 单独开关');
    if (request.action === 'guard' && request.guard === undefined) throw new BodyError('INVALID_ARGUMENT', 'guard 需要 guard 参数：true／false 或保护选项');
    if (request.action === 'stop') return this.endCompanion(request.say);
    if (request.action === 'guard') {
      if (!this.intent) throw new BodyError('NO_COMPANION_INTENT', '没有正在进行的跟随；保护跟着跟随走，先 follow');
      if (this.intent.action !== 'follow') throw new BodyError('INVALID_STATE', '保护属于跟随；原地等待中先 follow 再开保护');
    }
    const guard = request.action === 'follow' ? this.guardFor(request.guard) : request.action === 'guard' ? this.guardFor(request.guard, this.intent?.guard) : undefined;
    if (request.action === 'guard' && !['following', 'waiting'].includes(this.value.state)) {
      // Paused (also while stepping aside) or blocked: nothing runs on the server, so only the intent changes and a later resume starts with it.
      await this.say(this.epoch, request.say);
      this.intent!.guard = guard; this.publish({ ...this.value, guardEnabled: !!guard }); return this.snapshot();
    }
    if (request.pickup && request.mining) throw new BodyError('INVALID_ARGUMENT', '首版持续拾取与陪挖配置互斥；陪挖自行收取新观察的掉落');
    if (request.mining) {
      if (!['companion-mining', 'nearby-resources', 'approach-resource', 'dig-block', 'pickup-item', 'select-slot', 'assess-tool'].every(cap => this.body.hello.capabilities.includes(cap))) throw new BodyError('UNSUPPORTED', '游戏端没有完整持续陪挖／工具及玩家边界保护能力');
      const { blockIds, maxBlocks, radius = 4, durationMs = 300000 } = request.mining;
      if (!Array.isArray(blockIds) || blockIds.length < 1 || blockIds.length > 8 || new Set(blockIds).size !== blockIds.length || blockIds.some(id => typeof id !== 'string' || !miningSelector.test(id)) || !Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 32 || !Number.isInteger(radius) || radius < 3 || radius > 4 || !Number.isInteger(durationMs) || durationMs < 10000 || durationMs > 600000 || (request.distance ?? 2.5) > radius) throw new BodyError('INVALID_ARGUMENT', '陪挖需要1..8个矿石ID或标签（如 #c:ores）、maxBlocks 1..32、整数半径3..4和durationMs 10000..600000；跟随距离不能超过半径');
    }
    if (request.pickup) {
      if (!['companion-pickup', 'pickup-item'].every(cap => this.body.hello.capabilities.includes(cap))) throw new BodyError('UNSUPPORTED', '游戏端没有持续拾取玩家边界保护能力');
      const radius = request.pickup.radius ?? 3;
      if (!Array.isArray(request.pickup.items) || request.pickup.items.length < 1 || request.pickup.items.length > 8 || request.pickup.items.some(item => !/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(item)) || !Number.isFinite(radius) || radius < 1.5 || radius > 4 || (request.distance ?? 2.5) > radius) throw new BodyError('INVALID_ARGUMENT', '拾取需要1..8个明确物品ID、1.5..4半径，跟随距离不能大于拾取半径');
    }
    if ((request.action === 'resume' || request.action === 'pause') && !this.intent) throw new BodyError('NO_COMPANION_INTENT', '没有可暂停或恢复的陪伴意图；需要新的明确指令');
    if (request.action === 'resume' && !['paused', 'blocked'].includes(this.value.state)) throw new BodyError('INVALID_STATE', '只有暂停或受阻的陪伴可显式恢复');
    if (request.action === 'pause' && this.value.state === 'paused') {
      await this.say(this.epoch, request.say);
      // The model pausing on its own makes it a manual pause: no automatic pick-up, until resume.
      if (!internal && this.suspendedFor) this.holdPause();
      return this.snapshot();
    }
    const suspendedBefore = this.suspendedFor;
    const epoch = ++this.epoch;
    const owner = this.beginChange();
    let acquired = false;
    try {
      // Acquire before any awaits; this serializes with finite task and atomic action starts.
      this.acquire(); acquired = true;
      if (request.action !== 'pause') { this.suspendedFor = undefined; this.awaitingPlayer = false; if (request.action !== 'guard') this.leases.clear(); }
      if (this.childActive) { this.gather.cancel(); this.childActive = false; }
      const wasSuspended = request.action === 'resume' && !!suspendedBefore;
      if (this.intent && request.action !== 'resume') {
        await this.body.stop(); this.check(epoch);
        this.gather.stopped();
        if (request.action === 'follow' || request.action === 'wait') this.intent = undefined;
        if (request.action === 'guard') this.intent!.guard = guard;
      }
      // Work done while stepping aside may have stopped the body (a cancelled task): the same session and world with a later generation is still ours.
      const initial = await this.observe(epoch, request.action === 'resume' && !wasSuspended ? this.intent!.context : undefined);
      if (wasSuspended || request.action === 'guard') {
        const next = contextOf(initial);
        if (!this.adoptable(next, this.intent!.context, request.action === 'guard')) throw new BodyError('WORLD_CHANGED', '陪伴会话／世界／维度改变或控制代次不连续；旧意图已废弃');
        this.intent!.context = next;
      }
      if (request.action === 'pause') {
        this.intent!.context = contextOf(initial);
        if (this.pickup) { this.pickup.generations.add(initial.controlGeneration!); this.ingestPickup(initial); }
        if (this.mining) { this.mining.generations.add(initial.controlGeneration!); this.ingestMining(initial); }
        await this.say(epoch, request.say); this.check(epoch); this.release();
        this.suspendedFor = internal?.suspendedFor; this.awaitingPlayer = false;
        this.publish(this.base('paused')); return this.snapshot();
      }
      if (request.action === 'follow') {
        this.intent = { action: 'follow', player: request.player!, expectedEntityId: this.identity(initial, request.player!), distance: request.distance ?? 2.5, wander: request.wander !== false && !request.pickup && !request.mining, ...(guard ? { guard } : {}), context: contextOf(initial), ...(request.pickup ? { pickup: { items: [...request.pickup.items], radius: request.pickup.radius ?? 3 } } : {}) };
        this.initPickup(initial, request.pickup);
        this.initMining(initial, request.mining);
        this.lastGuard = undefined; this.fight = undefined;
      } else if (request.action === 'wait') { this.intent = { action: 'wait', context: contextOf(initial) }; this.pickup = undefined; this.mining = undefined; }
      else if (request.action === 'guard') {
        this.identity(initial, this.intent!.player!, this.intent!.expectedEntityId);
        if (this.pickup) { this.pickup.generations.add(initial.controlGeneration!); this.ingestPickup(initial); }
        if (this.mining) { this.mining.generations.add(initial.controlGeneration!); this.ingestMining(initial); }
        this.lastGuard = undefined; this.fight = undefined;
      } else if (this.intent!.action === 'follow') {
        this.identity(initial, this.intent!.player!, this.intent!.expectedEntityId);
        if (this.pickup) { this.pickup.cursor = initial.pickupCursor!; this.pickup.generations = new Set([initial.controlGeneration!]); this.pickup.attempted.clear(); this.pickup.state.code = undefined; }
        if (this.mining) { this.mining.generations.add(initial.controlGeneration!); this.ingestMining(initial); if (this.now() >= this.mining.state.deadline) this.disableMining('DURATION_BUDGET'); }
      }
      if (initial.container) throw new BodyError('BUSY', '请先关闭当前菜单，再开始陪伴');
      await this.say(epoch, request.say);
      this.check(epoch);
      const intent = this.intent!, token = this.token!;
      if (intent.action === 'wait') { this.publish(this.base('waiting', 'active')); return this.snapshot(); }
      this.publish(this.base('following', 'starting'));
      void this.start(epoch, token, intent);
      return this.snapshot();
    } catch (error) {
      if (acquired && epoch === this.epoch) this.fail(error as Error);
      throw error;
    } finally { this.finishChange(owner); }
  }
  private async start(epoch: number, token: string, intent: Intent): Promise<void> {
    try {
      // Reobserve after chat/setup, not a stale target from the beginning of a request.
      const state = await this.observe(epoch, intent.context); this.identity(state, intent.player!, intent.expectedEntityId); this.check(epoch);
      const op = await this.body.act('follow-companion', { player: intent.player!, expectedEntityId: intent.expectedEntityId!, distance: intent.distance, ...(intent.wander === false ? { wander: false } : {}), ...(intent.guard ? { guard: intent.guard } : {}) }, token);
      this.check(epoch); this.accept(op, intent);
    } catch (error) { if (epoch === this.epoch) this.fail(error as Error); }
  }
  private accept(op: Operation, intent: Intent): void {
    if (op.sessionId !== intent.context.sessionId || op.controlGeneration !== intent.context.controlGeneration || op.name !== 'follow-companion') throw new BodyError('WORLD_CHANGED', '陪伴回执不属于当前会话和代次');
    if (op.status !== 'running') {
      const code = (op.result as { code?: string } | undefined)?.code;
      this.fail(new BodyError(op.status === 'unknown' ? 'INVALID_RESPONSE' : op.status === 'cancelled' ? 'CANCELLED' : code ?? 'FOLLOW_FAILED', op.summary), op); return;
    }
    const result = op.result as { state?: string; player?: string; expectedEntityId?: string; distance?: number; guard?: GuardState } | undefined;
    if (!result || !['following', 'waiting', 'guarding'].includes(result.state ?? '') || result.player !== intent.player || result.expectedEntityId !== intent.expectedEntityId || result.distance !== intent.distance) throw new BodyError('INVALID_RESPONSE', '持续跟随回执缺少完整状态或目标身份');
    if (intent.guard && !result.guard) throw new BodyError('INVALID_RESPONSE', '保护跟随的回执缺少保护状态');
    // Guarding is part of following: the body is still bound to the same player and intent.
    const state = result.state === 'waiting' ? 'waiting' : 'following';
    this.publish({ ...this.base(state, 'active'), ...(this.pickup || this.mining ? { activity: 'following' as const } : {}), ...(result.guard ? { guard: structuredClone(result.guard) } : {}), operationId: op.operationId }, false);
    if (result.guard) this.noteGuard(result.guard, intent.player!);
  }
  /** A guarding follow is running: the server fights for the player. */
  guarding(): boolean { return !!this.intent?.guard && ['following', 'waiting'].includes(this.value.state) && !this.childActive; }
  private guardFor(request?: GuardOptions | boolean, current?: GuardOptions): GuardOptions | undefined {
    if (request === false) return undefined;
    if (!this.body.hello.capabilities.includes('companion-guard')) {
      if (request) throw new BodyError('UNSUPPORTED', '游戏端没有保护玩家能力（companion-guard），未降级为普通跟随');
      return undefined;
    }
    if (request === undefined && this.guardDefaults === false) return undefined;
    const guard = { ...(this.guardDefaults || {}), ...(current ?? {}), ...(typeof request === 'object' ? request : {}) };
    if ((guard.radius !== undefined && (!Number.isFinite(guard.radius) || guard.radius < 3 || guard.radius > 12)) || (guard.lowHealth !== undefined && (!Number.isFinite(guard.lowHealth) || guard.lowHealth < 4 || guard.lowHealth > 16))
      || (guard.bow !== undefined && typeof guard.bow !== 'boolean') || (guard.shield !== undefined && typeof guard.shield !== 'boolean')) throw new BodyError('INVALID_ARGUMENT', '保护范围 3..12、撤退血量 4..16，bow／shield 为布尔值');
    return guard;
  }
  /** Fights start, end and retreats become events; distance changes and each swing do not wake the model. */
  private noteGuard(guard: GuardState, player: string): void {
    const before = this.lastGuard; this.lastGuard = structuredClone(guard);
    const busy = (state?: string) => !!state && state !== 'idle';
    if (guard.state === 'retreating' && before?.state !== 'retreating') this.events.add('guard', `血量低（打不过），正在往 ${player} 那边撤，回血后再上。`);
    else if (guard.state === 'evading' && before?.state !== 'evading') this.events.add('guard', '苦力怕要炸了，先躲开。');
    if (busy(guard.state) && !this.fight) {
      this.fight = { kills: before?.kills ?? guard.kills, targets: new Set() };
      if (guard.state !== 'retreating' && guard.state !== 'evading' && this.now() - this.fightNotedAt >= 20000) {
        this.fightNotedAt = this.now();
        this.events.add('guard', `有 ${guard.target ?? '敌对生物'} 靠近 ${player}，${guard.state === 'shooting' || guard.state === 'aiming' ? '正在用弓射' : '正在过去打'}；程序自己打，不用发工具。`);
      }
    }
    if (this.fight && guard.target) this.fight.targets.add(guard.target);
    if (this.fight && !busy(guard.state)) {
      const kills = guard.kills - this.fight.kills;
      if (kills > 0) this.events.add('guard', `打完了：打倒 ${kills} 只（${[...this.fight.targets].join('、') || '敌对生物'}），接着跟着 ${player}。`);
      this.fight = undefined;
    }
  }
  /** RuntimeMonitor refreshes state in the background; near/far transitions never wake the model. */
  async update(state: Observation, observedEpoch: number | null = this.observationRevision): Promise<void> {
    if (observedEpoch !== this.observationRevision || this.changing || this.stopping || !this.intent) return;
    const epoch = this.epoch, intent = this.intent, id = this.value.operationId;
    try {
      const suspended = this.value.state === 'paused' && !!this.suspendedFor;
      const sameContext = isDeepStrictEqual(contextOf(state), intent.context);
      if (!state.connected || state.health <= 0 || !(sameContext || (suspended && this.adoptable(contextOf(state), intent.context)))) throw new BodyError('WORLD_CHANGED', '陪伴会话或控制代次改变；旧意图已废弃');
      if (suspended) {
        if (!sameContext) intent.context = contextOf(state);
        await this.autoResume(state); return;
      }
      if (this.pickup && !['paused', 'blocked'].includes(this.value.state)) this.ingestPickup(state);
      if (this.mining && !['paused', 'blocked'].includes(this.value.state)) this.ingestMining(state);
      if (this.childActive) return;
      if (!id || !['following', 'waiting'].includes(this.value.state)) return;
      const op = await this.body.operation(id); this.check(epoch);
      if (observedEpoch !== this.observationRevision || this.changing || this.stopping || this.childActive) return;
      this.accept(op, intent);
      if (this.mining?.state.active) {
        if (this.now() >= this.mining.state.deadline) this.disableMining('DURATION_BUDGET');
        else if (this.mining.state.attemptedBlocks >= this.mining.state.maxBlocks) this.disableMining('BLOCK_BUDGET');
        else if (this.value.state === 'waiting' && this.value.stage === 'active' && this.now() - this.mining.lastScanAt >= 2000) {
          this.identity(state, intent.player!, intent.expectedEntityId);
          const target = state.entities.find(entity => entity.id === intent.expectedEntityId)!;
          if (Math.hypot(state.position.x - target.position.x, state.position.y - target.position.y, state.position.z - target.position.z) <= this.mining.state.radius) {
            const mining = this.mining, child = Symbol(); mining.lastScanAt = this.now(); mining.child = child; mining.childMined = 0; this.childActive = true;
            void this.mineBlock(epoch, mining, child);
          }
        }
      }
      if (this.pickup && this.value.state === 'waiting' && this.value.stage === 'active') {
        const target = state.entities.find(entity => entity.id === intent.expectedEntityId && entity.name === intent.player && entity.type === 'minecraft:player');
        if (!target) throw new BodyError('STALE_COMPANION', '陪伴玩家身份或在线状态改变');
        const radius = this.pickup.state.radius;
        if (Math.hypot(state.position.x - target.position.x, state.position.y - target.position.y, state.position.z - target.position.z) > radius) return;
        const item = state.groundItems?.find(item => this.pickup!.state.items.includes(item.stack.id) && item.visibility === 'visible' && !this.pickup!.attempted.has(item.entityId) && Math.hypot(item.position.x - target.position.x, item.position.y - target.position.y, item.position.z - target.position.z) <= radius);
        if (item) { this.pickup.attempted.add(item.entityId); this.pickup.pending = { item: structuredClone(item), cursor: this.pickup.cursor, receipts: [] }; this.childActive = true; void this.pickupItem(epoch, structuredClone(item)); }
      }
    } catch (error) { if (epoch === this.epoch && observedEpoch === this.observationRevision) { if (this.pickup || this.mining) await this.block(error as Error, epoch); else this.fail(error as Error); } }
  }
  private async mineBlock(epoch: number, mining: MiningTracker, child: symbol): Promise<void> {
    let unknownChild = false;
    const check = () => { this.check(epoch); if (this.mining !== mining || mining.child !== child) throw new BodyError('CANCELLED', '旧陪挖子任务已被取代'); if (this.now() >= mining.state.deadline) throw new BodyError('MINING_DURATION', '陪挖总时间已到，未开始后续步骤'); };
    try {
      check();
      const state = await this.internalStop(epoch); check();
      this.identity(state, this.intent!.player!, this.intent!.expectedEntityId);
      const target = state.entities.find(entity => entity.id === this.intent!.expectedEntityId)!;
      const companionMiningGuard = { player: this.intent!.player!, expectedEntityId: this.intent!.expectedEntityId!, maxDistance: mining.state.radius };
      this.publish({ ...this.base('waiting', 'active'), activity: 'mining' }, false);
      const scan = await this.body.nearbyResources!({ blockIds: mining.state.blockIds, radius: mining.state.radius, maxResults: 32, companionMiningGuard }); check();
      if (!isDeepStrictEqual(contextOf(scan), this.intent!.context)) throw new BodyError('WORLD_CHANGED', '陪挖扫描不属于内部停止后的权威代次');
      const fresh = await this.observe(epoch, this.intent!.context); check(); this.ingestMining(fresh);
      this.identity(fresh, companionMiningGuard.player, companionMiningGuard.expectedEntityId);
      const latestPlayer = fresh.entities.find(entity => entity.id === companionMiningGuard.expectedEntityId)!;
      if (!isDeepStrictEqual(latestPlayer.position, target.position)) throw new BodyError('COMPANION_OUT_OF_RANGE', '陪挖扫描期间玩家已移动；此轮未选定矿石');
      const positionKey = (point: { x: number; y: number; z: number }) => `${point.x},${point.y},${point.z}`;
      const candidate = scan.candidates.find(candidate => candidate.kind === 'ore' && candidate.visible && candidate.targetToken && !mining.attempted.has(positionKey(candidate.position))
        && Math.hypot(candidate.position.x + 0.5 - latestPlayer.position.x, candidate.position.y + 0.5 - latestPlayer.position.y, candidate.position.z + 0.5 - latestPlayer.position.z) >= 2);
      if (!candidate) { await this.returnFromMining(epoch, mining, child, false); return; }
      mining.attempted.add(positionKey(candidate.position)); mining.state.attemptedBlocks++;
      const owner: BorrowedMining = { kind: 'mining', taskToken: this.token!, context: this.intent!.context, center: scan.center, companionGuard: companionMiningGuard, candidate: structuredClone(candidate), deadline: mining.state.deadline, check,
        onProgress: operation => {
          if (epoch !== this.epoch || this.mining !== mining || mining.child !== child) return;
          if (operation.status === 'unknown') unknownChild = true;
          const result = operation.result as { minedBlocks?: number } | undefined;
          if (Number.isInteger(result?.minedBlocks) && result!.minedBlocks! >= mining.childMined && result!.minedBlocks! <= 1) { mining.state.minedBlocks += result!.minedBlocks! - mining.childMined; mining.childMined = result!.minedBlocks!; }
        } };
      const result = await this.gather.mineCompanionBlock(candidate, owner);
      if (result.status === 'unknown') { unknownChild = true; throw new BodyError('UNKNOWN', result.summary); }
      check();
      const latest = await this.observe(epoch, this.intent!.context); check(); this.ingestMining(latest);
      if (result.status !== 'succeeded') throw new BodyError((result.result as { code?: string } | undefined)?.code ?? (result.status === 'cancelled' ? 'CANCELLED' : 'STEP_FAILED'), result.summary);
      await this.returnFromMining(epoch, mining, child);
    } catch (error) {
      if (epoch !== this.epoch || this.mining !== mining || mining.child !== child) return;
      if (unknownChild) { mining.state.lastCode = 'UNKNOWN'; await this.block(new BodyError('UNKNOWN', (error as Error).message), epoch); return; }
      const code = error instanceof BodyError ? error.code : 'INVALID_RESPONSE'; mining.state.lastCode = code;
      if (code === 'MINING_DURATION' || code === 'TASK_TIMEOUT' && this.now() >= mining.state.deadline || code === 'COMPANION_OUT_OF_RANGE') {
        try { await this.returnFromMining(epoch, mining, child); } catch (stopError) { if (epoch === this.epoch) await this.block(stopError as Error, epoch); }
      } else await this.block(error as Error, epoch);
    }
  }
  private async returnFromMining(epoch: number, mining: MiningTracker, child: symbol, stop = true): Promise<void> {
    this.check(epoch); if (this.mining !== mining || mining.child !== child) throw new BodyError('CANCELLED', '旧陪挖收尾不能恢复新意图');
    if (stop) { this.gather.cancel(); await this.internalStop(epoch); this.check(epoch); this.gather.stopped(); }
    mining.child = undefined; this.childActive = false;
    if (this.now() >= mining.state.deadline) this.disableMining('DURATION_BUDGET');
    else if (mining.state.attemptedBlocks >= mining.state.maxBlocks) this.disableMining('BLOCK_BUDGET');
    this.publish({ ...this.base('following', 'starting'), activity: 'following' }, false);
    await this.start(epoch, this.token!, this.intent!);
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
        if (!['COMPANION_OUT_OF_RANGE', 'TARGET_CONSUMED', 'PICKUP_MERGED'].includes(code) || child.status === 'unknown') throw new BodyError(code, child.summary);
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
    const blockedEpoch = ++this.epoch, owner = this.beginChange();
    let stopConfirmed = false;
    try {
      const result = await this.body.stop();
      if (result.stopped !== true) throw new BodyError('STOP_UNCONFIRMED', '阻断收尾停止未确认；保留陪伴写锁');
      stopConfirmed = true; this.check(blockedEpoch); this.gather.stopped();
      const state = await this.observe(blockedEpoch);
      if (this.intent) {
        const old = this.intent.context, next = contextOf(state);
        if (old.instanceId !== next.instanceId || old.sessionId !== next.sessionId || old.worldId !== next.worldId || old.dimension !== next.dimension || next.controlGeneration !== (old.controlGeneration ?? -1) + 1) throw new BodyError('WORLD_CHANGED', '阻断收尾不能采用外部会话／控制代次');
        this.intent.context = next;
      }
      if (this.pickup) { this.pickup.generations.add(state.controlGeneration!); try { this.ingestPickup(state); } catch { this.pickup.state.countStatus = 'partial-or-unknown'; } }
      if (this.mining) { this.mining.generations.add(state.controlGeneration!); try { this.ingestMining(state); } catch { this.mining.state.countStatus = 'partial-or-unknown'; } }
      this.fail(error, operation);
    } catch (stopError) { if (blockedEpoch === this.epoch) { this.stopUnconfirmed = !stopConfirmed; this.fail(stopError as Error, undefined, true); } }
    finally { this.finishChange(owner); }
  }
  /** Lease/process loss is terminal; no persisted or automatic resume. */
  fail(error: Error, operation?: Operation, controlLost = false): void {
    const code = error instanceof BodyError ? error.code : 'INVALID_RESPONSE';
    if (['idle', 'stopped'].includes(this.value.state) && !this.intent && !this.token) return;
    ++this.epoch; this.suspendedFor = undefined; this.awaitingPlayer = false; this.leases.clear();
    this.observationRevision++;
    if (this.childActive) { this.gather.cancel(); this.childActive = false; }
    if (this.pickup) {
      this.pickup.state.code = code;
      if (['PICKUP_GAP', 'PICKUP_UNKNOWN', 'UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'LEASE_EXPIRED', 'INVALID_RESPONSE', 'TRANSPORT_LOST'].includes(code)) this.pickup.state.countStatus = 'partial-or-unknown';
    }
    if (this.mining) {
      this.mining.state.lastCode = code;
      if (['PICKUP_GAP', 'PICKUP_UNKNOWN', 'UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'LEASE_EXPIRED', 'INVALID_RESPONSE', 'TRANSPORT_LOST', 'STOP_UNCONFIRMED'].includes(code)) this.mining.state.countStatus = 'partial-or-unknown';
    }
    const terminal = controlLost || terminalControl.has(code);
    if (terminal) this.intent = undefined;
    if (!this.stopUnconfirmed) this.release(); this.terminal = operation;
    this.publish({ ...this.base(terminal ? 'stopped' : 'blocked'), ...(operation ? { operationId: operation.operationId } : {}), code, reason: error.message }, false);
    const failureState = this.snapshot();
    if (operation) this.events.notifyCompanionOperation(operation, failureState);
    else this.events.add('companion', JSON.stringify(failureState));
    // An untrusted running receipt or lost context cannot leave an unowned movement behind.
    if (terminal) { this.pickup = undefined; void this.body.close().catch(() => {}); }
  }
  /** Explicit stop clears intent synchronously and keeps the lock until in-flight work is fenced. */
  stop(reason?: string): Promise<{ stopped: true }> {
    if (this.stopping) return this.stopping;
    ++this.epoch; this.intent = undefined; this.suspendedFor = undefined; this.awaitingPlayer = false; this.leases.clear();
    const owner = this.beginChange();
    const token = this.token, miningState = this.mining ? { ...this.miningState(), active: false, disabledReason: 'STOPPED' } : undefined;
    if (this.childActive) { this.gather.cancel(); this.childActive = false; }
    this.terminal = undefined;
    this.pickup = undefined;
    this.mining = undefined;
    if (this.value.state !== 'idle' && this.value.state !== 'stopped') this.publish({ state: 'stopped', ...(reason ? { reason } : {}), ...(miningState ? { mining: miningState } : {}) });
    const stopping = (async () => {
      try {
        const result = await this.body.stop();
        if (result.stopped !== true) throw new BodyError('STOP_UNCONFIRMED', '身体停止未确认；保留陪伴写锁');
        this.gather.stopped(); this.stopUnconfirmed = false; this.release(token); return result;
      } catch (error) { this.stopUnconfirmed = true; throw error; }
    })().finally(() => { if (this.stopping === stopping) this.stopping = undefined; this.finishChange(owner); });
    this.stopping = stopping;
    return stopping;
  }

  /**
   * Another tool or reflex needs the body: the follow/wait steps aside (state paused, suspendedFor = reason) and is picked up again by itself
   * once every lease is released and nothing else is running. A manual pause (or no follow at all) is left alone.
   */
  async yieldTo(reason: string): Promise<YieldLease> {
    const none: YieldLease = { release: async () => {}, hold: () => {} };
    const live = () => !!this.intent && (['following', 'waiting'].includes(this.value.state) || (this.value.state === 'paused' && !!this.suspendedFor));
    if (!live()) return none;
    const id = Symbol(); this.leases.add(id); this.idleSince = undefined;
    const lease: YieldLease = {
      release: async () => { if (this.leases.delete(id)) await this.autoResume(); },
      hold: () => { this.leases.delete(id); this.holdPause(); },
    };
    try {
      if (this.value.state === 'paused') {
        if (this.suspendedFor !== reason) { this.suspendedFor = reason; this.value = this.base('paused'); }
      } else {
        // A resume or stop that is still switching clears in a moment: wait for it instead of failing the tool.
        for (let attempt = 0; ; attempt++) {
          try { await this.request({ action: 'pause' }, { suspendedFor: reason }); break; }
          catch (error) { if (!(error instanceof BodyError) || error.code !== 'BUSY' || attempt >= 20 || !this.changing) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
        }
      }
    } catch (error) { this.leases.delete(id); throw error; }
    return lease;
  }
  /** Turn a step-aside into a manual pause: it stays paused until resume or a new follow. */
  holdPause(): void {
    if (this.value.state !== 'paused' || !this.suspendedFor) return;
    this.suspendedFor = undefined; this.awaitingPlayer = false; this.leases.clear();
    this.publish(this.base('paused'));
  }
  private bodyIdle(): boolean { return this.body.isBusy?.() !== true && this.body.pendingOperations().length === 0 && this.busyProbe?.() !== true; }
  /** Same instance, session, world and dimension; the control generation may only have moved on (a cancelled task stops the body). */
  private adoptable(next: Context, old: Context, exactlyNext = false): boolean {
    if (old.instanceId !== next.instanceId || old.sessionId !== next.sessionId || old.worldId !== next.worldId || old.dimension !== next.dimension) return false;
    return exactlyNext ? next.controlGeneration === (old.controlGeneration ?? -1) + 1 : (next.controlGeneration ?? -1) >= (old.controlGeneration ?? -1);
  }
  /** The follow/wait that stepped aside picks up again when no lease is held, nothing runs, the body is awake and the player is near. */
  private async autoResume(seen?: Observation): Promise<void> {
    if (this.resuming || !this.intent || this.value.state !== 'paused' || !this.suspendedFor || this.leases.size || this.changing || this.stopping || this.stopUnconfirmed) return;
    this.resuming = true;
    const intent = this.intent;
    try {
      const state = seen ?? await this.body.observe();
      if (this.intent !== intent || !this.suspendedFor || this.leases.size || this.changing || this.stopping) return;
      if (state.sleeping || state.container || !this.bodyIdle()) { this.idleSince = undefined; return; }
      this.idleSince ??= this.now();
      if (this.now() - this.idleSince < this.resumeDelayMs) {
        if (!this.resumeTimer) { this.resumeTimer = setTimeout(() => { this.resumeTimer = undefined; void this.autoResume(); }, this.resumeDelayMs + 50); this.resumeTimer.unref?.(); }
        return;
      }
      if (intent.action === 'follow' && !state.entities.some(entity => entity.type === 'minecraft:player' && entity.name === intent.player && entity.name !== state.username)) {
        if (!this.awaitingPlayer) {
          this.awaitingPlayer = true; this.value = this.base('paused');
          this.publish(this.value);
          this.events.add('companion', `事情做完了，但 ${intent.player} 不在附近，没法接着跟。他回到附近我会自动接上；想不跟了用 companion-mode stop，或重新 follow。`);
        }
        return;
      }
      await this.request({ action: 'resume' });
    } catch { /* a failed resume has already published a blocked state with its reason */ }
    finally { this.resuming = false; }
  }
  /** companion-mode stop: the follow/wait is over; whatever else is running keeps going. */
  private async endCompanion(say?: string): Promise<CompanionState> {
    const message = '跟随／等待已结束（companion-mode stop）；正在做的其他任务不受影响。要再跟随需要新的 follow。';
    if (!this.intent && ['idle', 'stopped'].includes(this.value.state)) { if (say) await this.say(this.epoch, say); return { ...this.snapshot(), reason: '当前没有跟随或等待，什么都没改' }; }
    if (say) await this.say(this.epoch, say);
    if (['following', 'waiting'].includes(this.value.state)) { await this.stop(message); return this.snapshot(); }
    // Paused (also stepping aside) or blocked: nothing of ours runs on the body, so only the intent goes.
    const owner = this.beginChange();
    try {
      ++this.epoch; this.intent = undefined; this.suspendedFor = undefined; this.awaitingPlayer = false; this.leases.clear();
      this.terminal = undefined; this.pickup = undefined; this.mining = undefined;
      if (this.childActive) { this.gather.cancel(); this.childActive = false; }
      this.release();
      this.publish({ state: 'stopped', reason: message });
    } finally { this.finishChange(owner); }
    return this.snapshot();
  }
  /** Stop what other work left on the body (a cancelled task), keeping a follow that is stepping aside. A follow that is running has nothing else to stop. */
  async stopWork(): Promise<{ stopped: true }> {
    if (this.stopping) return this.stopping;
    if (this.intent && ['following', 'waiting'].includes(this.value.state) && !this.changing) return { stopped: true };
    return this.body.stop();
  }
}
