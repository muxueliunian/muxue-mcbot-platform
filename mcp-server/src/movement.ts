// 所有工具和脚本共用的走路入口：只用安全寻路（不挖不垫），带超时、卡住检测和中断检查，
// 结束后按实际位置判断是否真的到了（pathfinder 找不到路时有时也会"正常结束"）
import type { Bot } from 'mineflayer';
import { createSafeMovements, isSafeMovements } from './action-policy.js';
import { landIfFlying } from './flight.js';

export class NoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoPathError';
  }
}

interface GoalLike {
  isEnd(node: { x: number; y: number; z: number }): boolean;
}

export interface GotoOptions {
  timeoutMs?: number;
  // 这么久几乎没挪动就算卡住
  stallMs?: number;
  // 返回非空字符串时中止（例如任务被打断）
  check?: () => string | null;
}

export function ensureSafeMovements(bot: Bot): void {
  if (!isSafeMovements(bot.pathfinder.movements)) {
    bot.pathfinder.setMovements(createSafeMovements(bot));
  }
}

function reached(bot: Bot, goal: GoalLike): boolean {
  const p = bot.entity.position.floored();
  return goal.isEnd(p) || goal.isEnd(p.offset(0, 1, 0));
}

const REASONS: Record<string, string> = {
  NoPath: '找不到不用挖方块、不用垫方块的路',
  Timeout: '想路想得太久，没找到路',
  GoalChanged: '目标被改掉了',
  PathStopped: '移动被停下了'
};

export async function safeGoto(bot: Bot, goal: GoalLike, options: GotoOptions = {}): Promise<void> {
  const { timeoutMs = 30000, stallMs = 6000, check } = options;
  ensureSafeMovements(bot);
  // 悬停时寻路走不了，先落地
  await landIfFlying(bot);
  if (reached(bot, goal)) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: ReturnType<typeof setInterval> | undefined;
  const moving = bot.pathfinder.goto(goal as never);
  moving.catch(() => undefined);
  try {
    await Promise.race([
      moving,
      new Promise((_, reject) => {
        const abort = (message: string) => {
          bot.pathfinder.setGoal(null);
          reject(new NoPathError(message));
        };
        timer = setTimeout(() => abort(`移动超时（${Math.round(timeoutMs / 1000)} 秒）`), timeoutMs);
        let last = bot.entity.position.clone();
        let lastMoveAt = Date.now();
        watcher = setInterval(() => {
          const reason = check?.();
          if (reason) return abort(reason);
          if (bot.entity.position.distanceTo(last) > 0.3) {
            last = bot.entity.position.clone();
            lastMoveAt = Date.now();
          } else if (Date.now() - lastMoveAt > stallMs && !bot.pathfinder.isMining?.()) {
            abort('卡住了，原地走不动');
          }
        }, 250);
      })
    ]);
  } catch (err) {
    // pathfinder 报"没有路"后目标还挂着，会继续朝墙走、反复重算：明确清掉，原地停下
    bot.pathfinder.setGoal(null);
    const e = err as Error;
    if (e instanceof NoPathError) throw e;
    throw new NoPathError(REASONS[e.name] ?? e.message);
  } finally {
    if (timer) clearTimeout(timer);
    if (watcher) clearInterval(watcher);
  }
  if (!reached(bot, goal)) {
    bot.pathfinder.setGoal(null);
    throw new NoPathError(`${REASONS.NoPath}，停在 (${bot.entity.position.floored().toArray().join(', ')})`);
  }
}
