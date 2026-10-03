// mcbot 批量方块操作：一次调用挖多个方块（mine-blocks）、按清单/形状放置或清除多个方块（build）
// 每一步前都重新读取方块状态，已经变化的位置会跳过；玩家叫名字、受伤、stop-action 时提前返回进度
import { z } from "zod";
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { TaskHandle, useGrant, posKey, type Grant } from '../task-control.js';
import { log } from '../logger.js';
import { safeGoto } from '../movement.js';
import {
  REACH, MAX_CONSECUTIVE_FAILURES, TREE_TOP, unlockSchema, vec3Schema, type Point, type DigOptions,
  key, fmt, isEmpty, isSoft, eyeDistance, approach, equipBestTool, digAt, scaffoldItem, pillarStep, descendPillar,
  addReason, summarizeReasons, MAX_PILLAR, sleep
} from './block-ops.js';
import { BUILD_DESCRIPTION, buildSchema, runBuild } from '../building.js';
import { collectDropsAround, NATURAL, type CollectResult } from '../pickup.js';

const { goals } = pathfinderPkg;

const MAX_TARGETS = 1024;

// 支持通配符：*_log、*_ore
function nameMatcher(patterns: string[]): (name: string) => boolean {
  const regs = patterns.map((p) => new RegExp(`^${p.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  return (name) => regs.some((r) => r.test(name));
}

const TRUNK = /_(log|wood|stem|hyphae)$/;
// 人造方块：原木挨着这些，多半是建筑的一部分
const MAN_MADE = /(_planks|_stairs|_slab|_fence|_fence_gate|_door|_trapdoor|glass|glass_pane|_bed|torch|lantern|cobblestone|_bricks|bricks|_wall|crafting_table|furnace|chest|barrel|bookshelf|_carpet|_wool|ladder|_terracotta|_pressure_plate|composter|bell|hay_block|_sign)$|^(smooth|polished)_/;
const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

// 查找模式砍树：只砍连着树叶、周围没有人造方块的原木，避免拆村民/玩家的房子。
// 是树就返回整棵树连通的原木（坐标 key），不是返回 null
function naturalTrunk(bot: Bot, start: Vec3): Set<string> | null {
  const seen = new Set<string>([key(start)]);
  const stack = [start];
  let leaves = false;
  while (stack.length && seen.size <= 64) {
    const p = stack.pop()!;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const b = bot.blockAt(p.offset(dx, dy, dz));
          if (!b) continue;
          if (TREE_TOP.test(b.name)) leaves = true;
          else if (MAN_MADE.test(b.name)) return null;
        }
      }
    }
    // 斜着挨着（棱、角相碰）的也算同一棵树：金合欢、深色橡木的树枝是斜着长的
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const n = p.offset(dx, dy, dz);
          if (seen.has(key(n))) continue;
          const b = bot.blockAt(n);
          if (b && TRUNK.test(b.name)) {
            seen.add(key(n));
            stack.push(n);
          }
        }
      }
    }
  }
  return leaves ? seen : null;
}

// 认定是树之后记住整棵树：先砍掉挨着树叶的那段，剩下的树桩就不挨着树叶了，也要认得出来
const TREE_MEMORY_MS = 15 * 60 * 1000;
// 原木 → 它所在的整棵树（原木坐标 key 的集合）
const knownTreeLogs = new Map<string, { until: number; tree: Set<string> }>();

function treeKey(bot: Bot, k: string): string {
  return `${bot.game?.dimension ?? 'overworld'}:${k}`;
}

function rememberTree(bot: Bot, tree: Set<string>): void {
  if (knownTreeLogs.size > 4096) knownTreeLogs.clear();
  const until = Date.now() + TREE_MEMORY_MS;
  for (const k of tree) knownTreeLogs.set(treeKey(bot, k), { until, tree });
}

function treeOf(bot: Bot, pos: Vec3): Set<string> | null {
  const k = treeKey(bot, key(pos));
  const known = knownTreeLogs.get(k);
  if (!known) return null;
  if (known.until < Date.now()) {
    knownTreeLogs.delete(k);
    return null;
  }
  return known.tree;
}

function isKnownTreeLog(bot: Bot, pos: Vec3): boolean {
  return treeOf(bot, pos) !== null;
}

function parseKey(k: string): Vec3 {
  const [x, y, z] = k.split(',').map(Number);
  return new Vec3(x, y, z);
}

function boxPositions(from: Point, to: Point): Vec3[] {
  const x1 = Math.floor(Math.min(from.x, to.x)), x2 = Math.floor(Math.max(from.x, to.x));
  const y1 = Math.floor(Math.min(from.y, to.y)), y2 = Math.floor(Math.max(from.y, to.y));
  const z1 = Math.floor(Math.min(from.z, to.z)), z2 = Math.floor(Math.max(from.z, to.z));
  const volume = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
  if (volume > MAX_TARGETS) {
    throw new Error(`区域太大：${volume} 格，单次最多 ${MAX_TARGETS} 格，请分块执行`);
  }
  const out: Vec3[] = [];
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      for (let z = z1; z <= z2; z++) {
        out.push(new Vec3(x, y, z));
      }
    }
  }
  return out;
}

// ---- 垫方块砍高处的原木 ----
// 寻路永远不垫方块，所以高处的原木走过去也够不着。在树旁边垫高，站在上面把够得着的同一棵树的原木砍掉，再下来

// 站在这一列下面的地上也够不着（先不用寻路白想半天）
function tooHighFromGround(bot: Bot, pos: Vec3): boolean {
  for (let y = pos.y - 1; y >= pos.y - 12; y--) {
    const b = bot.blockAt(new Vec3(pos.x, y, pos.z));
    if (!b) return false;
    if (isEmpty(b) || isSoft(b) || TRUNK.test(b.name) || TREE_TOP.test(b.name)) continue;
    const eyeY = y + 1 + 1.62;
    return pos.y + 0.5 - eyeY > REACH - 0.5;
  }
  return true;
}

// 附近这次要砍的原木（accept 决定），近的在前。reachable：只要够得着、看得见的；
// 否则只要头顶上方、水平 3 格内还够不着的（再往上垫就能砍到）
function nearbyTreeLogs(bot: Bot, target: Vec3, accept: (p: Vec3, b: Block) => boolean, reachable: boolean): Vec3[] {
  const feet = bot.entity.position.floored();
  const out: Vec3[] = [];
  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -3; dy <= 10; dy++) {
      for (let dz = -5; dz <= 5; dz++) {
        const p = feet.offset(dx, dy, dz);
        const b = bot.blockAt(p);
        if (!b || !TRUNK.test(b.name)) continue;
        if (!p.equals(target) && !accept(p, b)) continue;
        const inReach = eyeDistance(bot, p) <= REACH && bot.canSeeBlock(b);
        if (reachable ? !inReach : (inReach || dy < 2 || Math.hypot(dx, dz) > 3)) continue;
        out.push(p);
      }
    }
  }
  return out.sort((a, b) => eyeDistance(bot, a) - eyeDistance(bot, b));
}

// 走到树下，垫高，砍掉够得着的原木，再下来。返回 null 表示至少砍了一块，否则返回跳过原因
async function chopFromPillar(
  bot: Bot, target: Vec3, grant: Grant, opts: DigOptions,
  accept: (p: Vec3, b: Block) => boolean, onDug: (pos: Vec3, name: string) => boolean
): Promise<string | null> {
  if (!scaffoldItem(bot)) return '太高够不着，身上也没有能垫脚的方块（泥土、圆石等）';
  const here = bot.entity.position.floored();
  if (Math.abs(here.x - target.x) + Math.abs(here.z - target.z) > 1) {
    try {
      await approach(bot, () => new goals.GoalNearXZ(target.x, target.z, 1), 15000, opts.handle);
    } catch (err) {
      return `太高够不着，也走不到树下（${(err as Error).message}）`;
    }
  }
  const pillar: Vec3[] = [];
  let dug = 0;
  try {
    const canHit = () => {
      const b = bot.blockAt(target);
      return !b || isEmpty(b) || (eyeDistance(bot, target) <= REACH - 0.3 && bot.canSeeBlock(b));
    };
    while (pillar.length < MAX_PILLAR && !canHit() && !opts.handle.check()) {
      const step = await pillarStep(bot, grant);
      if (!step) break;
      pillar.push(step);
    }
    // 砍掉够得着的；头顶附近还有这棵树够不着的，就接着往上垫，不先下来再重新垫
    let more = true;
    for (let guard = 0; guard < 48 && more && !opts.handle.check(); guard++) {
      const next = nearbyTreeLogs(bot, target, accept, true)[0];
      if (next) {
        const b = bot.blockAt(next)!;
        const name = b.name;
        grant.dig.add(posKey(next));
        await equipBestTool(bot, b);
        await bot.dig(b, true);
        dug += 1;
        more = onDug(next, name);
        continue;
      }
      if (pillar.length >= MAX_PILLAR || !nearbyTreeLogs(bot, target, accept, false).length) break;
      const step = await pillarStep(bot, grant);
      if (!step) break;
      pillar.push(step);
    }
  } finally {
    if (pillar.length) {
      try {
        await descendPillar(bot, pillar, grant);
      } catch (err) {
        log('warn', `从垫的方块上下来失败：${(err as Error).message ?? err}`);
      }
    }
  }
  if (dug) return null;
  return pillar.length ? `垫高 ${pillar.length} 格还是够不着` : '太高够不着，这里也垫不了方块（头顶或脚下有东西挡着）';
}

export function registerBuildTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "mine-blocks",
    "Mine many blocks in one call. Modes: (1) blockTypes + count: find and mine the nearest matching blocks (e.g. chop logs, mine ores; wildcards like *_log allowed); (2) area: clear a box (optionally only blockTypes); (3) positions: an explicit list. Re-checks every block before digging, picks the best tool, skips chests/beds/doors etc. unless allowProtected, never touches farmland/crops or registered protected regions (unless unlockRegions), never digs a path to reach a target (unreachable targets are skipped), and returns early with progress if a player calls you, you get hurt, or stop-action is used",
    {
      blockTypes: z.array(z.string()).optional().describe("Block names to mine, wildcards allowed (e.g. [\"*_log\"], [\"iron_ore\",\"deepslate_iron_ore\"]). In area/positions mode this is a filter"),
      count: z.coerce.number().int().min(1).max(128).optional().describe("Find mode: how many blocks to mine (default: 8)"),
      maxDistance: z.coerce.number().finite().min(1).max(64).optional().describe("Find mode: search radius (default: 32)"),
      area: z.object({ from: vec3Schema, to: vec3Schema }).optional().describe("Clear every block inside this box (max 1024 blocks), top to bottom"),
      positions: z.array(vec3Schema).max(MAX_TARGETS).optional().describe("Explicit block positions to mine"),
      collect: z.boolean().optional().describe("Pick up the drops afterwards (default: true)"),
      requireDrops: z.boolean().optional().describe("Skip blocks you have no proper tool for, e.g. stone without a pickaxe (default: true)"),
      allowProtected: z.boolean().optional().describe("Also break chests, beds, doors, torches, glass... and, in find mode, logs that look like part of a building (default: false)"),
      pillarUp: z.boolean().optional().describe("Find mode: when tree logs are too high to reach, pillar up next to the trunk with dirt/cobblestone from the inventory, chop what is in reach, then dig the pillar back down (default: true)"),
      unlockRegions: unlockSchema,
      timeoutSeconds: z.coerce.number().int().min(10).max(600).optional().describe("Stop and report progress after this long (default: 180)"),
      interruptOnChat: z.boolean().optional().describe("Stop when someone mentions your name or says stop (default: true)")
    },
    async ({ blockTypes, count = 8, maxDistance = 32, area, positions, collect = true, requireDrops = true, allowProtected = false, pillarUp = true, unlockRegions, timeoutSeconds = 180, interruptOnChat = true }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const handle = new TaskHandle({ timeoutMs: timeoutSeconds * 1000, interruptOnChat });
      const matches = blockTypes?.length ? nameMatcher(blockTypes) : null;
      const grant = useGrant({ allowProtected, unlockRegions });
      const opts: DigOptions = { requireDrops, clearFalling: !blockTypes?.length, handle };

      const findMode = !area && !positions;
      if (findMode && !matches) {
        return factory.createResponse('请提供 blockTypes（查找模式）、area 或 positions 之一');
      }
      let ids: number[] = [];
      if (findMode) {
        ids = Object.values(mcData.blocksByName).filter((b) => matches!(b.name)).map((b) => b.id);
        if (!ids.length) return factory.createResponse(`没有匹配 ${blockTypes!.join(', ')} 的方块名`);
      }

      let queue: Vec3[] = [];
      if (area) {
        queue = boxPositions(area.from, area.to).sort((a, b) => b.y - a.y);
      } else if (positions) {
        queue = positions.map((p: Point) => new Vec3(p.x, p.y, p.z).floored()).sort((a: Vec3, b: Vec3) => b.y - a.y);
      }

      const mined = new Map<string, number>();
      const minedPositions: Vec3[] = [];
      const skipped = new Map<string, Vec3[]>();
      const failed = new Set<string>();
      let stopReason: string | null = null;
      let consecutiveFailures = 0;

      // 砍树时一棵砍完再砍下一棵：不然几棵树挨着时，每次都挑最近的原木，会在树之间来回跳、每棵都留半截。
      // 数量够了也把正在砍的这棵砍完（最多多砍 EXTRA_TO_FINISH 块）
      const EXTRA_TO_FINISH = 32;
      let currentTree: Set<string> | null = null;
      const nearest = (list: Vec3[]) => list.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0] ?? null;
      const treeLeft = (): Vec3[] => {
        if (!currentTree) return [];
        return [...currentTree].map(parseKey).filter((p) => {
          if (failed.has(key(p))) return false;
          const b = bot.blockAt(p);
          return Boolean(b && TRUNK.test(b.name) && (!matches || matches(b.name)));
        });
      };
      const nextTarget = (): Vec3 | null => {
        if (!findMode) return queue.shift() ?? null;
        if (minedPositions.length >= count + EXTRA_TO_FINISH) return null;
        const rest = treeLeft();
        if (rest.length) return nearest(rest);
        currentTree = null;
        if (minedPositions.length >= count) return null;
        const found = bot.findBlocks({ matching: ids, maxDistance, count: 256, point: bot.entity.position })
          .filter((p) => !failed.has(key(p)));
        return nearest(found);
      };

      while (true) {
        stopReason = handle.check();
        if (stopReason) break;
        const pos = nextTarget();
        if (!pos) break;
        const block = bot.blockAt(pos);
        if (!block) {
          addReason(skipped, '区块未加载', pos);
          failed.add(key(pos));
          continue;
        }
        if (isEmpty(block)) continue;
        if (matches && !matches(block.name)) continue;
        if (findMode && !allowProtected && TRUNK.test(block.name) && !isKnownTreeLog(bot, pos)) {
          const tree = naturalTrunk(bot, pos);
          if (!tree) {
            addReason(skipped, '不像是树（没连着树叶或挨着建筑），可能是房子的一部分', pos);
            failed.add(key(pos));
            continue;
          }
          rememberTree(bot, tree);
        }
        if (findMode && TRUNK.test(block.name)) currentTree = treeOf(bot, pos) ?? currentTree;
        const name = block.name;
        const record = (p: Vec3, n: string) => {
          mined.set(n, (mined.get(n) ?? 0) + 1);
          minedPositions.push(p);
          return !findMode || minedPositions.length < count + EXTRA_TO_FINISH;
        };
        try {
          const result = pillarUp && TRUNK.test(name) && tooHighFromGround(bot, pos)
            ? '够不着（离地面太高）'
            : await digAt(bot, pos, grant, opts);
          if (result === 'dug') {
            record(pos, name);
            consecutiveFailures = 0;
          } else if (pillarUp && TRUNK.test(name) && result.startsWith('够不着')) {
            // 站在高处顺手砍的：查找模式是同一棵树的原木，清单/区域模式是还没轮到的目标
            const pending = new Set(queue.map(key));
            const accept = findMode
              ? (p: Vec3, b: Block) => (currentTree ? currentTree.has(key(p)) : isKnownTreeLog(bot, p)) && (!matches || matches(b.name))
              : (p: Vec3, b: Block) => pending.has(key(p)) && (!matches || matches(b.name));
            const take = (p: Vec3, n: string) => {
              const i = queue.findIndex((q) => q.equals(p));
              if (i >= 0) queue.splice(i, 1);
              return record(p, n);
            };
            const reason = await chopFromPillar(bot, pos, grant, opts, accept, take);
            if (reason) {
              addReason(skipped, reason, pos);
              failed.add(key(pos));
            } else {
              consecutiveFailures = 0;
            }
          } else {
            if (result !== '已经是空的') addReason(skipped, result, pos);
            failed.add(key(pos));
          }
        } catch (err) {
          log('warn', `mine-blocks ${fmt(pos)}: ${err}`);
          addReason(skipped, `失败：${(err as Error).message ?? err}`, pos);
          failed.add(key(pos));
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            stopReason = `连续 ${MAX_CONSECUTIVE_FAILURES} 次失败`;
            break;
          }
        }
      }

      let loot: CollectResult | null = null;
      if (collect && minedPositions.length && !stopReason?.startsWith('被 stop-action')) {
        // 挖的都是石头、矿这类地下方块时，掉落物卡在洞里走不过去就挖开几格去捡
        const underground = [...mined.keys()].every((n) => NATURAL.test(n));
        loot = await collectDropsAround(bot, minedPositions, new TaskHandle({ timeoutMs: 30000, interruptOnChat }), { digToReach: underground });
      }

      const total = minedPositions.length;
      const lines = [
        total ? `挖掉 ${total} 个方块：${[...mined.entries()].map(([n, c]) => `${n} x${c}`).join('，')}` : '没有挖掉任何方块',
      ];
      if (loot) lines.push(`捡起掉落物 ${loot.picked} 堆${loot.dug ? `（为了捡挖开 ${loot.dug} 格）` : ''}${loot.left ? `，附近还有 ${loot.left} 堆没捡到` : ''}`);
      if (findMode && total < count && !stopReason) lines.push(`${maxDistance} 格内只找到这么多可挖的`);
      if (!findMode && queue.length) lines.push(`还剩 ${queue.length} 个位置没处理`);
      if (skipped.size) lines.push('跳过：', ...summarizeReasons(skipped));
      if (stopReason) lines.push(`提前停止：${stopReason}。先处理这件事，需要的话再调用一次继续`);
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "build",
    BUILD_DESCRIPTION,
    buildSchema,
    async (args) => runBuild(factory, getBot(), args)
  );
}
