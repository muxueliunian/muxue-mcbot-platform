// 游泳本能（程序层，不经过 LLM）：
// - 头在水里、又没在寻路：按住跳跃浮上去（寻路在水里会自己按跳跃，不去抢）
// - 快没气了：停下手上的事（相当于 stop-action），往最近的空气游：头顶直通水面就往上游，
//   被堵住就在水里找最近的一格空气，朝那边游；发一次 danger 事件
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { cancelTasks } from './task-control.js';
import { claimGaze } from './gaze.js';

export const SWIM = {
  tickMs: 200,
  // 氧气（0~20）不多于这个就算快没气了
  lowOxygen: 10,
  // 找空气的范围（水里走几步）
  searchNodes: 400,
  searchRadius: 10,
  // 换到气之后这么久内又沉下去，不再停任务、不再报
  calmMs: 10000
};

const WATERY = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const AIR = /^(air|cave_air|void_air)$/;
const N6 = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)];

function isWater(bot: Bot, p: Vec3): boolean {
  const b = bot.blockAt(p);
  return Boolean(b && WATERY.test(b.name));
}

function isAir(bot: Bot, p: Vec3): boolean {
  const b = bot.blockAt(p);
  return Boolean(b && AIR.test(b.name));
}

export function eyeCell(bot: Bot): Vec3 {
  const eye = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
  return bot.entity.position.offset(0, eye, 0).floored();
}

export function headUnderwater(bot: Bot): boolean {
  return Boolean(bot.entity) && isWater(bot, eyeCell(bot));
}

// 从头所在的水格出发，在水里找最近的一格空气（要能游过去：只穿过水格）。
// 返回那格空气；头顶直通水面时就是正上方
export function nearestAir(bot: Bot): Vec3 | null {
  const start = eyeCell(bot);
  if (!isWater(bot, start)) return isAir(bot, start) ? start : null;
  const seen = new Set<string>([start.toString()]);
  const queue: Vec3[] = [start];
  for (let i = 0; i < queue.length && i < SWIM.searchNodes; i++) {
    const cur = queue[i];
    // 往上优先：N6 第一个是上
    for (const d of N6) {
      const next = cur.plus(d);
      const key = next.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      if (next.distanceTo(start) > SWIM.searchRadius) continue;
      // 挨着水的空气格：游过去把头伸进去就能换气
      if (isAir(bot, next)) return next;
      if (isWater(bot, next)) queue.push(next);
    }
  }
  return null;
}

export interface SwimState {
  floating: boolean;
  escaping: boolean;
  target: Vec3 | null;
}

export function startSwimReflex(bot: Bot, onEvent: (type: string, text: string) => void): { stop(): void; state(): SwimState } {
  const s: SwimState = { floating: false, escaping: false, target: null };
  // 这次遇险已经报过「快没气」，出水时要报一次「危险解除」
  let warned = false;
  let lastSearch = 0;
  // 刚换到气：这段时间内又沉下去（浮在水面上下起伏）只管往上游，不再停任务、不再报
  let calmUntil = 0;

  const release = () => {
    if (s.floating || s.escaping) {
      bot.setControlState('jump', false);
      if (s.escaping) bot.setControlState('forward', false);
    }
    s.floating = false;
    s.escaping = false;
    s.target = null;
  };

  const tick = () => {
    if (!bot.entity) return;
    if (!headUnderwater(bot)) {
      if (warned) {
        warned = false;
        calmUntil = Date.now() + SWIM.calmMs;
        const oxygen = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20;
        // 用 danger 类型：托管时要叫醒 agent，好重新开跟随
        onEvent('danger', `危险解除：游上来换到气了（氧气 ${oxygen}/20，在 (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)})），刚才停掉的跟随、任务要的话重新开`);
      }
      release();
      return;
    }
    const oxygen = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20;
    const low = oxygen <= SWIM.lowOxygen;
    const pathing = Boolean(bot.pathfinder?.isMoving?.());

    const calm = Date.now() < calmUntil;
    if (low) {
      if (!s.escaping) {
        s.escaping = true;
        // 保命要紧：停下所有任务和跟随，身体交给游泳（刚换过气又沉下去时不重复停）
        if (!calm) {
          cancelTasks();
          bot.pathfinder?.setGoal(null);
        }
      }
      const now = Date.now();
      if (!s.target || now - lastSearch > 1000) {
        s.target = nearestAir(bot);
        lastSearch = now;
      }
      if (!warned && !calm) {
        warned = true;
        onEvent('danger', s.target
          ? `在水下快没气了（氧气 ${oxygen}/20）。程序已经停下手上的事，正在自己往 (${s.target.x}, ${s.target.y}, ${s.target.z}) 游去换气，不用调用移动工具（会和游泳抢操作）；换到气会再发一条「危险解除」`
          : `在水下快没气了（氧气 ${oxygen}/20），附近找不到空气，程序正在一直往上游；不用调用移动工具，换到气会再发一条「危险解除」`);
      }
      bot.setControlState('jump', true);
      const t = s.target;
      const me = bot.entity.position;
      if (t && Math.hypot(t.x + 0.5 - me.x, t.z + 0.5 - me.z) > 0.4) {
        claimGaze('combat', 600);
        const dx = t.x + 0.5 - me.x;
        const dz = t.z + 0.5 - me.z;
        bot.look(Math.atan2(-dx, -dz), 0.4, true).catch(() => undefined);
        bot.setControlState('forward', true);
      } else {
        bot.setControlState('forward', false);
      }
      return;
    }

    // 不缺气：没在寻路就浮上去；在寻路就交给寻路（它在水里会自己按跳跃）
    if (pathing) {
      if (s.floating) s.floating = false;
      return;
    }
    if (s.escaping) {
      bot.setControlState('forward', false);
      s.escaping = false;
    }
    s.floating = true;
    bot.setControlState('jump', true);
  };

  const timer = setInterval(tick, SWIM.tickMs);
  const stop = () => {
    clearInterval(timer);
    release();
  };
  bot.once('end', () => clearInterval(timer));
  return { stop, state: () => ({ ...s }) };
}
