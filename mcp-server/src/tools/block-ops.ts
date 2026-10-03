// 挖、放、垫高这些底层方块动作：mine-blocks、build 和蓝图工具共用
import { createRequire } from 'node:module';
import { z } from "zod";
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { TaskHandle, posKey, type Grant } from '../task-control.js';
import { log } from '../logger.js';
import { checkDig } from '../action-policy.js';
import { safeGoto } from '../movement.js';
import { eatBetweenDigs } from '../reflexes.js';

const { goals } = pathfinderPkg;
const require = createRequire(import.meta.url);
type GoalLike = Parameters<typeof safeGoto>[1];

export const REACH = 4.5;

export const MAX_CONSECUTIVE_FAILURES = 5;

export const EMPTY_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
export const LIQUIDS = new Set(['water', 'lava', 'bubble_column']);
export const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
// 可以直接覆盖的杂草、雪等
export const SOFT = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|seagrass|tall_seagrass|kelp|kelp_plant|.*_flower|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_sapling|.*_mushroom|sweet_berry_bush|hanging_roots|moss_carpet|pink_petals)$/;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const unlockSchema = z.array(z.string()).max(8).optional().describe(
  "Names of registered protected regions (see list-regions) whose blocks this call may change — only the listed targets, only for this call. Use only when the player explicitly asked to change that area"
);

export const vec3Schema = z.object({
  x: z.coerce.number(),
  y: z.coerce.number(),
  z: z.coerce.number()
});

export type Point = z.infer<typeof vec3Schema>;

export function key(p: Vec3): string {
  return `${p.x},${p.y},${p.z}`;
}

export function fmt(p: Vec3): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

export function isEmpty(block: Block): boolean {
  return EMPTY_BLOCKS.has(block.name) || LIQUIDS.has(block.name);
}

export function isSoft(block: Block): boolean {
  return SOFT.test(block.name);
}

export const TREE_TOP = /(_leaves|_wart_block|shroomlight)$/;

export function eyeDistance(bot: Bot, pos: Vec3): number {
  return bot.entity.position.offset(0, bot.entity.height * 0.9, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));
}

// 机器人身体是否占着这个格子
export function occupiedByBot(bot: Bot, pos: Vec3): boolean {
  const p = bot.entity.position;
  const w = 0.3;
  return pos.x < p.x + w && pos.x + 1 > p.x - w
    && pos.z < p.z + w && pos.z + 1 > p.z - w
    && pos.y < p.y + 1.8 && pos.y + 1 > p.y;
}

// 走到能操作目标的位置：只用安全寻路（不挖不垫）。身体卡进墙里时先往方块中心挪一下再试一次
export async function approach(bot: Bot, makeGoal: () => GoalLike, timeoutMs: number, handle: TaskHandle): Promise<void> {
  const check = () => handle.check();
  try {
    await safeGoto(bot, makeGoal(), { timeoutMs, check });
  } catch (err) {
    if (check()) throw err;
    log('warn', `寻路失败：${(err as Error).message ?? err}，位置 ${bot.entity.position.floored()}`);
    await nudgeToBlockCenter(bot);
    await safeGoto(bot, makeGoal(), { timeoutMs, check });
  }
}

// 身体嵌进墙里一点时服务器会拒绝所有移动（moved wrongly），先往所在方块中心挪一下
export async function nudgeToBlockCenter(bot: Bot): Promise<void> {
  const p = bot.entity.position;
  const center = p.floored().offset(0.5, 0, 0.5);
  if (Math.hypot(center.x - p.x, center.z - p.z) < 0.1) return;
  bot.clearControlStates();
  await bot.lookAt(new Vec3(center.x, p.y + bot.entity.height * 0.9, center.z), true);
  bot.setControlState('forward', true);
  await sleep(200);
  bot.clearControlStates();
  await sleep(300);
}

// 装备挖得最快、且能掉落物品的工具；返回 false 表示背包里没有能采集这个方块的工具
export async function equipBestTool(bot: Bot, block: Block): Promise<boolean> {
  const candidates = [null, ...bot.inventory.items()];
  let best: (typeof candidates)[number] = null;
  let bestTime = Infinity;
  let bestHarvest = false;
  for (const item of candidates) {
    const type = item ? item.type : null;
    const harvest = block.canHarvest(type);
    const time = block.digTime(type, false, false, false, [], []);
    if ((harvest && !bestHarvest) || (harvest === bestHarvest && time < bestTime)) {
      best = item;
      bestTime = time;
      bestHarvest = harvest;
    }
  }
  if (best && bot.heldItem?.type !== best.type) {
    await bot.equip(best, 'hand');
  }
  return bestHarvest;
}

export interface DigOptions {
  requireDrops: boolean;
  clearFalling: boolean;
  handle: TaskHandle;
}

// 挖一个明确的目标位置；返回 'dug' 或跳过原因。只授权这一格，走过去的路上不挖任何东西
export async function digAt(bot: Bot, pos: Vec3, grant: Grant, opts: DigOptions): Promise<string> {
  grant.dig.add(posKey(pos));
  for (let attempt = 0; attempt < 6; attempt++) {
    const block = bot.blockAt(pos);
    if (!block) return '区块未加载';
    if (isEmpty(block)) return attempt > 0 ? 'dug' : '已经是空的';
    if (attempt > 0 && !(opts.clearFalling && FALLING.test(block.name))) return 'dug';
    const verdict = checkDig(bot, pos, grant);
    if (!verdict.ok) return verdict.reason;
    // 草、花这类没有形状的方块射线打不中，GoalLookAtBlock 永远到不了；原版挖方块只检查距离，走近就行
    const shapeless = block.shapes.length === 0;
    if (eyeDistance(bot, pos) > REACH || (!shapeless && !bot.canSeeBlock(block))) {
      try {
        await approach(bot, () => shapeless ? new goals.GoalNear(pos.x, pos.y, pos.z, 3) : new goals.GoalLookAtBlock(pos, bot.world, { reach: REACH }), 15000, opts.handle);
      } catch (err) {
        return `够不着（${(err as Error).message}）`;
      }
    }
    const current = bot.blockAt(pos);
    if (!current || isEmpty(current)) return attempt > 0 ? 'dug' : '已经是空的';
    // 该吃东西了就趁挖下一格之前吃
    await eatBetweenDigs(bot);
    const canHarvest = await equipBestTool(bot, current);
    if (!canHarvest && opts.requireDrops) {
      return `没有能采集 ${current.name} 的工具（挖了也不掉落）`;
    }
    await bot.dig(current, true);
    await sleep(opts.clearFalling ? 250 : 50);
  }
  return 'dug';
}

// ---- 垫高 ----
// 寻路永远不垫方块。要够高处时原地往上垫几格站上去，用完从上往下挖回去，不留柱子（砍高处的原木、盖高处都用）
// ---- 垫高 ----
// 寻路永远不垫方块。要够高处时原地往上垫几格站上去，用完从上往下挖回去，不留柱子（砍高处的原木、盖高处都用）
export type PlaceWithOptions = { _placeBlockWithOptions: (ref: Block, face: Vec3, options: { forceLook?: boolean | 'ignore'; swingArm?: 'right' | 'left' }) => Promise<void> };
export const SCAFFOLD = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff)$/;
export const MAX_PILLAR = 8;

// 挑垫脚用的方块；avoid 里的是这次要用来盖东西的材料，尽量不拿来垫
export function scaffoldItem(bot: Bot, avoid?: Set<string>) {
  const items = bot.inventory.items().filter((i) => SCAFFOLD.test(i.name));
  return items.find((i) => !avoid?.has(i.name)) ?? items[0] ?? null;
}

export async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

// 跳起来，在原来站的格子里放一块，站上去；成功返回放下的位置
export async function pillarStep(bot: Bot, grant: Grant, avoid?: Set<string>): Promise<Vec3 | null> {
  const feet = bot.entity.position.floored();
  const item = scaffoldItem(bot, avoid);
  const below = bot.blockAt(feet.offset(0, -1, 0));
  const here = bot.blockAt(feet);
  let head = bot.blockAt(feet.offset(0, 2, 0));
  if (head && TREE_TOP.test(head.name)) {
    grant.dig.add(posKey(head.position)); // 头顶的树叶挖掉才跳得起来
    await equipBestTool(bot, head);
    await bot.dig(head, true);
    head = bot.blockAt(feet.offset(0, 2, 0));
  }
  if (!item || !below || !here || !head || isEmpty(below) || isSoft(below) || !EMPTY_BLOCKS.has(head.name)) return null;
  if (!EMPTY_BLOCKS.has(here.name)) {
    if (!isSoft(here)) return null;
    grant.dig.add(posKey(feet)); // 脚下的草
    await bot.dig(here, true);
  }
  grant.place.add(posKey(feet));
  await bot.equip(item, 'hand');
  await bot.look(bot.entity.yaw, -Math.PI / 2, true);
  bot.setControlState('jump', true);
  try {
    // 跳到最高点前（约 1.25 格）就要放下去。已经低头了，不再转头：
    // placeBlock 默认会慢慢转头看向方块，转完人已经落回原处，服务器会拒绝
    if (!await waitUntil(() => bot.entity.position.y >= feet.y + 1.05, 1000)) return null;
    await (bot as unknown as PlaceWithOptions)._placeBlockWithOptions(below, new Vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' });
  } catch (err) {
    log('warn', `垫方块失败 ${fmt(feet)}：${(err as Error).message ?? err}`);
  } finally {
    bot.setControlState('jump', false);
  }
  await waitUntil(() => bot.entity.onGround, 1000);
  const placed = bot.blockAt(feet);
  return placed && !isEmpty(placed) && !isSoft(placed) ? feet : null;
}

// 从上往下把垫的方块挖掉，回到地面
export async function descendPillar(bot: Bot, pillar: Vec3[], grant: Grant): Promise<void> {
  for (let i = pillar.length - 1; i >= 0; i--) {
    const p = pillar[i];
    const b = bot.blockAt(p);
    if (!b || isEmpty(b)) continue;
    grant.dig.add(posKey(p));
    await equipBestTool(bot, b);
    await bot.dig(b, true);
    await waitUntil(() => bot.entity.onGround && bot.entity.position.y < p.y + 0.5, 1500);
  }
}

export function summarizeReasons(reasons: Map<string, Vec3[]>): string[] {
  return [...reasons.entries()].map(([reason, list]) => {
    const sample = list.slice(0, 3).map(fmt).join(' ');
    return `- ${reason}：${list.length} 处（如 ${sample}）`;
  });
}

export function addReason(reasons: Map<string, Vec3[]>, reason: string, pos: Vec3): void {
  const list = reasons.get(reason) ?? [];
  list.push(pos);
  reasons.set(reason, list);
}

export function inventoryCounts(bot: Bot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return counts;
}

export function isCreative(bot: Bot): boolean {
  return bot.game?.gameMode === 'creative';
}

// 创造模式：从创造物品栏拿一组物品放进背包（先放空格；背包满了就换掉 keep 以外的物品）。成功返回 true
export async function creativeTake(bot: Bot, name: string, keep?: Set<string>): Promise<boolean> {
  const creative = (bot as unknown as { creative?: { setInventorySlot: (slot: number, item: unknown) => Promise<void> } }).creative;
  const def = bot.registry.itemsByName[name];
  if (!isCreative(bot) || !creative || !def) return false;
  const slots = bot.inventory.slots;
  const order = [...Array.from({ length: 9 }, (_, i) => 36 + i), ...Array.from({ length: 27 }, (_, i) => 9 + i)];
  const slot = order.find((s) => !slots[s]) ?? order.find((s) => !keep?.has(slots[s]!.name) && slots[s]!.name !== name) ?? 44;
  const Item = require('prismarine-item')(bot.registry) as new (type: number, count: number) => unknown;
  try {
    await creative.setInventorySlot(slot, new Item(def.id, def.stackSize ?? 64));
  } catch (err) {
    log('warn', `创造模式拿 ${name} 失败：${(err as Error).message ?? err}`);
    return false;
  }
  return bot.inventory.items().some((i) => i.name === name);
}
