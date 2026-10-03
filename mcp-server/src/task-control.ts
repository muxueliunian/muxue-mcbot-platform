// 任务控制：
// 1. 长任务（批量挖掘/建造/脚本）的中断：stop-action、超时、玩家叫名字或说"停"、受伤时提前返回
// 2. 任务上下文（AsyncLocalStorage）：记录这次调用属于哪个任务、允许动哪些方块。
//    stop-action、超时、断线、换维度之后，旧任务即使异步继续执行，发出的动作也会被拒绝
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bot } from 'mineflayer';
import { EventStore } from './event-store.js';

const STOP_WORDS = ['停', '别挖', '别建', '等一下', '等等', 'stop'];
const INTERRUPT_TYPES = ['whisper', 'hurt', 'low_health', 'death', 'danger'];

let events: EventStore | null = null;
let names: string[] = [];
let generation = 0;

export function configureTasks(store: EventStore, botNames: string[]): void {
  events = store;
  names = botNames.filter(Boolean).map((n) => n.toLowerCase());
}

// 小克的游戏名和昵称（小写），给"听到名字就转头"用
export function taskNames(): string[] {
  return names;
}

// 正在执行的动作数量，给"空闲时看向玩家"等拟人行为判断用
let activeCount = 0;
let lastActiveAt = 0;

// 动作开始时同步通知（例如空闲小动作要在工具执行前让出身体）。监听器出错不影响工具
const startListeners = new Set<() => void>();

export function onActivityStart(fn: () => void): () => void {
  startListeners.add(fn);
  return () => startListeners.delete(fn);
}

function notifyStart(): void {
  for (const fn of [...startListeners]) {
    try {
      fn();
    } catch {
      // 吞掉
    }
  }
}

export function beginActivity(): void {
  activeCount += 1;
  lastActiveAt = Date.now();
  notifyStart();
}

export function endActivity(): void {
  activeCount = Math.max(0, activeCount - 1);
  lastActiveAt = Date.now();
}

export function isIdle(quietMs = 3000): boolean {
  return activeCount === 0 && Date.now() - lastActiveAt > quietMs;
}

// 正在占用身体的动作（移动、挖、放、脚本、后台任务）数量；聊天、查询不算
let bodyCount = 0;

export function beginBody(): void {
  bodyCount += 1;
  notifyStart();
}

export function endBody(): void {
  bodyCount = Math.max(0, bodyCount - 1);
}

export function bodyBusy(): boolean {
  return bodyCount > 0;
}

// 任务失效时要立刻执行的动作（例如中止进行中的挖掘）
interface InvalidationListener {
  ctx: TaskContext;
  fn: () => void;
}
const invalidationListeners = new Set<InvalidationListener>();

function fire(listener: InvalidationListener): void {
  invalidationListeners.delete(listener);
  try {
    listener.fn();
  } catch {
    // 中止失败不影响其他清理
  }
}

// ctx（或它的任一父任务）被 stop-action 取消或结束时调用 fn；返回取消订阅的函数
export function onTaskInvalidated(ctx: TaskContext, fn: () => void): () => void {
  const listener = { ctx, fn };
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

// stop-action 调用，让正在跑的任务在下一步前停下，中止进行中的动作，并让旧任务之后的动作全部失效
export function cancelTasks(): void {
  generation += 1;
  for (const listener of [...invalidationListeners]) fire(listener);
}

export function taskGeneration(): number {
  return generation;
}

// ---- 任务上下文 ----

// 本次任务明确允许改动的方块。只有列出的坐标可以挖/放，移动途中不会因此获得破坏权限
export interface Grant {
  dig: Set<string>;
  place: Set<string>;
  // 允许拆箱子、床、门等功能性方块（仍受区域保护约束）
  allowProtected?: boolean;
  // 本次调用可以改动这些已登记保护区域内的方块（只限上面列出的坐标，调用结束即失效）
  unlockRegions?: string[];
  // 允许改动农田、作物和灌溉水（留给以后的农场任务）
  allowFarm?: boolean;
}

export interface TaskContext {
  id: number;
  label: string;
  generation: number;
  bot: Bot | null;
  dimension: string | null;
  grant: Grant | null;
  parent: TaskContext | null;
  ended: string | null;
  // 脚本在任务期间注册的监听器等，结束时统一清理
  cleanups: Array<() => void>;
}

export class TaskCancelled extends Error {
  constructor(reason: string) {
    super(`任务已失效，动作被拒绝：${reason}`);
    this.name = 'TaskCancelled';
  }
}

const storage = new AsyncLocalStorage<TaskContext>();
let taskCount = 0;

export function currentTask(): TaskContext | null {
  return storage.getStore() ?? null;
}

export function posKey(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

export function emptyGrant(): Grant {
  return { dig: new Set(), place: new Set() };
}

export function startTask(label: string, bot: Bot | null, parent: TaskContext | null = currentTask()): TaskContext {
  return {
    id: ++taskCount,
    label,
    generation,
    bot,
    dimension: bot?.game?.dimension ?? null,
    grant: null,
    parent,
    ended: null,
    cleanups: []
  };
}

export function runInTask<T>(ctx: TaskContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

// 在任务外执行：用于创建 Bot、定时器等长期存在的东西，避免它们继承某次工具调用的上下文
export function runOutsideTask<T>(fn: () => T): T {
  return storage.exit(fn);
}

export function endTask(ctx: TaskContext, reason = '已结束'): void {
  if (ctx.ended) return;
  ctx.ended = reason;
  for (const listener of [...invalidationListeners]) {
    if (isDescendantOf(listener.ctx, ctx)) fire(listener);
  }
  for (const fn of ctx.cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // 清理失败不影响结束
    }
  }
}

// 任务是否已经失效：返回原因，仍有效时返回 null。父任务失效时子任务也失效
export function staleReason(ctx: TaskContext, bot?: Bot | null): string | null {
  for (let c: TaskContext | null = ctx; c; c = c.parent) {
    if (c.ended) return `任务 ${c.label} ${c.ended}`;
    if (c.generation !== generation) return '被 stop-action 停止';
    if (bot && c.bot && c.bot !== bot) return '连接已重建，旧任务作废';
    const b = bot ?? c.bot;
    if (b && c.dimension && b.game?.dimension && b.game.dimension !== c.dimension) {
      return `维度已从 ${c.dimension} 变为 ${b.game.dimension}`;
    }
  }
  return null;
}

// 当前任务自己的授权（不从父任务继承：脚本调用的子工具各自声明要动哪些方块）
export function currentGrant(): Grant | null {
  return currentTask()?.grant ?? null;
}

// 给当前任务建立授权，之后把明确的目标坐标加进 dig / place
export function useGrant(options: Omit<Grant, 'dig' | 'place'> = {}): Grant {
  const ctx = currentTask();
  if (!ctx) throw new Error('没有任务上下文，不能授权改动方块');
  ctx.grant = { dig: new Set(), place: new Set(), ...options };
  return ctx.grant;
}

export function isDescendantOf(ctx: TaskContext | null, ancestor: TaskContext): boolean {
  for (let c = ctx; c; c = c.parent) {
    if (c === ancestor) return true;
  }
  return false;
}

export interface TaskOptions {
  timeoutMs: number;
  interruptOnChat: boolean;
}

export class TaskHandle {
  private readonly gen = generation;
  private readonly deadline: number;
  private seenSeq: number;
  private readonly ctx = currentTask();

  constructor(private options: TaskOptions) {
    this.deadline = Date.now() + options.timeoutMs;
    this.seenSeq = events?.latestSeq() ?? 0;
  }

  // 返回中断原因；不需要中断时返回 null
  check(): string | null {
    if (this.gen !== generation) return '被 stop-action 停止';
    if (this.ctx) {
      const stale = staleReason(this.ctx);
      if (stale) return stale;
    }
    if (Date.now() > this.deadline) return `达到时间上限 ${Math.round(this.options.timeoutMs / 1000)} 秒`;
    if (!events) return null;
    const fresh = events.since(this.seenSeq);
    if (fresh.length) this.seenSeq = fresh[fresh.length - 1].seq;
    for (const e of fresh) {
      if (INTERRUPT_TYPES.includes(e.type)) return `发生事件（${e.type}: ${e.text}）`;
      if (e.type === 'chat' && this.options.interruptOnChat) {
        const text = e.text.toLowerCase();
        const body = text.slice(text.indexOf(':') + 1);
        if (names.some((n) => body.includes(n)) || STOP_WORDS.some((w) => body.includes(w))) {
          return `有人对你说话（${e.text}）`;
        }
      }
    }
    return null;
  }
}
