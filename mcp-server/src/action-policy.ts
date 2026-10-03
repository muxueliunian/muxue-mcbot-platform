// 统一的世界操作策略：所有会改动方块的底层动作（挖、放、对方块使用物品）都在这里检查。
// - 只有当前任务明确授权的坐标才能改动；移动、跟随、回家途中永远不挖方块、不垫方块
// - 功能性方块、农田/作物/灌溉水、登记的保护区域默认不动
// - stop-action、超时、断线、换维度后，旧任务发出的任何动作都会被拒绝
// 这是正常代码路径上的约束，不是能防住恶意 JavaScript 的沙箱
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { PROTECTED, protectFromPathfinder } from './protected-blocks.js';
import { RegionStore, type Region } from './regions.js';
import { currentGrant, currentTask, onTaskInvalidated, posKey, staleReason, TaskCancelled, type Grant } from './task-control.js';
import { log } from './logger.js';
import { isFlying, stopFlying } from './flight.js';

const { Movements } = pathfinderPkg;
const require = createRequire(import.meta.url);
const INTERACTABLE = new Set<string>(require('mineflayer-pathfinder/lib/interactable.json'));

export const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw', 'light', 'end_portal', 'end_gateway', 'nether_portal']);
// 农田和种下的作物：默认不挖、不压、不踩（甘蔗、竹子、南瓜、西瓜本体照常可以采）
export const FARM_BLOCKS = /^(farmland|wheat|carrots|potatoes|beetroots|torchflower_crop|pitcher_crop|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|nether_wart|cocoa)$/;
const WATER = new Set(['water', 'bubble_column']);
// 对方块右键时会改变世界的手持物品（放方块以外）
const MODIFYING_ITEM = /(^bucket$|_bucket$|flint_and_steel|fire_charge|bone_meal|_hoe$|_axe$|_shovel$|_spawn_egg$|^shears$|_boat$|_raft$|minecart|armor_stand|end_crystal|honeycomb|glass_bottle|^potion$|^lead$|^brush$|item_frame|^painting$|lily_pad|frogspawn|ender_eye)/;
// 不对准方块直接使用也会改变世界的物品
const WORLD_USE_ITEM = /(^bucket$|_bucket$|flint_and_steel|fire_charge|_spawn_egg$|_boat$|_raft$|minecart|armor_stand|end_crystal|lily_pad|frogspawn|bone_meal)/;
const FACE_VECTORS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
const SIDES = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

export class ActionDenied extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ActionDenied';
  }
}

export interface Verdict {
  ok: boolean;
  reason: string;
}

const OK: Verdict = { ok: true, reason: '' };
const no = (reason: string): Verdict => ({ ok: false, reason });

let regions = new RegionStore(null, '', '');

export function configurePolicy(store: RegionStore): void {
  regions = store;
}

export function regionStore(): RegionStore {
  return regions;
}

type P = { x: number; y: number; z: number };

function v(p: P): Vec3 {
  return new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
}

function dimensionOf(bot: Bot): string {
  return bot.game?.dimension ?? 'overworld';
}

// 所在位置有没有未解锁的保护区域
function regionReason(bot: Bot, pos: P, grant: Grant | null): string | null {
  const found = regions.regionsAt(dimensionOf(bot), pos);
  if (found === null) return '保护区域数据读取失败，暂不改动方块';
  const locked = found.filter((r: Region) => !grant?.unlockRegions?.includes(r.name));
  if (!locked.length) return null;
  const r = locked[0];
  return `在保护区域「${r.name}」（${r.kind}）里，没有针对这个区域的明确授权`;
}

// 这格水是不是在给农田供水（水平 4 格内、同层或低一层有农田）
export function isFarmWater(bot: Bot, pos: P): boolean {
  const b = bot.blockAt(v(pos));
  if (!b || !WATER.has(b.name)) return false;
  const p = v(pos);
  for (let dy = 0; dy >= -1; dy--) {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (bot.blockAt(p.offset(dx, dy, dz))?.name === 'farmland') return true;
      }
    }
  }
  return false;
}

// 能不能把这个位置的方块挖掉/改掉
export function checkDig(bot: Bot, pos: P, grant: Grant | null = currentGrant()): Verdict {
  const p = v(pos);
  const block = bot.blockAt(p);
  if (!block) return no('区块未加载，不清楚那里是什么');
  if (!grant || !grant.dig.has(posKey(p))) return no('这个位置不在本次任务的挖掘目标里（移动途中不挖方块）');
  if (UNBREAKABLE.has(block.name) || block.hardness === null || (block.hardness ?? 0) < 0 || block.diggable === false) {
    return no(`${block.name} 无法破坏`);
  }
  const region = regionReason(bot, p, grant);
  if (region) return no(region);
  if (PROTECTED.test(block.name) && !grant.allowProtected) return no(`${block.name} 是功能性方块，默认不拆`);
  if (!grant.allowFarm) {
    if (FARM_BLOCKS.test(block.name)) return no(`${block.name} 是农田/作物，默认不动`);
    if (SIDES.some((d) => isFarmWater(bot, p.plus(d)))) return no('旁边是给农田供水的水，挖开会漏水');
  }
  return OK;
}

// 能不能在这个位置放东西（方块、液体、实体）
export function checkPlace(bot: Bot, pos: P, grant: Grant | null = currentGrant()): Verdict {
  const p = v(pos);
  const block = bot.blockAt(p);
  if (!block) return no('区块未加载，不清楚那里是什么');
  if (!grant || !grant.place.has(posKey(p))) return no('这个位置不在本次任务的放置目标里（移动途中不垫方块）');
  const region = regionReason(bot, p, grant);
  if (region) return no(region);
  if (!grant.allowFarm) {
    if (isFarmWater(bot, p)) return no('这是给农田供水的水，不能填');
    if (bot.blockAt(p.offset(0, -1, 0))?.name === 'farmland') return no('下面是农田，放方块会把它压成泥土');
    if (FARM_BLOCKS.test(block.name)) return no(`${block.name} 是农田/作物，默认不动`);
  }
  return OK;
}

// 取走/改动液体（空桶舀水等）
function checkFluidTake(bot: Bot, pos: P, grant: Grant | null): Verdict {
  const p = v(pos);
  const block = bot.blockAt(p);
  if (!block) return no('区块未加载，不清楚那里是什么');
  if (!grant || !(grant.dig.has(posKey(p)) || grant.place.has(posKey(p)))) return no('这个位置不在本次任务的目标里');
  const region = regionReason(bot, p, grant);
  if (region) return no(region);
  if (!grant.allowFarm && isFarmWater(bot, p)) return no('这是给农田供水的水，不能舀走');
  return OK;
}

export function faceVector(face: number | undefined): Vec3 {
  return FACE_VECTORS[face ?? 1] ?? FACE_VECTORS[1];
}

export function isInteractable(block: Block): boolean {
  return INTERACTABLE.has(block.name) || PROTECTED.test(block.name) || /(_door|_trapdoor|_fence_gate|_button|lever)$/.test(block.name);
}

export function isModifyingItem(name: string | undefined, bot: Bot): boolean {
  if (!name) return false;
  return MODIFYING_ITEM.test(name) || Boolean(bot.registry.blocksByName[name]);
}

export function isWorldUseItem(name: string | undefined): boolean {
  return Boolean(name && WORLD_USE_ITEM.test(name));
}

// ---- 寻路 ----

const SAFE_MARK = Symbol('mcbotSafeMovements');
const FARMLAND_STEP_COST = 12;
// 跳下高处：摔落伤害 = 下落格数 - 3。最多扣 MAX_FALL_DAMAGE 点血，扣完至少还剩 KEEP_HEALTH；
// 会扣血的跳法每点伤害加这么多代价，有别的路就不跳
export const MAX_FALL_DAMAGE = 4;
export const KEEP_HEALTH = 12;
const FALL_DAMAGE_COST = 5;
const SAFE_FALL = 3;
const NO_SCAFFOLD: number[] = Object.freeze([]) as unknown as number[];

type MovementsLike = Record<string | symbol, unknown> & {
  exclusionAreasStep: Array<(b: Block) => number>;
  exclusionAreasBreak: Array<(b: Block) => number>;
  exclusionAreasPlace: Array<(b: Block) => number>;
};

function lockFalse(obj: object, prop: string): void {
  Object.defineProperty(obj, prop, { get: () => false, set: () => undefined, configurable: false, enumerable: true });
}

// 现在能接受的摔落伤害（血量随时在变，每次算路时读）
export function allowedFallDamage(bot: Bot): number {
  const health = typeof bot.health === 'number' ? bot.health : 20;
  return Math.max(0, Math.min(MAX_FALL_DAMAGE, Math.floor(health - KEEP_HEALTH)));
}

type MoveLike = { x: number; y: number; z: number; cost: number };
type NeighborFn = (node: MoveLike, ...rest: unknown[]) => void;

// 往下跳的走法：扣血的跳法加代价（落进水里不扣血）
function penalizeFalls(m: MovementsLike, bot: Bot, fn: 'getMoveDropDown' | 'getMoveDown'): void {
  const original = m[fn] as NeighborFn | undefined;
  if (typeof original !== 'function') return;
  m[fn] = function (this: unknown, node: MoveLike, ...rest: unknown[]) {
    const neighbors = rest[rest.length - 1] as MoveLike[];
    const found: MoveLike[] = [];
    original.call(this, node, ...rest.slice(0, -1), found);
    for (const move of found) {
      const landing = bot.blockAt?.(new Vec3(move.x, move.y, move.z));
      const damage = landing && /water/.test(landing.name) ? 0 : node.y - move.y - SAFE_FALL;
      if (damage > 0) move.cost += damage * FALL_DAMAGE_COST;
      neighbors.push(move);
    }
  };
}

// 把任意 Movements 改成"只走路"：不挖、不垫、不搭塔。锁死这些属性，之后再改也无效
export function sanitizeMovements(movements: unknown, bot: Bot): void {
  const m = movements as MovementsLike;
  if (m[SAFE_MARK]) return;
  lockFalse(m, 'canDig');
  lockFalse(m, 'allow1by1towers');
  Object.defineProperty(m, 'scafoldingBlocks', { get: () => NO_SCAFFOLD, set: () => undefined, configurable: false, enumerable: true });
  m.allowSprinting = false;
  m.canOpenDoors = false;
  // 能往下跳几格：不扣血的 3 格，加上现在能接受的摔落伤害（落脚方块和出发点的高度差 = 下落格数 + 1）
  Object.defineProperty(m, 'maxDropDown', { get: () => SAFE_FALL + 1 + allowedFallDamage(bot), set: () => undefined, configurable: false, enumerable: true });
  penalizeFalls(m, bot, 'getMoveDropDown');
  penalizeFalls(m, bot, 'getMoveDown');
  protectFromPathfinder(m, bot.registry as never);
  // 尽量绕开农田（跳上/落到农田会踩坏）；这是代价，不是绝对禁止。
  // pathfinder 一步里会把这个代价算两次，超过 100 就当作走不通，所以不能设太大
  m.exclusionAreasStep.push((b: Block) => (b?.position && bot.blockAt(b.position.offset(0, -1, 0))?.name === 'farmland' ? FARMLAND_STEP_COST : 0));
  m.exclusionAreasBreak.push(() => 100);
  m.exclusionAreasPlace.push(() => 100);
  Object.defineProperty(m, SAFE_MARK, { value: true });
}

export function createSafeMovements(bot: Bot): InstanceType<typeof Movements> {
  const m = new Movements(bot, bot.registry as never);
  sanitizeMovements(m, bot);
  return m;
}

export function isSafeMovements(movements: unknown): boolean {
  return Boolean(movements && (movements as MovementsLike)[SAFE_MARK]);
}

// ---- 底层动作守卫 ----

const GUARDED = Symbol('mcbotGuarded');
const retired = new WeakSet<object>();

// 断线或重连时调用：这个 Bot 对象之后的所有动作都会被拒绝
export function retireBot(bot: Bot): void {
  retired.add(bot);
}

type AnyFn = (...args: any[]) => any;

export function installGuards(bot: Bot): void {
  const b = bot as unknown as Record<string | symbol, unknown>;
  if (b[GUARDED]) return;
  Object.defineProperty(b, GUARDED, { value: true });

  bot.once('end', () => retireBot(bot));

  const assertLive = (what: string) => {
    if (retired.has(bot)) throw new TaskCancelled(`连接已断开（${what}）`);
    const ctx = currentTask();
    if (!ctx) return;
    const reason = staleReason(ctx, bot);
    if (reason) {
      log('warn', `拒绝过期任务的动作 ${what}：${reason}`);
      bot.emit('mcbot:denied' as never, { what, reason } as never);
      throw new TaskCancelled(reason);
    }
  };

  const deny = (what: string, pos: P | null, reason: string): never => {
    const where = pos ? ` (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})` : '';
    log('warn', `拒绝 ${what}${where}：${reason}`);
    bot.emit('mcbot:denied' as never, { what, pos, reason } as never);
    throw new ActionDenied(`不能${what}${where}：${reason}`);
  };

  const wrap = (name: string, before: (...args: any[]) => void) => {
    const original = b[name];
    if (typeof original !== 'function') return;
    const fn = original as AnyFn;
    b[name] = function guarded(this: unknown, ...args: unknown[]) {
      before(...args);
      return fn.apply(bot, args);
    };
  };

  // 同步函数里抛出的错误，对异步函数要变成 rejected promise，调用方的 .catch 才接得住
  const wrapAsync = (name: string, before: (...args: any[]) => void) => {
    const original = b[name];
    if (typeof original !== 'function') return;
    const fn = original as AnyFn;
    b[name] = async function guarded(...args: unknown[]) {
      before(...args);
      return await fn.apply(bot, args);
    };
  };

  // 挖掘要花时间：所属任务在挖的过程中被 stop-action 取消或结束（例如脚本超时），立刻中止这次挖掘
  {
    const original = b.dig as AnyFn | undefined;
    if (typeof original === 'function') {
      b.dig = async function guardedDig(...args: unknown[]) {
        const block = args[0] as Block;
        assertLive('dig');
        const verdict = checkDig(bot, block.position);
        if (!verdict.ok) deny('挖', block.position, verdict.reason);
        const ctx = currentTask();
        let aborted: string | null = null;
        const off = ctx
          ? onTaskInvalidated(ctx, () => {
              aborted = staleReason(ctx, bot) ?? '任务已结束';
              log('info', `中止进行中的挖掘 (${block.position})：${aborted}`);
              (bot as unknown as { stopDigging?: () => void }).stopDigging?.();
            })
          : () => undefined;
        try {
          return await original.apply(bot, args);
        } catch (err) {
          if (aborted) throw new TaskCancelled(aborted);
          throw err;
        } finally {
          off();
        }
      };
    }
  }

  // placeBlock / placeEntity 最终都经过 _genericPlace
  wrapAsync('_genericPlace', (ref: Block, face: Vec3) => {
    assertLive('place');
    const dest = ref.position.plus(face);
    const verdict = checkPlace(bot, dest);
    if (!verdict.ok) deny('放置', dest, verdict.reason);
  });
  wrapAsync('placeBlock', () => assertLive('placeBlock'));
  wrapAsync('placeEntity', () => assertLive('placeEntity'));

  wrapAsync('activateBlock', (block: Block, direction?: Vec3) => {
    assertLive('activateBlock');
    const held = bot.heldItem?.name;
    const sneaking = Boolean((bot as unknown as { controlState?: Record<string, boolean> }).controlState?.sneak);
    if (!block) return;
    if (isInteractable(block) && !sneaking) return; // 开门、开箱子
    if (!isModifyingItem(held, bot)) return; // 空手或无害物品
    // 不知道这次右键是改方块本身（锄地、剥树皮）还是往旁边放东西，两处都要有授权并通过检查
    const grant = currentGrant();
    const dest = block.position.plus(direction ?? new Vec3(0, 1, 0));
    const onBlock = checkDig(bot, block.position, grant);
    if (!onBlock.ok) deny(`对方块使用 ${held}`, block.position, onBlock.reason);
    const onDest = checkPlace(bot, dest, grant);
    if (!onDest.ok) deny(`对方块使用 ${held}`, dest, onDest.reason);
  });

  wrap('activateItem', () => {
    assertLive('activateItem');
    const held = bot.heldItem?.name;
    if (!isWorldUseItem(held)) return;
    const target = (bot as unknown as { blockAtCursor?: (d: number) => (Block & { face?: number }) | null }).blockAtCursor?.(5);
    if (!target) deny(`使用 ${held}`, null, '看不清对准的是哪里');
    const grant = currentGrant();
    const dest = target!.position.plus(faceVector(target!.face));
    const take = checkFluidTake(bot, target!.position, grant);
    const put = checkPlace(bot, dest, grant);
    if (!put.ok) deny(`使用 ${held}`, dest, put.reason);
    if (/^bucket$/.test(held!) && !take.ok) deny(`使用 ${held}`, target!.position, take.reason);
  });

  const stale = (name: string) => wrap(name, () => assertLive(name));
  const staleAsync = (name: string) => wrapAsync(name, () => assertLive(name));
  for (const name of ['attack', 'swingArm']) stale(name);
  for (const name of ['equip', 'unequip', 'toss', 'tossStack', 'sleep', 'consume', 'openContainer', 'openBlock', 'openChest', 'openFurnace', 'craft', 'activateEntity', 'activateEntityAt', 'fish']) {
    staleAsync(name);
  }
  // 转头要等几个 tick：mineflayer 的 dig 会先 await lookAt 再发"开始挖掘"包。
  // 转头期间任务被停下时，转完立刻报错，调用方（dig）就不会再往下发包
  for (const name of ['lookAt', 'look']) {
    const original = b[name];
    if (typeof original !== 'function') continue;
    const fn = original as AnyFn;
    b[name] = async function guardedLook(...args: unknown[]) {
      assertLive(name);
      const result = await fn.apply(bot, args);
      assertLive(`${name}（转头完成后）`);
      return result;
    };
  }

  // 最后一道防线：失效任务发出的"开始挖掘"包直接拒绝（取消包、完成包不拦，交给 stopDigging 处理）
  const client = b._client as { write?: AnyFn } | undefined;
  if (client && typeof client.write === 'function') {
    const write = client.write.bind(client) as AnyFn;
    client.write = (name: string, data: { status?: number } | undefined, ...rest: unknown[]) => {
      if ((name === 'block_dig' || name === 'player_action') && data?.status === 0) assertLive('开始挖掘');
      return write(name, data, ...rest);
    };
  }
  // 停止类调用（松开按键、清目标）总是允许
  wrap('setControlState', (_control: string, state: boolean) => {
    if (state) assertLive('setControlState');
  });

  const pf = b.pathfinder as Record<string, unknown> | undefined;
  if (pf) {
    const setMovements = pf.setMovements as AnyFn;
    pf.setMovements = (movements: unknown) => {
      sanitizeMovements(movements, bot);
      return setMovements(movements);
    };
    sanitizeMovements(pf.movements, bot);
    const goto = pf.goto as AnyFn;
    pf.goto = async (goal: unknown) => {
      assertLive('pathfinder.goto');
      return await goto(goal);
    };
    const setGoal = pf.setGoal as AnyFn;
    pf.setGoal = (goal: unknown, dynamic?: boolean) => {
      if (goal) assertLive('pathfinder.setGoal');
      // 悬停时寻路走不了：恢复重力让它落下去（跟随、攻击等直接 setGoal 的地方）
      if (goal && isFlying(bot)) void stopFlying(bot, 0);
      return setGoal(goal, dynamic);
    };
  }

  const creative = b.creative as Record<string, unknown> | undefined;
  if (creative && typeof creative.flyTo === 'function') {
    const flyTo = creative.flyTo as AnyFn;
    creative.flyTo = async (...args: unknown[]) => {
      assertLive('flyTo');
      return await flyTo.apply(creative, args);
    };
  }
}

// 新 Bot 进入世界时调用：先装守卫，再换成安全寻路
export function prepareBot(bot: Bot): void {
  installGuards(bot);
  bot.pathfinder.setMovements(createSafeMovements(bot));
}
