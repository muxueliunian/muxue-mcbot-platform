// 捡掉落物：走到捡得到的位置（原版捡取范围：身体碰撞箱水平外扩 1 格、上下外扩 0.5 格）。
// 走不过去时（矿在墙里、掉落物卡在洞里）可以挖开几格天然方块过去：只挖石头、深板岩、矿这类地下方块，
// 不挖人造方块、会掉落的方块、贴着水和岩浆的方块，也不进登记区域；每一格都单独授权
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { TaskHandle, currentGrant, emptyGrant, posKey } from './task-control.js';
import { checkDig } from './action-policy.js';
import { protectFromPathfinder } from './protected-blocks.js';
import { safeGoto } from './movement.js';
import { digAt, sleep } from './tools/block-ops.js';

const { goals, Movements } = pathfinderPkg;

// 挖开去捡时允许挖的天然方块
export const NATURAL = /^(stone|deepslate|tuff|granite|diorite|andesite|calcite|dripstone_block|smooth_basalt|basalt|netherrack|blackstone|end_stone|.*_ore|ancient_debris|raw_\w+_block)$/;
// 最多为一个掉落物挖开这么多格
export const MAX_DIG_TO_REACH = 6;
const REACH_PAD = 1.2; // 水平：半个身宽 0.3 + 外扩 1，留一点余量

// 站在这一格能不能捡到这个位置的物品
export class GoalPickup extends goals.Goal {
  constructor(private readonly item: Vec3) {
    super();
  }

  heuristic(node: { x: number; y: number; z: number }): number {
    const dx = node.x + 0.5 - this.item.x;
    const dz = node.z + 0.5 - this.item.z;
    const dy = node.y - this.item.y;
    return Math.sqrt(dx * dx + dz * dz) + Math.abs(dy);
  }

  isEnd(node: { x: number; y: number; z: number }): boolean {
    return Math.abs(node.x + 0.5 - this.item.x) <= REACH_PAD
      && Math.abs(node.z + 0.5 - this.item.z) <= REACH_PAD
      && this.item.y >= node.y - 0.4 && this.item.y <= node.y + 2.2;
  }
}

// 只用来算路的 Movements：可以挖天然方块，不放方块、不搭塔
function diggingMovements(bot: Bot, grantCheck: (b: Block) => boolean): unknown {
  const m = new Movements(bot, bot.registry as never) as unknown as Record<string, unknown> & {
    exclusionAreasBreak: Array<(b: Block) => number>;
    exclusionAreasPlace: Array<(b: Block) => number>;
  };
  m.canDig = true;
  m.allow1by1towers = false;
  m.allowSprinting = false;
  m.canOpenDoors = false;
  m.scafoldingBlocks = [];
  m.dontCreateFlow = true;
  m.dontMineUnderFallingBlock = true;
  protectFromPathfinder(m, bot.registry as never);
  m.exclusionAreasBreak.push((b: Block) => (grantCheck(b) ? 0 : 100));
  m.exclusionAreasPlace.push(() => 100);
  return m;
}

interface PlannedPath {
  status: string;
  path: Array<{ x: number; y: number; z: number; toBreak?: Vec3[]; toPlace?: unknown[] }>;
}

// 要挖开哪些格子才能走到捡得到的位置；走得过去返回 []，挖太多或不能挖返回 null
export function planDigToReach(bot: Bot, item: Vec3): Vec3[] | null {
  const canBreak = (b: Block) => {
    if (!b?.position || !NATURAL.test(b.name)) return false;
    const grant = emptyGrant();
    grant.dig.add(posKey(b.position));
    return checkDig(bot, b.position, grant).ok;
  };
  const movements = diggingMovements(bot, canBreak);
  let result: PlannedPath | null = null;
  for (const step of bot.pathfinder.getPathFromTo(movements as never, bot.entity.position, new GoalPickup(item) as never, { timeout: 500 })) {
    result = step.result as unknown as PlannedPath;
  }
  if (!result || result.status !== 'success') return null;
  if (result.path.some((n) => n.toPlace?.length)) return null;
  const cells = result.path.flatMap((n) => n.toBreak ?? []).map((p) => new Vec3(p.x, p.y, p.z));
  return cells.length <= MAX_DIG_TO_REACH ? cells : null;
}

function isDrop(e: Entity): boolean {
  return e.name === 'item' && e.isValid !== false;
}

export interface CollectResult {
  picked: number;
  dug: number;
  left: number;
}

// 捡 around 附近 radius 格内的掉落物，直到捡完、捡不到或被打断。digToReach 时走不过去就挖开天然方块
export async function collectDropsAround(bot: Bot, around: Vec3[], handle: TaskHandle, opts: { radius?: number; digToReach?: boolean; maxItems?: number } = {}): Promise<CollectResult> {
  const radius = opts.radius ?? 6;
  const maxItems = opts.maxItems ?? 24;
  const near = (e: Entity) => around.some((p) => p.offset(0.5, 0.5, 0.5).distanceTo(e.position) <= radius);
  const gone = new Set<number>();
  let picked = 0;
  const onCollect = (collector: Entity, item: Entity) => {
    if (collector === bot.entity && !gone.has(item.id)) {
      gone.add(item.id);
      picked += 1;
    }
  };
  bot.on('playerCollect', onCollect as never);
  const tried = new Set<number>();
  let dug = 0;
  try {
    // 刚挖下来的掉落物要一小会儿才出现、落地
    await sleep(300);
    for (let i = 0; i < maxItems && !handle.check(); i++) {
      const drop = bot.nearestEntity((e) => isDrop(e) && !tried.has(e.id) && near(e));
      if (!drop) break;
      tried.add(drop.id);
      const at = drop.position.clone();
      const goal = new GoalPickup(at);
      const here = bot.entity.position.floored();
      if (!goal.isEnd(here)) {
        try {
          await safeGoto(bot, goal as never, { timeoutMs: 8000, check: () => handle.check() });
        } catch {
          if (handle.check() || !opts.digToReach || !bot.entities[drop.id]) continue;
          const cells = planDigToReach(bot, at);
          if (!cells?.length) continue;
          const grant = currentGrant() ?? emptyGrant();
          let ok = true;
          for (const c of cells) {
            const r = await digAt(bot, c, grant, { requireDrops: false, clearFalling: false, handle }).catch((err) => (err as Error).message);
            if (r !== 'dug' && r !== '已经是空的') { ok = false; break; }
            dug += 1;
          }
          if (!ok || !bot.entities[drop.id]) continue;
          try {
            await safeGoto(bot, goal as never, { timeoutMs: 8000, check: () => handle.check() });
          } catch {
            continue;
          }
        }
      }
      // 站到位后等物品被吸过来
      for (let t = 0; t < 10 && bot.entities[drop.id] && !gone.has(drop.id); t++) await sleep(100);
    }
  } finally {
    bot.removeListener('playerCollect', onCollect as never);
  }
  const left = Object.values(bot.entities).filter((e) => e && isDrop(e) && near(e)).length;
  return { picked, dug, left };
}
