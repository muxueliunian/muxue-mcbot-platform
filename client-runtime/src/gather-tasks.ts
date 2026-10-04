import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BodyError, type Body, type Observation, type Operation, type ItemValue, type Position, type NearbyResources, type ActionName, type ActionArguments, type GroundItem, type CompanionGuard } from './body.js';
import type { EventJournal } from './events.js';
import { selectFood, type SurvivalTasks } from './survival-tasks.js';
import type { SurvivalPolicy } from './survival-reflexes.js';

type Context = Pick<Observation, 'instanceId' | 'sessionId' | 'worldId' | 'dimension' | 'controlGeneration'>;
type Request = { resourceRef?: string; item: string; count?: number; stacks?: number; radius?: number; say?: string; maxSteps?: number; timeoutMs?: number };
type Name = 'gather-resources' | 'collect-items';
export interface BorrowedPickup { taskToken: string; context: Context; entityId: string; source: GroundItem; center: Position; companionGuard: CompanionGuard; check: () => void; priorPicked: (state: Observation) => number }
type Reference = { context: Context; expires: number; scan: NearbyResources; radius: number };
type Progress = { stage: string; item: string; requestedCount?: number; requestedStacks?: number; targetCount?: number; maxStackSize?: number; pickedUpCount?: number; lastConfirmedPickedUpCount?: number; overage: number; minedBlocks: number; steps: number; maxSteps: number; pickup: 'native-confirmed' | 'partial-or-unknown'; quantity: 'newly-picked'; totalNativePickedUpCount: number; unexpectedPickedUpCount: number; items: Array<{ item: string; count: number; maxStackSize?: number }>; code?: string; variantComponents?: ItemValue['components']; limitation?: string; pickupMovementRaces?: number; lastPickupMovementCode?: string; lastPickupMovementSummary?: string };
type Active = { id: string; taskToken: string; borrowed?: BorrowedPickup; name: Name; epoch: number; context: Context; center: Position; radius: number; deadline: number; cursor: number; allowed: Set<string>; collectedEntities: Map<string, number>; variant?: ItemValue; request: Request; progress: Progress; cancelled?: boolean; stopPending?: boolean };
const contextOf = (state: Context): Context => ({ instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration });
const unknownCodes = new Set(['UNKNOWN', 'PICKUP_GAP', 'PICKUP_UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'STALE_CONTROL', 'TRANSPORT_LOST', 'INVALID_RESPONSE', 'LEASE_EXPIRED', 'TASK_TIMEOUT', 'STOP_UNCONFIRMED']);

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
      limitation: '只限本次已加载、可见的原版石料／原木候选和固定区域；不能识别人工建筑或天然树，也不支持任意模组矿石。引用30秒内提交；不补扫扩展候选，不挖路或搭桥。' };
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
    const goal = task.request.count ?? task.request.stacks! * stack.maxStackSize;
    if (!Number.isSafeInteger(goal) || goal > 256) throw new BodyError('UNSUPPORTED', '实际组数解析超过当前有限目标256个，未截断数量');
    task.progress.targetCount = goal;
  }
  private inside(task: Active, position: Position): boolean {
    if (task.name === 'collect-items') return Math.hypot(position.x - task.center.x, position.y - task.center.y, position.z - task.center.z) <= task.radius;
    // The catalog scans block cells at y +/-2; drops may spawn inside their outer half-cell.
    return Math.hypot(position.x - (Math.floor(task.center.x) + 0.5), position.z - (Math.floor(task.center.z) + 0.5)) <= task.radius + 0.75 && Math.abs(position.y - Math.floor(task.center.y)) <= 3;
  }
  private done(task: Active): boolean { return task.progress.targetCount !== undefined && (task.progress.pickedUpCount ?? 0) >= task.progress.targetCount; }
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
      if (task.borrowed && receipt.entityId !== task.borrowed.entityId) {
        // A mode owns the broader policy ledger. Natural collision with another UUID must not
        // become this single-target goal or falsely block an otherwise authorized companion pickup.
        task.progress.unexpectedPickedUpCount += receipt.pickedUpCount;
        task.progress.items.push({ item: receipt.stack.id, count: receipt.pickedUpCount, maxStackSize: receipt.stack.maxStackSize });
        continue;
      }
      try {
        if (!this.inside(task, receipt.position) || (task.name === 'collect-items' && !task.allowed.has(receipt.entityId))) throw new BodyError('OUTSIDE_AUTHORIZATION', '原生拾取了冻结范围之外的掉落；已保留实际结果并停止');
        if (receipt.stack.id !== task.request.item) throw new BodyError('UNEXPECTED_PICKUP', '原生拾取了其他物品，未把它算入目标');
        this.bind(task, receipt.stack);
        task.collectedEntities.set(receipt.entityId, (task.collectedEntities.get(receipt.entityId) ?? 0) + receipt.pickedUpCount);
        task.progress.pickedUpCount! += receipt.pickedUpCount;
        task.progress.overage = Math.max(0, task.progress.pickedUpCount! - task.progress.targetCount!);
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
  async start(name: Name, request: Request): Promise<Operation> { return this.startOwned(name, request); }
  private async startOwned(name: Name, request: Request, borrowed?: BorrowedPickup): Promise<Operation> {
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
      this.active = task;
      const state = await this.body.observe(); this.check(task);
      if (!state.connected || state.health <= 0 || state.container) throw new BodyError('BUSY', '需要在线、安全、菜单关闭的身体');
      if (state.pickupCursor === undefined || !state.groundItems || !state.pickupReceipts || state.pickupOldestCursor === undefined) throw new BodyError('UNSUPPORTED', '身体缺少地面物品或权威拾取收据');
      task.context = contextOf(state); task.cursor = state.pickupCursor; task.center = { ...state.position };
      if (borrowed) {
        if (!isDeepStrictEqual(task.context, borrowed.context)) throw new BodyError('WORLD_CHANGED', '内部拾取不属于外层陪伴会话');
        task.center = { ...borrowed.center };
      }
      let candidates: NearbyResources['candidates'] = [];
      if (name === 'gather-resources') {
        const ref = this.references.get(request.resourceRef ?? '');
        if (!ref || ref.expires <= this.now()) throw new BodyError('STALE_REFERENCE', '资源引用过期，请重新观察授权区域');
        if (!isDeepStrictEqual(ref.context, task.context)) throw new BodyError('WORLD_CHANGED', '资源引用不属于当前身体会话');
        task.center = ref.scan.center; task.radius = ref.radius; candidates = structuredClone(ref.scan.candidates);
      }
      const currentTask = task;
      for (const item of state.groundItems) if (item.stack.id === request.item && (!borrowed || item.entityId === borrowed.entityId) && this.inside(currentTask, item.position)) currentTask.allowed.add(item.entityId);
      if (borrowed) {
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
      if (this.active?.id === id) this.active = undefined;
      if (!borrowed) this.body.releaseTask(id); throw error;
    }
  }
  private async step<N extends ActionName>(task: Active, name: N, args: ActionArguments[N]): Promise<void> {
    const state = await this.observe(task); if (this.done(task)) throw new BodyError('TARGET_REACHED', '实际拾取数量已经达到目标');
    if (name === 'pickup-item' && 'entityId' in args && !state.groundItems?.some(item => item.entityId === args.entityId)) {
      if (task.collectedEntities.has(args.entityId)) return;
      throw new BodyError('STALE_TARGET', '目标掉落实体消失，没有对应原生收据，未发送拾取');
    }
    if (task.progress.steps >= task.progress.maxSteps) throw new BodyError('STEP_BUDGET', '独立动作预算用尽；未追加候选或数量');
    task.progress.steps++; this.check(task);
    const targetId = name === 'pickup-item' && 'entityId' in args ? args.entityId : undefined;
    const beforePicked = targetId ? task.collectedEntities.get(targetId) ?? 0 : 0;
    let op = await this.body.act(name, args, task.taskToken); this.check(task);
    while (op.status === 'running') { await new Promise(resolve => setTimeout(resolve, 50)); this.check(task); op = await this.body.operation(op.operationId); this.check(task); }
    if (op.sessionId !== task.context.sessionId || op.controlGeneration !== task.context.controlGeneration || op.name !== name) throw new BodyError('WORLD_CHANGED', '动作回执不属于当前任务');
    if (name === 'dig-block' && op.status === 'succeeded') { task.progress.minedBlocks++; this.remember(task, 'running', '原生方块挖除已确认；拾取仍按独立收据核验'); }
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
        this.remember(task, 'running', '同一目标原生拾取已确认；移动竞争诊断已保留'); return;
      }
    }
    if (op.status !== 'succeeded') throw new BodyError(op.status === 'unknown' ? 'UNKNOWN' : op.status === 'cancelled' ? 'CANCELLED' : (op.result as { code?: string } | undefined)?.code ?? 'STEP_FAILED', op.summary);
  }
  private async pickups(task: Active): Promise<void> {
    pickupLoop: for (;;) {
      const state = await this.observe(task); if (this.done(task)) return;
      const items = state.groundItems ?? [];
      let item = items.find(item => item.stack.id === task.request.item && this.inside(task, item.position) && (task.name === 'gather-resources' || task.allowed.has(item.entityId)) && item.visibility === 'visible');
      if (!item) return;
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
      await this.step(task, 'pickup-item', { entityId: item.entityId, expectedItem: item.stack.id, expectedCount: item.stack.count, expectedComponents: item.stack.components!, expectedMaxStackSize: item.stack.maxStackSize, ...(task.borrowed ? { companionGuard: task.borrowed.companionGuard } : {}), timeoutMs: Math.min(30000, Math.max(500, task.deadline - this.now())) });
      if (task.progress.pickedUpCount === before) throw new BodyError('PICKUP_UNKNOWN', '动作没有对应新增原生拾取收据，未依据实体消失或背包净变化猜测成功');
      if (!this.done(task) && (await this.observe(task)).groundItems?.some(next => next.entityId === item.entityId)) throw new BodyError('INVENTORY_FULL', '目标实体仍有余量；未自动重复拾取，请检查背包空间');
    }
  }
  private async run(task: Active, candidates: NearbyResources['candidates']): Promise<void> {
    try {
      await this.pickups(task);
      for (const candidate of candidates) {
        if (this.done(task)) break;
        let state = await this.observe(task);
        this.capacity(task, state);
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
        if (this.survival && this.body.assessTool) {
          const assessed = await this.body.assessTool({ ...candidate.position, expectedBlock: candidate.id, policy: policy?.toolPolicy, minRemainingDurability: policy?.minRemainingDurability,
            dropPreference: ['minecraft:stone', 'minecraft:deepslate'].includes(candidate.id) && task.request.item !== candidate.id ? 'no_silk_touch' : 'any' });
          this.check(task);
          if (!isDeepStrictEqual(contextOf(assessed), task.context)) throw new BodyError('WORLD_CHANGED', '工具评估不属于采集授权代次');
          const choice = assessed.candidates.find(tool => tool.slot === assessed.recommendedSlot);
          if (!choice || choice.eligible !== true || choice.componentsComplete === false || choice.components === undefined) throw new BodyError('WRONG_TOOL', '没有已核验且满足掉落／耐久策略的工具');
          task.progress.stage = 'preparing-tool';
          if (choice.count === 0 && choice.id === 'minecraft:air' && choice.slot <= 8) {
            await this.step(task, 'select-slot', { slot: choice.slot, expectedItem: choice.id, expectedCount: 0, expectedComponents: choice.components });
          } else {
            const prepared = await this.survival.prepareItem({ slot: choice.slot, expected: choice, ...(choice.slot > 8 ? { targetSlot: state.selectedSlot ?? 0 } : {}) }, borrowed);
            this.check(task);
            if (prepared.status !== 'succeeded') throw new BodyError(prepared.status === 'unknown' ? 'UNKNOWN' : 'WRONG_TOOL', prepared.summary);
          }
          state = await this.observe(task); slot = state.selectedSlot;
        } else if (slot === undefined || !candidate.suitableToolSlots.includes(slot)) throw new BodyError('WRONG_TOOL', '本次授权资源没有合适快捷栏工具，未挖掘');
        if (slot === undefined) throw new BodyError('WRONG_TOOL', '准备工具后没有权威选槽状态');
        const tool = state.inventory.find(item => item.slot === slot);
        if (!tool || tool.components === undefined) throw new BodyError('WRONG_TOOL', '缺少完整原生工具快照，未挖掘');
        task.progress.stage = 'selecting-tool';
        await this.step(task, 'select-slot', { slot, expectedItem: tool.id, expectedCount: tool.count, expectedComponents: tool.components, ...(tool.maxStackSize !== undefined ? { expectedMaxStackSize: tool.maxStackSize } : {}) });
        task.progress.stage = 'approaching-resource';
        await this.step(task, 'approach-resource', { targetToken: candidate.targetToken, timeoutMs: Math.min(20000, Math.max(500, task.deadline - this.now())) });
        task.progress.stage = 'digging';
        await this.step(task, 'dig-block', { ...candidate.position, expectedBlock: candidate.id, expectedProperties: candidate.properties, targetToken: candidate.targetToken, timeoutMs: Math.min(30000, Math.max(500, task.deadline - this.now())) });
        await this.pickups(task);
      }
      await this.observe(task);
      if (!this.done(task)) throw new BodyError('INSUFFICIENT_RESOURCES', '冻结候选已用完，实际拾取数量不足；未重新向外搜索');
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
    this.operations.set(task.id, op); if (this.operations.size > 64) this.operations.delete(this.operations.keys().next().value!); return op;
  }
  private finish(task: Active, status: Operation['status'], summary: string, code?: string): void {
    if (this.operations.get(task.id)?.status !== 'running' && this.operations.has(task.id)) return;
    task.progress.stage = status === 'succeeded' ? 'done' : status; task.progress.code = code;
    if (status === 'unknown' || status === 'cancelled') { task.progress.lastConfirmedPickedUpCount = task.progress.pickedUpCount; delete task.progress.pickedUpCount; task.progress.pickup = 'partial-or-unknown'; }
    const operation = this.remember(task, status, summary);
    if (!task.borrowed) this.events.notifyOperation(operation);
  }
}
