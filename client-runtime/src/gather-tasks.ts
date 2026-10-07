import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BodyError, type Body, type Observation, type Operation, type ItemValue, type Position, type NearbyResources, type ActionName, type ActionArguments, type GroundItem, type CompanionGuard } from './body.js';
import type { EventJournal } from './events.js';
import { selectFood, type SurvivalTasks } from './survival-tasks.js';
import { pillarBlockCount, pillarDown, pillarUp, type PillarBlock, type PillarHost, type PillarPurpose } from './pillar.js';
import type { SurvivalPolicy } from './survival-reflexes.js';

type Context = Pick<Observation, 'instanceId' | 'sessionId' | 'worldId' | 'dimension' | 'controlGeneration'>;
type Request = { resourceRef?: string; item: string; count?: number; stacks?: number; radius?: number; say?: string; maxSteps?: number; timeoutMs?: number };
type Name = 'gather-resources' | 'collect-items';
export interface BorrowedOwner { taskToken: string; context: Context; center: Position; companionGuard: CompanionGuard; check: () => void }
export interface BorrowedPickup extends BorrowedOwner { entityId: string; source: GroundItem; priorPicked: (state: Observation) => number }
export interface BorrowedMining extends BorrowedOwner { kind: 'mining'; candidate: NearbyResources['candidates'][number]; deadline: number; onProgress?: (operation: Operation) => void }
type Borrowed = BorrowedPickup | BorrowedMining;
const miningOwner = (owner?: Borrowed): owner is BorrowedMining => !!owner && 'kind' in owner && owner.kind === 'mining';
const MINING_DROP_MARGIN = 1.5;
type Reference = { context: Context; expires: number; scan: NearbyResources; radius: number };
type Progress = { stage: string; item: string; requestedCount?: number; requestedStacks?: number; targetCount?: number; maxStackSize?: number; pickedUpCount?: number; lastConfirmedPickedUpCount?: number; overage: number; minedBlocks: number; steps: number; maxSteps: number; pickup: 'native-confirmed' | 'partial-or-unknown'; quantity: 'newly-picked'; totalNativePickedUpCount: number; unexpectedPickedUpCount: number; items: Array<{ item: string; count: number; maxStackSize?: number }>; code?: string; variantComponents?: ItemValue['components']; limitation?: string; pickupMovementRaces?: number; lastPickupMovementCode?: string; lastPickupMovementSummary?: string; storedIn?: Record<string, number>; pillarPlaced?: number; pillarRecovered?: number; unreachable?: number; leavesShaken?: number; leavesDecayed?: number; stuckHigh?: number };
type Active = { least?: number; id: string; taskToken: string; borrowed?: Borrowed; oldGround?: Set<string>; name: Name; epoch: number; context: Context; center: Position; radius: number; deadline: number; cursor: number; allowed: Set<string>; collectedEntities: Map<string, number>; variant?: ItemValue; request: Request; progress: Progress; cancelled?: boolean; stopPending?: boolean; top?: number };
const contextOf = (state: Context): Context => ({ instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration });
const unknownCodes = new Set(['UNKNOWN', 'PICKUP_GAP', 'PICKUP_UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'STALE_CONTROL', 'TRANSPORT_LOST', 'INVALID_RESPONSE', 'LEASE_EXPIRED', 'TASK_TIMEOUT', 'STOP_UNCONFIRMED']);
type Candidate = NearbyResources['candidates'][number];
// The server rolls each block's real loot table (plain and silk touch tool): drops authorize targets, never predict yield.
const dropOf = (candidate: Candidate, item: string) => candidate.drops.find(drop => drop.item === item);
const dropPreference = (candidate: Candidate, item: string) => dropOf(candidate, item)?.preference;
/** Ordinary block reach is 4.5 blocks from the eyes to the hit point; the block centre a little inside that counts as reachable. */
const REACH = 4.4, EYE = 1.62;
const eyeDistance = (feet: Position, block: Position) => Math.hypot(block.x + 0.5 - feet.x, block.y + 0.5 - (feet.y + EYE), block.z + 0.5 - feet.z);
const inReach = (feet: Position, block: Position) => eyeDistance(feet, block) <= REACH;
/** Native refusals of a dig from where the body stands; nothing was broken, so the block waits for an approach. */
const reachRefusals = new Set(['OUT_OF_REACH', 'NO_LINE_OF_SIGHT']);
/**
 * A candidate this many blocks above the feet is climbed to on a pillar (an arm reaches about five up from
 * beside it, but leaves and the trunk usually block that line of sight). The climb stays on candidates within
 * CLIMB_SPREAD of its column (one tree), rises at most MAX_PILLAR blocks, and only breaks leaves in its way.
 */
const CLIMB_ABOVE = 4, CLIMB_SPREAD = 2.5, MAX_PILLAR = 20;
const openCells = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:fern', 'minecraft:large_fern']);
// Modded leaves are named the same way (biomesoplenty:fir_leaves).
const isLeaves = (id: string | undefined) => !!id && /^[a-z0-9_.-]+:[a-z0-9_/]*leaves$/.test(id);
const feetLevel = (feet: Position) => Math.floor(feet.y + 0.01);
const nearest = (list: Candidate[], feet: Position) => [...list].sort((a, b) => eyeDistance(feet, a.position) - eyeDistance(feet, b.position))[0];
/** Stops that mean nobody may act for the task any more: the pillar stays where it is. */
const haltCodes = new Set(['CANCELLED', 'LEASE_LOST', 'WORLD_CHANGED', 'STALE_CONTROL', 'LEASE_EXPIRED', 'TRANSPORT_LOST', 'CLOSED']);
/** Finite goals on a frozen candidate set; native pickup receipts, never mined blocks or net inventory, determine quantity. */
export class GatherTasks {
  private readonly references = new Map<string, Reference>();
  private readonly operations = new Map<string, Operation>();
  private active?: Active;
  private epoch = 0;
  private survival?: SurvivalTasks;
  private survivalPolicy?: () => SurvivalPolicy & { armed: boolean; revision: number };
  constructor(private readonly body: Body, private readonly events: EventJournal, private readonly now = Date.now) {}
  useSurvival(tasks: SurvivalTasks, policy: () => SurvivalPolicy & { armed: boolean; revision: number }): void { this.survival = tasks; this.survivalPolicy = policy; }
  operation(id: string): Operation | undefined { const op = this.operations.get(id); return op && structuredClone(op); }
  assertIdle(): void { if (this.active) throw new BodyError('BUSY', '有限采集任务正在运行，请先完成或叫停'); }
  cancel(): void { ++this.epoch; this.references.clear(); if (this.active) { this.active.cancelled = true; this.active.stopPending = true; } }
  /** Only release the shared write token after the independent body stop was confirmed. */
  stopped(): void {
    if (!this.active?.cancelled) return;
    this.finish(this.active, 'cancelled', '用户已叫停，旧采集不恢复', 'CANCELLED');
    if (!this.active.borrowed) this.body.releaseTask?.(this.active.taskToken); this.active = undefined;
  }
  async discover(options: { blockIds: string[]; radius: number; maxResults: number }): Promise<unknown> {
    if (!this.body.nearbyResources) throw new BodyError('UNSUPPORTED', '身体不支持有限资源观察');
    const epoch = this.epoch;
    const scan = await this.body.nearbyResources(options);
    if (epoch !== this.epoch) throw new BodyError('CANCELLED', '叫停前资源观察已丢弃');
    const resourceRef = randomUUID();
    this.references.set(resourceRef, { context: contextOf(scan), expires: this.now() + 30000, scan, radius: options.radius });
    if (this.references.size > 32) this.references.delete(this.references.keys().next().value!);
    return { resourceRef, center: scan.center, candidates: scan.candidates.map(({ targetToken: _private, properties: _properties, ...item }) => item), truncated: scan.truncated,
      limitation: '只限本次已加载、可见的原木、矿石、石料候选（按方块标签认，模组的也算：#minecraft:logs、#c:ores、#c:stones）和固定区域；drops 是按服务器掉落表算出的可能产物，矿石只取普通产物（不支持精准采集矿石块），实际数量以原生拾取回执为准。不能识别人工建筑。引用30秒内提交；不补扫扩展候选，不挖路或搭桥。' };
  }
  private check(task: Active): void {
    task.borrowed?.check();
    if (task.epoch !== this.epoch || task.cancelled) throw new BodyError('CANCELLED', '采集已叫停，未执行后续步骤');
    if (this.now() >= task.deadline) throw new BodyError('TASK_TIMEOUT', '任务执行预算已到；未追加数量或候选');
  }
  private validate(request: Request, fractionalRadius = false): void {
    if ((request.count === undefined) === (request.stacks === undefined) || !Number.isInteger(request.count ?? request.stacks) || (request.count ?? request.stacks)! < 1 || (request.count ?? request.stacks)! > 256) throw new BodyError('INVALID_ARGUMENT', '必须明确count或stacks二选一，1..256整数；省略数量由Agent先选定');
    if (!/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(request.item) || (request.maxSteps !== undefined && (!Number.isInteger(request.maxSteps) || request.maxSteps < 1 || request.maxSteps > 256)) || (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 120000)) || (request.radius !== undefined && ((!fractionalRadius && !Number.isInteger(request.radius)) || !Number.isFinite(request.radius) || request.radius < (fractionalRadius ? 1.5 : 1) || request.radius > (fractionalRadius ? 4 : 6)))) throw new BodyError('INVALID_ARGUMENT', '物品ID、范围或独立执行预算无效');
  }
  private bind(task: Active, stack: ItemValue): void {
    if (stack.components === undefined || stack.maxStackSize === undefined || !Number.isSafeInteger(stack.maxStackSize) || stack.maxStackSize < 1) throw new BodyError('UNKNOWN_MAX_STACK', '实际物品缺少完整组件或有效堆叠上限，未猜测64');
    if (task.variant) {
      if (!isDeepStrictEqual(task.variant.components, stack.components)) throw new BodyError('VARIANT_CHANGED', '实际拾取物品出现不同组件变体，已停止并保留部分结果');
      if (task.variant.maxStackSize !== stack.maxStackSize) throw new BodyError('MAX_STACK_CHANGED', '实际物品有效堆叠上限已改变；原目标没有重新换算');
      return;
    }
    task.variant = structuredClone(stack); task.progress.variantComponents = structuredClone(stack.components); task.progress.maxStackSize = stack.maxStackSize;
    if (miningOwner(task.borrowed)) return;
    const goal = task.request.count ?? task.request.stacks! * stack.maxStackSize;
    if (!Number.isSafeInteger(goal) || goal > 256) throw new BodyError('UNSUPPORTED', '实际组数解析超过当前有限目标256个，未截断数量');
    task.progress.targetCount = goal;
  }
  private inside(task: Active, position: Position): boolean {
    if (task.name === 'collect-items') return Math.hypot(position.x - task.center.x, position.y - task.center.y, position.z - task.center.z) <= task.radius;
    // Same margin as ServerBody CompanionMiningGuard.DROP_REACH_MARGIN: a mined drop may slide past the
    // player radius; the body still has to stay inside it, and the server also bounds the drop to its source ore.
    if (miningOwner(task.borrowed)) return Math.hypot(position.x - task.center.x, position.y - task.center.y, position.z - task.center.z) <= task.radius + MINING_DROP_MARGIN;
    // The catalog scans block cells from 2 below to 4 above the centre; drops may spawn inside their outer half-cell.
    // A whole tree reaches above that band: up to its highest frozen log (plus the drop's spawn cell).
    const dy = position.y - Math.floor(task.center.y), top = Math.max(5, (task.top ?? -Infinity) - Math.floor(task.center.y) + 2);
    return Math.hypot(position.x - (Math.floor(task.center.x) + 0.5), position.z - (Math.floor(task.center.z) + 0.5)) <= task.radius + 0.75 && dy >= -3 && dy <= top;
  }
  private done(task: Active): boolean { return !miningOwner(task.borrowed) && task.progress.targetCount !== undefined && (task.progress.pickedUpCount ?? 0) >= task.progress.targetCount; }
  private capacity(task: Active, state: Observation): void {
    const main = state.inventory.filter(item => item.slot >= 0 && item.slot < 36);
    if (main.some(item => item.count === 0 && item.id === 'minecraft:air')) return;
    if (task.variant && main.some(item => item.id === task.request.item && isDeepStrictEqual(item.components, task.variant!.components) && item.maxStackSize === task.variant!.maxStackSize && item.count < item.maxStackSize!)) return;
    throw new BodyError('INVENTORY_FULL', '没有已确认的空主背包槽或匹配栈余量，未开始新的挖掘');
  }
  private ingest(task: Active, state: Observation): void {
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts) throw new BodyError('UNSUPPORTED', '身体缺少权威原生拾取收据');
    if (task.cursor < state.pickupOldestCursor || state.pickupCursor < task.cursor) throw new BodyError('PICKUP_GAP', '拾取历史出现缺口；当前获得数量不完整，未自动重试');
    for (const receipt of [...state.pickupReceipts].sort((a, b) => a.seq - b.seq)) {
      if (receipt.seq <= task.cursor) continue;
      if (receipt.seq !== task.cursor + 1 || receipt.seq > state.pickupCursor || receipt.pickedUpCount !== receipt.stack.count || !Number.isSafeInteger(receipt.pickedUpCount) || receipt.pickedUpCount < 1) throw new BodyError('PICKUP_GAP', '拾取收据序列或数量不完整');
      task.cursor = receipt.seq;
      if (receipt.sessionId !== task.context.sessionId || receipt.controlGeneration !== task.context.controlGeneration || receipt.dimension !== task.context.dimension) throw new BodyError('WORLD_CHANGED', '拾取收据不属于当前任务会话／代次');
      task.progress.totalNativePickedUpCount += receipt.pickedUpCount;
      if (task.borrowed && !miningOwner(task.borrowed) && receipt.entityId !== task.borrowed.entityId) {
        // A mode owns the broader policy ledger. Natural collision with another UUID must not
        // become this single-target goal or falsely block an otherwise authorized companion pickup.
        task.progress.unexpectedPickedUpCount += receipt.pickedUpCount;
        task.progress.items.push({ item: receipt.stack.id, count: receipt.pickedUpCount, maxStackSize: receipt.stack.maxStackSize });
        continue;
      }
      try {
        if (miningOwner(task.borrowed) && task.oldGround?.has(receipt.entityId)) throw new BodyError('UNEXPECTED_PICKUP', '自然碰撞收取了子任务开始前的地面物品；不把它当作本轮采矿目标');
        if (!this.inside(task, receipt.position) || (task.name === 'collect-items' && !task.allowed.has(receipt.entityId))) throw new BodyError('OUTSIDE_AUTHORIZATION', '原生拾取了冻结范围之外的掉落；已保留实际结果并停止');
        if (receipt.stack.id !== task.request.item) throw new BodyError('UNEXPECTED_PICKUP', '原生拾取了其他物品，未把它算入目标');
        this.bind(task, receipt.stack);
        task.collectedEntities.set(receipt.entityId, (task.collectedEntities.get(receipt.entityId) ?? 0) + receipt.pickedUpCount);
        task.progress.pickedUpCount! += receipt.pickedUpCount;
        if (receipt.storedIn) (task.progress.storedIn ??= {})[receipt.storedIn] = (task.progress.storedIn[receipt.storedIn] ?? 0) + receipt.pickedUpCount;
        if (!miningOwner(task.borrowed)) task.progress.overage = Math.max(0, task.progress.pickedUpCount! - task.progress.targetCount!);
      } catch (error) {
        task.progress.unexpectedPickedUpCount += receipt.pickedUpCount;
        task.progress.items.push({ item: receipt.stack.id, count: receipt.pickedUpCount, maxStackSize: receipt.stack.maxStackSize });
        throw error;
      }
    }
    if (task.cursor !== state.pickupCursor) throw new BodyError('PICKUP_GAP', '最新拾取游标缺少对应原生收据');
    this.remember(task, 'running', '有限任务运行中');
  }
  private async observe(task: Active): Promise<Observation> {
    this.check(task); const state = await this.body.observe(); this.check(task);
    if (!state.connected || state.health <= 0 || !isDeepStrictEqual(contextOf(state), task.context)) throw new BodyError('WORLD_CHANGED', '采集身体／世界／维度／控制代次发生变化');
    this.ingest(task, state); return state;
  }
  async collectCompanionItem(item: GroundItem, owner: BorrowedPickup): Promise<Operation> {
    if (!this.body.hello.capabilities.includes('companion-pickup')) throw new BodyError('UNSUPPORTED', '身体没有持续拾取玩家边界保护能力');
    const accepted = await this.startOwned('collect-items', { item: item.stack.id, count: item.stack.count, radius: owner.companionGuard.maxDistance, maxSteps: 1, timeoutMs: 10000 }, owner);
    while (this.operations.get(accepted.operationId)?.status === 'running') { owner.check(); await new Promise(resolve => setTimeout(resolve, 50)); }
    owner.check(); return this.operation(accepted.operationId)!;
  }
  /** One observed ore block, without a predicted item yield or an old-ground pickup goal. */
  async mineCompanionBlock(candidate: NearbyResources['candidates'][number], owner: BorrowedMining): Promise<Operation> {
    if (!this.body.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '身体没有持续陪挖原生玩家边界保护能力');
    const item = candidate.kind === 'ore' ? candidate.drops.find(drop => drop.preference !== 'silk_touch')?.item : undefined;
    if (!item || !candidate.visible || !candidate.targetToken || !isDeepStrictEqual(candidate, owner.candidate)) throw new BodyError('INVALID_ARGUMENT', '陪挖只接受一个已观察的明确普通矿石候选');
    const accepted = await this.startOwned('gather-resources', { item, count: 1, radius: owner.companionGuard.maxDistance, maxSteps: 16, timeoutMs: 60000 }, owner);
    while (this.operations.get(accepted.operationId)?.status === 'running') { owner.check(); await new Promise(resolve => setTimeout(resolve, 50)); }
    owner.check(); return this.operation(accepted.operationId)!;
  }
  async start(name: Name, request: Request): Promise<Operation> { return this.startOwned(name, request); }
  private async startOwned(name: Name, request: Request, borrowed?: Borrowed): Promise<Operation> {
    this.validate(request, !!borrowed); this.assertIdle();
    if (!this.body.acquireTask || !this.body.releaseTask) throw new BodyError('UNSUPPORTED', '有限任务需要共享身体写锁');
    borrowed?.check();
    const id = randomUUID(), epoch = this.epoch;
    if (!borrowed) this.body.acquireTask(id);
    const progress: Progress = { stage: 'starting', item: request.item, requestedCount: request.count, requestedStacks: request.stacks, targetCount: request.count, pickedUpCount: 0, overage: 0, minedBlocks: 0, steps: 0, maxSteps: request.maxSteps ?? 64, pickup: 'native-confirmed', quantity: 'newly-picked', totalNativePickedUpCount: 0, unexpectedPickedUpCount: 0, items: [] };
    let task: Active | undefined;
    try {
      // Reserve synchronously even while the initial read or chat acknowledgement is in flight.
      task = { id, taskToken: borrowed?.taskToken ?? id, borrowed, name, epoch, context: {}, center: { x: 0, y: 0, z: 0 }, radius: request.radius ?? 4, deadline: this.now() + (request.timeoutMs ?? 60000), cursor: 0, allowed: new Set(), collectedEntities: new Map(), request, progress } as Active;
      if (miningOwner(borrowed)) { task.deadline = Math.min(task.deadline, borrowed.deadline); delete progress.requestedCount; delete progress.targetCount; progress.limitation = '单块原生破坏与本子任务新拾取分开确认；物品掉落归属未确认，不预测产量。'; }
      this.active = task;
      const state = await this.body.observe(); this.check(task);
      if (!state.connected || state.health <= 0 || state.container) throw new BodyError('BUSY', '需要在线、安全、菜单关闭的身体');
      if (state.pickupCursor === undefined || !state.groundItems || !state.pickupReceipts || state.pickupOldestCursor === undefined) throw new BodyError('UNSUPPORTED', '身体缺少地面物品或权威拾取收据');
      task.context = contextOf(state); task.cursor = state.pickupCursor; task.center = { ...state.position };
      if (borrowed) {
        if (!isDeepStrictEqual(task.context, borrowed.context)) throw new BodyError('WORLD_CHANGED', '内部拾取不属于外层陪伴会话');
        task.center = { ...borrowed.center };
      }
      if (miningOwner(borrowed)) {
        if (state.groundItemsTruncated) throw new BodyError('PICKUP_UNKNOWN', '地面观察截断，不能区分子任务开始前的物品；未开挖');
        task.oldGround = new Set(state.groundItems.map(item => item.entityId));
      }
      let candidates: NearbyResources['candidates'] = [];
      if (name === 'gather-resources') {
        if (miningOwner(borrowed)) candidates = [structuredClone(borrowed.candidate)];
        else {
          const ref = this.references.get(request.resourceRef ?? '');
          if (!ref || ref.expires <= this.now()) throw new BodyError('STALE_REFERENCE', '资源引用过期，请重新观察授权区域');
          if (!isDeepStrictEqual(ref.context, task.context)) throw new BodyError('WORLD_CHANGED', '资源引用不属于当前身体会话');
          task.center = ref.scan.center; task.radius = ref.radius; candidates = structuredClone(ref.scan.candidates);
        }
        const compatible = candidates.filter(candidate => dropPreference(candidate, request.item) !== undefined);
        if (candidates.length > 0 && compatible.length === 0) throw new BodyError('UNSUPPORTED', `冻结资源候选都掉不出 ${request.item}（可能的掉落：${[...new Set(candidates.flatMap(candidate => candidate.drops.map(drop => drop.item)))].join('、') || '无'}；矿石块要精准采集，暂不支持），未开挖`);
        candidates = compatible;
        // Least items one block drops without Fortune (raw copper 2..5); a chance drop counts 0.
        if (compatible.length) task.least = Math.min(...compatible.map(candidate => dropOf(candidate, request.item)!.least));
      }
      const currentTask = task;
      for (const item of state.groundItems) if (item.stack.id === request.item && !miningOwner(borrowed) && (!borrowed || item.entityId === borrowed.entityId) && this.inside(currentTask, item.position)) currentTask.allowed.add(item.entityId);
      if (borrowed && !miningOwner(borrowed)) {
        const prior = borrowed.priorPicked(state); this.check(task);
        const current = state.groundItems.find(item => item.entityId === borrowed.entityId);
        if (!currentTask.allowed.has(borrowed.entityId)) {
          if (current || prior <= 0) throw new BodyError('STALE_TARGET', '内部拾取的单UUID目标已不在当前授权范围，且无已收取证明');
          this.bind(task, borrowed.source.stack); task.progress.pickedUpCount = prior; task.progress.totalNativePickedUpCount = prior;
          task.progress.overage = Math.max(0, prior - task.progress.targetCount!);
          this.finish(task, prior >= task.progress.targetCount! ? 'succeeded' : 'failed', '选定UUID已被原生触碰收取，实际片段已确认', prior < task.progress.targetCount! ? 'TARGET_CONSUMED' : undefined);
          this.active = undefined; return this.operation(id)!;
        }
        // The private activity has no user count promise: freeze the current remainder plus its proven prior portion.
        const goal = current!.stack.count + prior;
        if (!Number.isSafeInteger(goal) || goal > 256) throw new BodyError('UNSUPPORTED', '内部单UUID当前栈超过256，未截断数量');
        task.request = { ...request, count: goal }; task.progress.requestedCount = goal; task.progress.targetCount = goal;
        task.progress.pickedUpCount = prior; task.progress.totalNativePickedUpCount = prior;
        if (prior > 0) this.bind(task, borrowed.source.stack);
      }
      // A newly-picked goal binds its authorized ground source, never a pre-existing inventory variant.
      const actual = state.groundItems.filter(item => currentTask.allowed.has(item.entityId)).map(item => item.stack);
      for (const stack of actual) this.bind(task, stack);
      if (state.groundItemsTruncated) progress.limitation = '地面观察已截断；仅处理已观察授权集合，不能宣称区域内没有其他掉落。';
      if (request.say) {
        const sent = await this.body.act('send-chat', { message: request.say }, task.taskToken); this.check(task);
        if (sent.status !== 'succeeded') throw new BodyError(sent.status === 'unknown' ? 'UNKNOWN' : 'CHAT_FAILED', sent.summary);
      }
      this.remember(task, 'running', '有限任务已受理，程序在固定范围执行；聊天可继续');
      void this.run(task, candidates); return this.operation(id)!;
    } catch (error) {
      if (task && !this.operations.has(id)) this.finish(task, (error as BodyError).code === 'CANCELLED' ? 'cancelled' : 'failed', (error as Error).message, error instanceof BodyError ? error.code : 'UNKNOWN');
      if (!borrowed && this.operations.has(id)) this.events.deliverOperation(this.operations.get(id)!);
      if (this.active?.id === id && !task?.stopPending) this.active = undefined;
      if (!borrowed && !task?.stopPending) this.body.releaseTask(id); throw error;
    }
  }
  /** One guarded native action; force (coming down a pillar) still runs once the goal is reached or the step budget is spent. */
  private async step<N extends ActionName>(task: Active, name: N, args: ActionArguments[N], force = false): Promise<Operation> {
    const state = await this.observe(task); if (!force && this.done(task)) throw new BodyError('TARGET_REACHED', '实际拾取数量已经达到目标');
    if (name === 'pickup-item' && 'entityId' in args && !state.groundItems?.some(item => item.entityId === args.entityId)) {
      if (task.collectedEntities.has(args.entityId)) return { operationId: '', sessionId: task.context.sessionId ?? '', name, status: 'succeeded', summary: '目标已由原生拾取收取' };
      throw new BodyError('STALE_TARGET', '目标掉落实体消失，没有对应原生收据，未发送拾取');
    }
    if (!force && task.progress.steps >= task.progress.maxSteps) throw new BodyError('STEP_BUDGET', '独立动作预算用尽；未追加候选或数量');
    task.progress.steps++; this.check(task);
    const targetId = name === 'pickup-item' && 'entityId' in args ? args.entityId : undefined;
    const beforePicked = targetId ? task.collectedEntities.get(targetId) ?? 0 : 0;
    let op = await this.body.act(name, args, task.taskToken); this.check(task);
    while (op.status === 'running') { await new Promise(resolve => setTimeout(resolve, 50)); this.check(task); op = await this.body.operation(op.operationId); this.check(task); }
    if (op.sessionId !== task.context.sessionId || op.controlGeneration !== task.context.controlGeneration || op.name !== name) throw new BodyError('WORLD_CHANGED', '动作回执不属于当前任务');
    if (name === 'dig-block' && op.status === 'succeeded' && 'targetToken' in args && args.targetToken) { task.progress.minedBlocks++; this.remember(task, 'running', '原生方块挖除已确认；拾取仍按独立收据核验'); }
    const after = await this.observe(task);
    const code = (op.result as { code?: string } | undefined)?.code;
    // Only fully validated new native receipts for this exact UUID can win a known pickup movement race.
    // BLOCKED can also mean damage or hazardous terrain: it never authorizes more work when the goal is incomplete.
    if (targetId && op.status === 'failed' && ['BLOCKED', 'TARGET_MOVED', 'STALE_TARGET'].includes(code ?? '') && (task.collectedEntities.get(targetId) ?? 0) > beforePicked) {
      const consumed = (task.collectedEntities.get(targetId) ?? 0) - beforePicked;
      const gone = after.groundItemsTruncated !== true && !after.groundItems?.some(item => item.entityId === targetId);
      const completeTarget = 'expectedCount' in args && typeof args.expectedCount === 'number' && consumed >= args.expectedCount;
      if (this.done(task) || (code !== 'BLOCKED' && (gone || completeTarget))) {
        task.progress.pickupMovementRaces = (task.progress.pickupMovementRaces ?? 0) + 1;
        task.progress.lastPickupMovementCode = code;
        task.progress.lastPickupMovementSummary = op.summary;
        this.remember(task, 'running', '同一目标原生拾取已确认；移动竞争诊断已保留'); return op;
      }
    }
    if (op.status !== 'succeeded') throw new BodyError(op.status === 'unknown' ? 'UNKNOWN' : op.status === 'cancelled' ? 'CANCELLED' : (op.result as { code?: string } | undefined)?.code ?? 'STEP_FAILED', op.summary);
    return op;
  }
  private async pickups(task: Active): Promise<void> {
    const shaken = new Set<string>();
    let merged = 0;
    pickupLoop: for (;;) {
      const state = await this.observe(task); if (this.done(task)) return;
      const items = state.groundItems ?? [];
      if (miningOwner(task.borrowed) && state.groundItemsTruncated) throw new BodyError('PICKUP_UNKNOWN', '采矿后的地面观察已截断，未声称掉落已完整收取');
      // A gathered drop caught high in leaves cannot be walked to: leave it rather than fail the whole goal.
      let item = items.find(item => item.stack.id === task.request.item && !task.oldGround?.has(item.entityId) && this.inside(task, item.position) && (task.name === 'gather-resources' || task.allowed.has(item.entityId)) && item.visibility === 'visible'
        && (task.name !== 'gather-resources' || miningOwner(task.borrowed) || item.position.y <= state.position.y + 2));
      if (!item) {
        if (await this.shake(task, state, items, shaken)) continue;
        return;
      }
      this.capacity(task, state);
      // Newly mined drops may still be falling. Wait within a fixed budget before binding a movement guard.
      const settleBy = Math.min(task.deadline, this.now() + 2500);
      let stableSince: number | undefined = item.onGround === false ? undefined : this.now();
      let stableSamples = 0;
      let anchor = { ...item.position };
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const settled = await this.observe(task); if (this.done(task)) return;
        const next = settled.groundItems?.find(next => next.entityId === item!.entityId);
        if (!next) {
          if (task.collectedEntities.has(item.entityId)) continue pickupLoop;
          throw new BodyError('STALE_TARGET', '目标掉落实体消失，没有充分原生收据证明已拾取');
        }
        item = next;
        const moved = Math.hypot(item.position.x - anchor.x, item.position.y - anchor.y, item.position.z - anchor.z) > 0.03;
        if (item.onGround === false || moved) { stableSince = undefined; stableSamples = 0; anchor = { ...item.position }; }
        else {
          stableSince ??= this.now(); stableSamples++;
          // Equal snapshots may be the same server tick or an airborne apex. Require sustained landing.
          const stableMs = item.onGround === true ? 200 : 400;
          const samples = item.onGround === true ? 4 : 8;
          if (stableSamples >= samples && this.now() - stableSince >= stableMs) break;
        }
        if (this.now() >= settleBy) throw new BodyError('TARGET_MOVED', '掉落位置在有限等待内未稳定，未自动重试追逐');
      }
      this.bind(task, item.stack); task.allowed.add(item.entityId); task.progress.stage = 'picking-up';
      const before = task.progress.pickedUpCount;
      // Drops of the same item lying together merge natively (two logs become one stack of 2); the refusal
      // happens before any pickup, so look again rather than fail the whole goal.
      try {
      await this.step(task, 'pickup-item', { entityId: item.entityId, expectedItem: item.stack.id, expectedCount: item.stack.count, expectedComponents: item.stack.components!, expectedMaxStackSize: item.stack.maxStackSize, ...(task.borrowed ? { companionGuard: task.borrowed.companionGuard } : {}), ...(miningOwner(task.borrowed) ? { resourceTargetToken: task.borrowed.candidate.targetToken } : {}), timeoutMs: Math.min(30000, Math.max(500, task.deadline - this.now())) });
      } catch (error) { if (error instanceof BodyError && error.code === 'STALE_ITEM' && task.progress.pickedUpCount === before && ++merged <= 3) continue; throw error; }
      if (task.progress.pickedUpCount === before) throw new BodyError('PICKUP_UNKNOWN', '动作没有对应新增原生拾取收据，未依据实体消失或背包净变化猜测成功');
      if (!this.done(task) && (await this.observe(task)).groundItems?.some(next => next.entityId === item.entityId)) throw new BodyError('INVENTORY_FULL', '目标实体仍有余量；未自动重复拾取，请检查背包空间');
    }
  }
  /**
   * A gathered drop resting on leaves too high to walk to (a log chopped from a tree top): break the leaves
   * its small box rests on or is wedged against (its own level and the one below, a neighbour column too
   * when it sits on the edge) when they are in reach, so it falls to where it can be picked up. Leaves are
   * never gathered; each drop is tried once. Returns whether a leaf was broken.
   */
  private async shake(task: Active, state: Observation, items: NonNullable<Observation['groundItems']>, shaken: Set<string>): Promise<boolean> {
    if (task.name !== 'gather-resources' || miningOwner(task.borrowed)) return false;
    for (const item of items) {
      if (item.stack.id !== task.request.item || task.oldGround?.has(item.entityId) || shaken.has(item.entityId) || item.position.y <= state.position.y + 2 || !this.inside(task, item.position)) continue;
      shaken.add(item.entityId);
      const p = item.position, span = (v: number) => [...new Set([Math.floor(v - 0.13), Math.floor(v + 0.13)])];
      let broke = false;
      for (const y of [...new Set([Math.floor(p.y - 0.05), Math.floor(p.y)])]) for (const x of span(p.x)) for (const z of span(p.z)) {
        const at = { x, y, z };
        if (!inReach(state.position, at)) continue;
        const cell = await this.cell(task, at);
        if (!isLeaves(cell?.id)) continue;
        task.progress.stage = 'shaking-leaves';
        try { await this.digLeaf(task, at, cell!); }
        catch (error) { if (error instanceof BodyError && reachRefusals.has(error.code)) continue; throw error; }
        task.progress.leavesShaken = (task.progress.leavesShaken ?? 0) + 1; broke = true;
      }
      if (!broke) continue;
      await new Promise(resolve => setTimeout(resolve, 300));
      return true;
    }
    return false;
  }
  /** Eat between blocks if needed, then assess, prepare and select the tool for one candidate; returns the fresh state. */
  private async prepareFor(task: Active, candidate: Candidate, state: Observation): Promise<Observation> {
    const policy = this.survivalPolicy?.();
    const borrowed = { taskToken: task.taskToken, context: task.context, check: () => {
      this.check(task);
      if (policy && policy.revision !== this.survivalPolicy?.().revision) throw new BodyError('CANCELLED', '工具／本能策略已变化，旧子步骤未继续');
    } };
    if (this.survival && policy?.armed && policy.autoEat && this.body.survivalState) {
      const needs = await this.body.survivalState(); this.check(task);
      if (selectFood(needs, policy).slot !== undefined) {
        task.progress.stage = 'eating-between-blocks';
        const meal = await this.survival.eat({ policy }, borrowed); this.check(task);
        if (meal.status !== 'succeeded') throw new BodyError(meal.status === 'unknown' ? 'UNKNOWN' : 'MEAL_FAILED', meal.summary);
        state = await this.observe(task);
      }
    }
    let slot = candidate.recommendedToolSlot;
    const preference = dropPreference(candidate, task.request.item)!;
    if (this.survival && this.body.assessTool) {
      const assessed = await this.body.assessTool({ ...candidate.position, expectedBlock: candidate.id, policy: policy?.toolPolicy, minRemainingDurability: policy?.minRemainingDurability,
        dropPreference: preference });
      this.check(task);
      if (!isDeepStrictEqual(contextOf(assessed), task.context)) throw new BodyError('WORLD_CHANGED', '工具评估不属于采集授权代次');
      const choice = assessed.candidates.find(tool => tool.slot === assessed.recommendedSlot);
      if (!choice || choice.eligible !== true || choice.componentsComplete === false || choice.components === undefined) throw new BodyError('WRONG_TOOL', '没有已核验且满足掉落／耐久策略的工具');
      if (candidate.kind === 'ore' && choice.dropEffectsKnown !== true) throw new BodyError('UNKNOWN', '矿石工具的掉落效果尚未核验，未开挖或自动重试');
      if (candidate.kind === 'ore' && (!Number.isInteger(choice.silkTouch) || choice.silkTouch! < 0)) throw new BodyError('UNKNOWN', '矿石工具缺少明确精准采集评估，未开挖');
      if (preference === 'no_silk_touch' && choice.silkTouch! > 0 || preference === 'silk_touch' && choice.silkTouch === 0) throw new BodyError('WRONG_TOOL', '推荐工具与目标掉落冲突，未开挖');
      task.progress.stage = 'preparing-tool';
      if (choice.count === 0 && choice.id === 'minecraft:air' && choice.slot <= 8) {
        await this.step(task, 'select-slot', { slot: choice.slot, expectedItem: choice.id, expectedCount: 0, expectedComponents: choice.components });
      } else {
        const prepared = await this.survival.prepareItem({ slot: choice.slot, expected: choice, ...(choice.slot > 8 ? { targetSlot: state.selectedSlot ?? 0 } : {}) }, borrowed);
        this.check(task);
        if (prepared.status !== 'succeeded') throw new BodyError(prepared.status === 'unknown' ? 'UNKNOWN' : 'WRONG_TOOL', prepared.summary);
      }
      state = await this.observe(task); slot = state.selectedSlot;
    } else {
      if (candidate.kind === 'ore') throw new BodyError('UNSUPPORTED', '矿石采集需要完整工具评估与准备能力，未仅依据基础快捷栏资格开挖');
      if (slot === undefined || !candidate.suitableToolSlots.includes(slot)) throw new BodyError('WRONG_TOOL', '本次授权资源没有合适快捷栏工具，未挖掘');
    }
    if (slot === undefined) throw new BodyError('WRONG_TOOL', '准备工具后没有权威选槽状态');
    const tool = state.inventory.find(item => item.slot === slot);
    if (!tool || tool.components === undefined) throw new BodyError('WRONG_TOOL', '缺少完整原生工具快照，未挖掘');
    task.progress.stage = 'selecting-tool';
    await this.step(task, 'select-slot', { slot, expectedItem: tool.id, expectedCount: tool.count, expectedComponents: tool.components, ...(tool.maxStackSize !== undefined ? { expectedMaxStackSize: tool.maxStackSize } : {}) });
    return state;
  }
  /** Blocks dug since the last pickup already cover the rest of the goal at the item's least native yield per block. */
  private covered(task: Active, pending: number): boolean {
    const target = task.progress.targetCount;
    return target === undefined ? pending >= 1 : pending * (task.least ?? 1) >= target - (task.progress.pickedUpCount ?? 0);
  }
  /**
   * Dig every frozen candidate reachable from where the body stands, nearest first, until the dug blocks
   * cover the goal. A block the native reach or line-of-sight check refuses is skipped from this spot.
   */
  private async digReachable(task: Active, remaining: Candidate[], skipped: Set<string>, already: number): Promise<number> {
    let dug = 0;
    for (;;) {
      if (this.done(task) || already + dug > 0 && this.covered(task, already + dug)) return dug;
      let state = await this.observe(task);
      const feet = state.position;
      const candidate = remaining.filter(next => !skipped.has(next.targetToken) && inReach(feet, next.position))
        .sort((a, b) => eyeDistance(feet, a.position) - eyeDistance(feet, b.position))[0];
      if (!candidate) return dug;
      state = await this.prepareFor(task, candidate, state);
      task.progress.stage = 'digging';
      try {
        await this.step(task, 'dig-block', { ...candidate.position, expectedBlock: candidate.id, expectedProperties: candidate.properties, targetToken: candidate.targetToken, timeoutMs: Math.min(30000, Math.max(500, task.deadline - this.now())) });
      } catch (error) {
        if (error instanceof BodyError && reachRefusals.has(error.code)) { skipped.add(candidate.targetToken); continue; }
        throw error;
      }
      remaining.splice(remaining.indexOf(candidate), 1); dug++;
    }
  }
  private climbable(): boolean { return ['pillar-up', 'move-to-position', 'swap-inventory'].every(cap => this.body.hello.capabilities.includes(cap)); }
  private async cell(task: Active, position: Position): Promise<{ id?: string; properties?: Record<string, unknown> } | undefined> {
    const state = await this.body.observe(position); this.check(task); this.ingest(task, state);
    return state.block?.state === 'loaded' ? { id: state.block.id, properties: state.block.properties } : undefined;
  }
  /**
   * Where to stand to climb to a high candidate: under it when its own column is open down to a floor at
   * the current level (a trunk whose lower logs are already cut), otherwise beside it. Undefined: no spot.
   */
  private async pillarSpot(task: Active, target: Candidate): Promise<Position | undefined> {
    const state = await this.observe(task), ground = feetLevel(state.position), t = target.position;
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: t.x + dx, z: t.z + dz, own: false }))
      .sort((a, b) => Math.hypot(a.x + 0.5 - state.position.x, a.z + 0.5 - state.position.z) - Math.hypot(b.x + 0.5 - state.position.x, b.z + 0.5 - state.position.z));
    for (const column of [{ x: t.x, z: t.z, own: true }, ...sides]) {
      const top = column.own ? t.y - 1 : t.y;
      let floor: number | undefined;
      for (let y = top; y >= ground - 2; y--) {
        const cell = await this.cell(task, { x: column.x, y, z: column.z });
        if (!cell) break;
        if (!openCells.has(cell.id ?? '')) { floor = y; break; }
      }
      if (floor === undefined || top - floor < 2 || Math.abs(floor + 1 - ground) > 1) continue;
      const footing = await this.cell(task, { x: column.x, y: floor, z: column.z });
      if (!footing?.id || /lava|water|magma|cactus|fire|powder_snow/.test(footing.id)) continue;
      return { x: column.x, y: floor + 1, z: column.z };
    }
    return undefined;
  }
  /** Room to rise one block: the cell above the head is open, or leaves in the way are broken (and not gathered). */
  private async headroom(task: Active, feet: Position): Promise<boolean> {
    const above = { x: Math.floor(feet.x), y: feetLevel(feet) + 2, z: Math.floor(feet.z) };
    const cell = await this.cell(task, above);
    if (!cell) return false;
    if (openCells.has(cell.id ?? '')) return true;
    if (!isLeaves(cell.id)) return false;
    task.progress.stage = 'clearing-leaves';
    await this.digLeaf(task, above, cell);
    return true;
  }
  /**
   * Break one leaf block. Natural leaves decay on their own once the trunk is gone, so one may vanish while it
   * is being broken (the body reports STALE_BLOCK): if the cell is no longer leaves, it is out of the way all the same.
   */
  private async digLeaf(task: Active, at: Position, cell: { id?: string; properties?: Record<string, unknown> }): Promise<void> {
    // Cutting the trunk also changes the leaves' distance property: a leaf still there is retried with its new state.
    for (let attempt = 1; ; attempt++) {
      try { await this.step(task, 'dig-block', { ...at, expectedBlock: cell.id!, expectedProperties: cell.properties ?? {}, timeoutMs: 10000 }, true); return; }
      catch (error) {
        if (!(error instanceof BodyError && error.code === 'STALE_BLOCK')) throw error;
        const now = await this.cell(task, at);
        if (!now || !isLeaves(now.id)) { task.progress.leavesDecayed = (task.progress.leavesDecayed ?? 0) + 1; return; }
        if (attempt >= 3) throw error;
        cell = now;
      }
    }
  }
  /** Select the recommended hotbar tool for digging a pillar block back out; the bare hand also works. */
  private async pillarTool(task: Active, position: Position, block: string): Promise<void> {
    if (!this.body.assessTool) return;
    const policy = this.survivalPolicy?.();
    const assessed = await this.body.assessTool({ ...position, expectedBlock: block, policy: policy?.toolPolicy, minRemainingDurability: policy?.minRemainingDurability, dropPreference: 'any' });
    this.check(task);
    const choice = assessed.candidates.find(tool => tool.slot === assessed.recommendedSlot);
    if (!choice || choice.eligible !== true || choice.slot > 8 || choice.components === undefined) return;
    await this.step(task, 'select-slot', { slot: choice.slot, expectedItem: choice.id, expectedCount: choice.count, expectedComponents: choice.components }, true);
  }
  private pillarHost(task: Active): PillarHost {
    return {
      observe: async block => { const state = await this.body.observe(block); this.check(task); this.ingest(task, state); return state; },
      run: async (name, args) => (await this.step(task, name, args, true)).result,
      prepareDig: (position, block) => this.pillarTool(task, position, block),
    };
  }
  /**
   * Climb to a candidate too high to reach from the ground: stand under or beside it, then repeatedly dig
   * every candidate in reach and rise one block on a pillar while more of this tree (candidates near the
   * column) is above. Coming down digs the pillar back out top first, also after an early stop, unless
   * the task was halted. Returns the candidates dug, whose drops still need collecting.
   */
  private async climb(task: Active, remaining: Candidate[], target: Candidate): Promise<number> {
    task.progress.stage = 'finding-pillar-spot';
    const spot = await this.pillarSpot(task, target);
    if (!spot) { remaining.splice(remaining.indexOf(target), 1); task.progress.unreachable = (task.progress.unreachable ?? 0) + 1; return 0; }
    task.progress.stage = 'walking-to-pillar-spot';
    await this.step(task, 'move-to-position', { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5, tolerance: 0.3, timeoutMs: Math.min(20000, Math.max(500, task.deadline - this.now())) });
    const purpose: PillarPurpose = target.kind === 'log' ? 'log' : 'other';
    const host = this.pillarHost(task), placed: PillarBlock[] = [];
    let dug = 0, failure: unknown;
    try {
      for (;;) {
        dug += await this.digReachable(task, remaining, new Set(), dug);
        if (this.done(task) || dug > 0 && this.covered(task, dug) || placed.length >= MAX_PILLAR) break;
        const state = await this.observe(task), level = feetLevel(state.position);
        const above = remaining.filter(next => next.position.y > level && Math.hypot(next.position.x - spot.x, next.position.z - spot.z) <= CLIMB_SPREAD);
        if (above.length === 0) break;
        if (pillarBlockCount(state, purpose) === 0) { task.progress.limitation = '背包里没有能垫脚的方块，够不着的部分没有砍／挖'; break; }
        if (!(await this.headroom(task, state.position))) break;
        task.progress.stage = 'pillaring-up';
        const block = await pillarUp(host, purpose);
        placed.push(block); task.progress.pillarPlaced = (task.progress.pillarPlaced ?? 0) + 1;
        // Standing on a gathered log spends it; digging the pillar back out picks it up again.
        if (block.item === task.request.item) task.progress.pickedUpCount = (task.progress.pickedUpCount ?? 0) - 1;
      }
    } catch (error) { failure = error; }
    if (!(failure instanceof BodyError && haltCodes.has(failure.code))) {
      task.progress.stage = 'pillaring-down';
      for (const block of [...placed].reverse()) { await pillarDown(host, block); task.progress.pillarRecovered = (task.progress.pillarRecovered ?? 0) + 1; }
    }
    if (failure) throw failure;
    if (dug === 0 && remaining.includes(target)) { remaining.splice(remaining.indexOf(target), 1); task.progress.unreachable = (task.progress.unreachable ?? 0) + 1; }
    return dug;
  }
  /**
   * Dig every frozen candidate reachable from where the body stands (nearest first) before collecting the
   * drops in one pass, then walk to the nearest remaining candidate. A reachable-looking block that the
   * native reach or line-of-sight check refuses is left for a later approach, never retried from the same spot.
   */
  private async run(task: Active, candidates: NearbyResources['candidates']): Promise<void> {
    try {
      if (!miningOwner(task.borrowed)) await this.pickups(task);
      const remaining = [...candidates], skipped = new Set<string>();
      if (candidates.length) task.top = Math.max(...candidates.map(candidate => candidate.position.y));
      let pending = 0;
      while (remaining.length > 0 && !this.done(task)) {
        let state = await this.observe(task);
        if (this.done(task)) break;
        this.capacity(task, state);
        if (pending > 0 && this.covered(task, pending)) { await this.pickups(task); pending = 0; continue; }
        // Companion mining approaches its single block first: the approach also enforces the live companion radius.
        if (!miningOwner(task.borrowed)) {
          const dug = await this.digReachable(task, remaining, skipped, pending);
          pending += dug; if (dug > 0) continue;
        }
        if (remaining.length === 0 || this.done(task)) break;
        if (pending > 0) { await this.pickups(task); pending = 0; continue; }
        state = await this.observe(task);
        const candidate = nearest(remaining, state.position);
        const high = !miningOwner(task.borrowed) && this.climbable() && candidate.position.y - feetLevel(state.position) >= CLIMB_ABOVE;
        // A tree is climbed straight away; anything else high may sit on a slope, so walk up first and climb when no spot reaches it.
        if (high && candidate.kind === 'log') { pending += await this.climb(task, remaining, candidate); continue; }
        state = await this.prepareFor(task, candidate, state);
        task.progress.stage = 'approaching-resource';
        try {
          await this.step(task, 'approach-resource', { targetToken: candidate.targetToken, timeoutMs: Math.min(20000, Math.max(500, task.deadline - this.now())) });
        } catch (error) {
          if (high && error instanceof BodyError && !haltCodes.has(error.code) && !unknownCodes.has(error.code)) { pending += await this.climb(task, remaining, candidate); continue; }
          throw error;
        }
        skipped.clear();
        task.progress.stage = 'digging';
        await this.step(task, 'dig-block', { ...candidate.position, expectedBlock: candidate.id, expectedProperties: candidate.properties, targetToken: candidate.targetToken, timeoutMs: Math.min(30000, Math.max(500, task.deadline - this.now())) });
        remaining.splice(remaining.indexOf(candidate), 1); pending++;
      }
      if (pending > 0) await this.pickups(task);
      await this.observe(task);
      if (miningOwner(task.borrowed)) {
        if (task.progress.minedBlocks !== 1) throw new BodyError('UNKNOWN', '单块原生破坏未完整确认，未自动重试');
        this.finish(task, 'succeeded', '单块原生破坏已确认；新拾取按独立收据记录，掉落归属未确认'); return;
      }
      if (!this.done(task)) {
        const final = await this.observe(task);
        const stuck = (final.groundItems ?? []).filter(item => item.stack.id === task.request.item && !task.oldGround?.has(item.entityId) && item.position.y > final.position.y + 2 && this.inside(task, item.position))
          .reduce((sum, item) => sum + item.stack.count, 0);
        if (stuck > 0) { task.progress.stuckHigh = stuck; throw new BodyError('INSUFFICIENT_RESOURCES', `候选都挖完了，但有 ${stuck} 个掉落卡在高处（多半在树叶上）够不着，没捡到；天然树叶过一会儿会腐烂，掉下来后可以再捡`); }
        throw new BodyError('INSUFFICIENT_RESOURCES', '冻结候选已用完，实际拾取数量不足；未重新向外搜索');
      }
      this.finish(task, 'succeeded', task.progress.overage ? '目标已达到；原生一次拾取产生额外数量，已如实记录' : '实际原生拾取数量已达到明确目标');
    } catch (error) {
      const code = error instanceof BodyError ? error.code : 'UNKNOWN';
      if (code === 'TARGET_REACHED') this.finish(task, 'succeeded', '实际原生拾取数量已达到明确目标');
      else {
        if (!task.borrowed && task.epoch === this.epoch && (unknownCodes.has(code) || code === 'STEP_BUDGET')) {
          task.stopPending = true;
          const mealStop = this.survival?.cancel();
          try {
            const stopped = await this.body.stop();
            if (stopped.stopped === true && task.epoch === this.epoch) { task.stopPending = false; if (mealStop) this.survival!.stopped(mealStop); }
          } catch {}
        }
        this.finish(task, code === 'CANCELLED' ? 'cancelled' : unknownCodes.has(code) ? 'unknown' : 'failed', (error as Error).message, code);
      }
    } finally {
      // A settled JS runner is not proof that the native writer stopped.
      if (!task.stopPending) { if (!task.borrowed) this.body.releaseTask?.(task.taskToken); if (this.active?.id === task.id) this.active = undefined; }
    }
  }
  private remember(task: Active, status: Operation['status'], summary: string): Operation {
    const op = { operationId: task.id, name: task.name, sessionId: task.context.sessionId ?? '', controlGeneration: task.context.controlGeneration, status, summary, result: structuredClone(task.progress) };
    this.operations.set(task.id, op); if (this.operations.size > 64) this.operations.delete(this.operations.keys().next().value!);
    if (miningOwner(task.borrowed)) task.borrowed.onProgress?.(structuredClone(op));
    return op;
  }
  private finish(task: Active, status: Operation['status'], summary: string, code?: string): void {
    if (this.operations.get(task.id)?.status !== 'running' && this.operations.has(task.id)) return;
    task.progress.stage = status === 'succeeded' ? 'done' : status; task.progress.code = code;
    if (status === 'unknown' || status === 'cancelled') { task.progress.lastConfirmedPickedUpCount = task.progress.pickedUpCount; delete task.progress.pickedUpCount; task.progress.pickup = 'partial-or-unknown'; }
    const operation = this.remember(task, status, summary);
    if (!task.borrowed) this.events.notifyOperation(operation);
  }
}
