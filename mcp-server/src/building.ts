// build 的执行引擎：整理目标（逐格、形状、蓝图）→ 按当前世界分类 → 先从上往下挖，再分两轮从下往上放
// （先放墙和地板，再放门、床、火把这类要靠别的方块支撑的）。放的时候按方块状态决定转向、点哪个面、点在哪，
// 放完核对状态；够不着的在旁边临时垫高，放完把垫的挖回去。也负责在游戏里摆虚影预览
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import type { ToolFactory, McpResponse } from './tool-factory.js';
import { TaskHandle, useGrant, posKey, type Grant } from './task-control.js';
import { log } from './logger.js';
import { checkDig, checkPlace, createSafeMovements, isInteractable } from './action-policy.js';
import { PROTECTED } from './protected-blocks.js';
import {
  REACH, MAX_CONSECUTIVE_FAILURES, MAX_PILLAR, EMPTY_BLOCKS, LIQUIDS, unlockSchema, vec3Schema, sleep, key, fmt, isEmpty, isSoft,
  occupiedByBot, approach, digAt, eyeDistance, scaffoldItem, pillarStep, descendPillar, waitUntil, addReason, summarizeReasons,
  inventoryCounts, isCreative, creativeTake
} from './tools/block-ops.js';
import {
  type BlockSpec, type Dir, type Placement, HORIZONTAL, parseBlockSpec, formatBlockSpec, validateSpec, itemForBlock, stateMatches,
  controlledProps, isCompanionCell, extraCell, LATE, placementPlan, cursorFor, doorHinge, doorSide, dirVec, yawOf, isDir, clockwise
} from './block-state.js';
import { shapeCells, loadBlueprint, placeBlueprint, type Cell } from './blueprints.js';
import { rconCommands } from './ysm.js';
import { flyTo, landIfFlying } from './flight.js';

const { goals } = pathfinderPkg;

export const MAX_BUILD = 4096;

// ---- 参数 ----

export const shapeSchema = z.object({
  shape: z.enum(['fill', 'hollow', 'walls', 'line', 'roof']).describe(
    "fill = solid box, hollow = box shell, walls = four sides only, line = straight line from→to, " +
    "roof = gable roof of stairs: from/to is the bottom layer's footprint (make it 1 wider than the walls for eaves), each layer steps inward and up, stairs face the ridge"
  ),
  from: vec3Schema,
  to: vec3Schema,
  block: z.string().describe("Block, may carry a state like oak_stairs[facing=east,half=bottom]; \"air\" clears. For roof: the stairs block"),
  ridge: z.enum(['x', 'z']).optional().describe("roof only: ridge runs along this axis (default: the longer side)"),
  ridgeBlock: z.string().optional().describe("roof only: top row when the width is odd (default: same-material bottom slab)"),
  gableBlock: z.string().optional().describe("roof only: fills the triangle gable ends and supports the stairs (default: same-material full block; \"none\" to leave open)")
});

export const targetSchema = {
  blocks: z.array(z.object({
    x: z.coerce.number(),
    y: z.coerce.number(),
    z: z.coerce.number(),
    block: z.string().describe("Block name, optionally with state: oak_stairs[facing=east,half=top], oak_log[axis=x], oak_door[facing=west,hinge=left], wall_torch[facing=north], white_bed[facing=south] (the foot); \"air\" clears")
  })).max(MAX_BUILD).optional().describe("Explicit blocks (absolute coordinates)"),
  shapes: z.array(shapeSchema).max(32).optional().describe("Shapes between two corners (inclusive, absolute coordinates)"),
  blueprint: z.object({
    name: z.string(),
    origin: vec3Schema.describe("Where the blueprint's minimum corner goes (after rotation)"),
    rotation: z.coerce.number().int().optional().describe("Clockwise turn seen from above: 0, 90, 180 or 270 (default 0); facing/axis states turn with it")
  }).optional().describe("Place a saved blueprint (see list-blueprints)")
};

export const buildSchema = {
  ...targetSchema,
  replace: z.enum(['none', 'soft', 'all']).optional().describe("What to do with other blocks in the way: none = skip, soft = only replace grass/flowers/snow/liquids (default), all = dig anything (still skips chests/beds/doors unless allowProtected). Same block with the wrong state (e.g. stairs facing the wrong way) is redone unless none"),
  allowProtected: z.boolean().optional().describe("Allow digging chests, beds, doors, torches, glass... (default: false)"),
  unlockRegions: unlockSchema,
  scaffold: z.boolean().optional().describe("For spots too high to reach from the ground: pillar up next to them with dirt/cobblestone from the inventory (preferring blocks this build does not need), place what is in reach, then dig the pillar back (default: true)"),
  dryRun: z.boolean().optional().describe("Only report the plan: materials needed vs inventory, conflicts (default: false)"),
  preview: z.boolean().optional().describe("Do not build: show glowing ghost blocks in the world where blocks will go (red glass where blocks will be cleared) so the player can check it first; they stay until clear-preview or a real build (needs local RCON)"),
  timeoutSeconds: z.coerce.number().int().min(10).max(600).optional().describe("Stop and report progress after this long (default: 240)"),
  interruptOnChat: z.boolean().optional().describe("Stop when someone mentions your name or says stop (default: true)")
};

export const BUILD_DESCRIPTION =
  "Place and/or clear many blocks in one call. Give `blocks` (explicit list), `shapes` (fill / hollow / walls / line / roof) and/or `blueprint` (a saved design at an origin, rotated 0/90/180/270); later entries override earlier ones (blueprint < shapes < blocks), and \"air\" means clear. " +
  "Blocks may carry states like the /setblock syntax: stairs facing & half, slab top/bottom, log axis, door facing & hinge, bed facing, trapdoor, wall torch, lantern hanging, buttons... — you turn and click the right face so the state comes out right, and it is checked afterwards (states decided by neighbours, like fence connections or stair corners, happen by themselves). " +
  "Each position is re-checked right before acting: already-correct blocks are skipped, grass/flowers are replaced, other blocks follow `replace`. Digs top-down, then places bottom-up; doors, beds, torches and other attached blocks go last. " +
  "Walking never digs or places blocks; spots too high to reach get a temporary dirt/cobblestone pillar (scaffold) that is dug back afterwards. " +
  "Use dryRun for the material list, preview to show the player ghost blocks first, prepare-materials to fetch/craft what is missing. Farmland/crops/registered protected regions are skipped unless unlockRegions. Returns early with progress if a player calls you, you get hurt, or stop-action is used; calling again with the same arguments continues";

type TargetArgs = {
  blocks?: { x: number; y: number; z: number; block: string }[];
  shapes?: z.infer<typeof shapeSchema>[];
  blueprint?: { name: string; origin: { x: number; y: number; z: number }; rotation?: number };
};

type BuildArgs = TargetArgs & {
  replace?: 'none' | 'soft' | 'all';
  allowProtected?: boolean;
  unlockRegions?: string[];
  scaffold?: boolean;
  dryRun?: boolean;
  preview?: boolean;
  timeoutSeconds?: number;
  interruptOnChat?: boolean;
};

// ---- 目标 ----

export interface Target {
  pos: Vec3;
  spec: BlockSpec; // name 为 air 表示清除
  item: string | null;
  extra: Vec3 | null; // 门的上半、床头：放下后自动占用的格子（绝对坐标）
  late: boolean;
}

export function specText(t: Target): string {
  return formatBlockSpec(t.spec);
}

// 把 blocks / shapes / blueprint 合成目标表；写法有错时抛出中文说明
export function resolveTargets(version: string, args: TargetArgs): { targets: Target[]; companions: number } {
  const mcData = minecraftData(version);
  const exists = (n: string) => Boolean(mcData.blocksByName[n]);
  const cells: Cell[] = [];
  if (args.blueprint) {
    const rotation = args.blueprint.rotation ?? 0;
    if (![0, 90, 180, 270].includes(rotation)) throw new Error(`rotation 只能是 0、90、180、270（现在是 ${rotation}）`);
    cells.push(...placeBlueprint(loadBlueprint(args.blueprint.name), args.blueprint.origin, rotation as 0 | 90 | 180 | 270));
  }
  for (const s of args.shapes ?? []) cells.push(...shapeCells(s, MAX_BUILD, exists));
  for (const b of args.blocks ?? []) cells.push({ pos: new Vec3(b.x, b.y, b.z).floored(), block: b.block });

  const map = new Map<string, Target>();
  const errors = new Set<string>();
  let companions = 0;
  const companionAt: Target[] = [];
  for (const c of cells) {
    let spec: BlockSpec;
    try {
      spec = parseBlockSpec(c.block);
    } catch (err) {
      errors.add((err as Error).message);
      continue;
    }
    const problem = validateSpec(spec, mcData as never);
    if (problem) {
      errors.add(problem);
      continue;
    }
    const pos = c.pos.floored();
    if (isCompanionCell(spec)) {
      // 门的上半、床头：放下半 / 床尾时自动出现
      companions += 1;
      map.delete(key(pos));
      companionAt.push({ pos, spec, item: null, extra: null, late: true });
      continue;
    }
    const rel = spec.name === 'air' ? null : extraCell(spec);
    map.set(key(pos), {
      pos,
      spec,
      item: spec.name === 'air' ? null : itemForBlock(spec.name, mcData as never),
      extra: rel ? pos.plus(rel) : null,
      late: spec.name !== 'air' && LATE.test(spec.name)
    });
  }
  if (errors.size) throw new Error([...errors].slice(0, 6).join('；'));
  // 只写了门的上半 / 床头、没写下半 / 床尾的，提示一下
  for (const c of companionAt) {
    const owner = [...map.values()].some((t) => t.extra && t.extra.equals(c.pos) && t.spec.name === c.spec.name);
    if (!owner) throw new Error(`${fmt(c.pos)} 写的是 ${formatBlockSpec(c.spec)}：门请写下半（half=lower），床请写床尾（part=foot）并带上 facing，另一半会自动放上`);
  }
  // 自动占用的格子不能再被别的目标占
  for (const t of map.values()) {
    if (!t.extra) continue;
    const other = map.get(key(t.extra));
    if (other && other.spec.name !== 'air') throw new Error(`${fmt(t.pos)} 的 ${specText(t)} 会占用 ${fmt(t.extra)}，但那里又写了 ${specText(other)}`);
    if (other) map.delete(key(t.extra));
  }
  if (map.size > MAX_BUILD) throw new Error(`目标太多：${map.size} 格，单次最多 ${MAX_BUILD} 格，请分批`);
  return { targets: [...map.values()], companions };
}

function currentMatches(bot: Bot, t: Target): boolean {
  const b = bot.blockAt(t.pos);
  if (!b) return false;
  if (t.spec.name === 'air') return isEmpty(b);
  return stateMatches(t.spec, b.name, b.getProperties() as Record<string, unknown>);
}

// 还要放多少物品（已经符合的不算）
export function materialNeeds(bot: Bot, targets: Target[]): Map<string, number> {
  const need = new Map<string, number>();
  for (const t of targets) {
    if (!t.item || currentMatches(bot, t)) continue;
    need.set(t.item, (need.get(t.item) ?? 0) + 1);
  }
  return need;
}

// ---- 分类 ----

interface Classified {
  toDig: Vec3[];
  clearing: Map<string, number>; // 要挖掉的方块名 → 数量（草和花不算）
  toPlace: Target[];
  already: number;
  skipped: Map<string, Vec3[]>;
}

function classify(bot: Bot, targets: Target[], grant: Grant, replace: 'none' | 'soft' | 'all'): Classified {
  const toDig: Vec3[] = [];
  const toPlace: Target[] = [];
  const skipped = new Map<string, Vec3[]>();
  const clearing = new Map<string, number>();
  let already = 0;
  const digOk = (pos: Vec3): string | null => {
    grant.dig.add(posKey(pos));
    const verdict = checkDig(bot, pos, grant);
    if (verdict.ok) return null;
    grant.dig.delete(posKey(pos));
    return verdict.reason;
  };
  const placeOk = (pos: Vec3): string | null => {
    grant.place.add(posKey(pos));
    const verdict = checkPlace(bot, pos, grant);
    if (verdict.ok) return null;
    grant.place.delete(posKey(pos));
    return verdict.reason;
  };
  for (const t of targets) {
    const current = bot.blockAt(t.pos);
    if (!current) {
      addReason(skipped, '区块未加载', t.pos);
      continue;
    }
    const air = t.spec.name === 'air';
    if (currentMatches(bot, t)) {
      already += 1;
      continue;
    }
    if (air && LIQUIDS.has(current.name)) {
      addReason(skipped, '液体没法挖掉', t.pos);
      continue;
    }
    const sameWrongState = !air && current.name === t.spec.name;
    if (sameWrongState && replace === 'none') {
      addReason(skipped, `已经是 ${current.name}，但状态不对（replace=none）`, t.pos);
      continue;
    }
    const needsClear = air || (!isEmpty(current) && (isSoft(current) || sameWrongState || replace === 'all'));
    if (!air && !isEmpty(current) && !needsClear) {
      addReason(skipped, `已有其他方块（replace=${replace}）`, t.pos);
      continue;
    }
    const digs: Vec3[] = needsClear ? [t.pos] : [];
    if (!air && t.extra) {
      const e = bot.blockAt(t.extra);
      if (!e) {
        addReason(skipped, '区块未加载', t.pos);
        continue;
      }
      // 要重放的门 / 床自己的另一半：拆掉这一半时会一起消失
      const ownHalf = sameWrongState && e.name === t.spec.name;
      if (!isEmpty(e) && !ownHalf) {
        if (isSoft(e) || (replace === 'all' && !PROTECTED.test(e.name))) digs.push(t.extra);
        else {
          addReason(skipped, `${t.spec.name} 要占用的 ${fmt(t.extra)} 被 ${e.name} 占着`, t.pos);
          continue;
        }
      }
    }
    let reason: string | null = null;
    for (const d of digs) reason ??= digOk(d);
    if (!reason && !air) {
      reason = placeOk(t.pos);
      if (!reason && t.extra) reason = placeOk(t.extra);
    }
    if (reason) {
      for (const d of digs) grant.dig.delete(posKey(d));
      grant.place.delete(posKey(t.pos));
      if (t.extra) grant.place.delete(posKey(t.extra));
      addReason(skipped, reason, t.pos);
      continue;
    }
    toDig.push(...digs);
    for (const d of digs) {
      const name = bot.blockAt(d)?.name;
      if (name && !isSoft(bot.blockAt(d)!)) clearing.set(name, (clearing.get(name) ?? 0) + 1);
    }
    if (!air) toPlace.push(t);
  }
  return { toDig, clearing, toPlace, already, skipped };
}

// ---- 预览 ----

const PREVIEW_TAG = 'mcbot_preview';
let previewActive = false;

function dimensionId(bot: Bot): string {
  const d = String(bot.game?.dimension ?? 'overworld');
  return d.includes(':') ? d : `minecraft:${d}`;
}

function displayNbt(spec: BlockSpec, ghost: boolean): string {
  const props = Object.entries(spec.props).map(([k, v]) => `${k}:"${v}"`).join(',');
  const state = `{Name:"minecraft:${spec.name}"${props ? `,Properties:{${props}}` : ''}}`;
  const [scale, shift, color] = ghost ? ['0.8f', '0.1f', 8453888] : ['1.02f', '-0.01f', 16711680];
  return `{block_state:${state},Tags:["${PREVIEW_TAG}"],Glowing:1b,glow_color_override:${color},` +
    `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[${shift},${shift},${shift}],scale:[${scale},${scale},${scale}]}}`;
}

export async function clearPreview(): Promise<string | null> {
  const r = await rconCommands([`kill @e[type=minecraft:block_display,tag=${PREVIEW_TAG}]`]);
  if (!r.error) previewActive = false;
  return r.error;
}

async function showPreview(bot: Bot, toPlace: Target[], toClear: Vec3[]): Promise<string> {
  const dim = dimensionId(bot);
  const cmds = [`kill @e[type=minecraft:block_display,tag=${PREVIEW_TAG}]`];
  for (const t of toPlace) cmds.push(`execute in ${dim} run summon minecraft:block_display ${t.pos.x} ${t.pos.y} ${t.pos.z} ${displayNbt(t.spec, true)}`);
  for (const p of toClear) cmds.push(`execute in ${dim} run summon minecraft:block_display ${p.x} ${p.y} ${p.z} ${displayNbt({ name: 'red_stained_glass', props: {} }, false)}`);
  const r = await rconCommands(cmds, { timeoutMs: 60000 });
  if (r.done > 1) previewActive = true;
  if (r.error) return `预览没摆完：${r.error}（摆了 ${Math.max(0, r.done - 1)} 个）`;
  return `已在游戏里摆出预览：${toPlace.length} 个发光的虚影方块是要放的${toClear.length ? `，${toClear.length} 个红玻璃框是要清掉的` : ''}。看完用 clear-preview 清掉，或者直接 build（开工时会自动清掉）`;
}

// ---- 放置 ----

type PlaceResult =
  | { kind: 'placed' }
  | { kind: 'already' }
  | { kind: 'defer' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

function eyePos(bot: Bot): Vec3 {
  return bot.entity.position.offset(0, (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
}

interface Engine {
  bot: Bot;
  grant: Grant;
  handle: TaskHandle;
  targetKeys: Set<string>;
  avoidScaffold: Set<string>;
  notes: Map<string, Vec3[]>;
}

// 按原版规则反推放错了朝向时学到的偏差：方块名 → 实际朝向相对玩家朝向转了几次（顺时针）
const learnedTurns = new Map<string, number>();

function turn(d: Dir, n: number): Dir {
  let r = d;
  for (let i = 0; i < ((n % 4) + 4) % 4; i++) r = clockwise(r);
  return r;
}

function turnsBetween(from: Dir, to: Dir): number {
  return (HORIZONTAL.indexOf(to) - HORIZONTAL.indexOf(from) + 4) % 4;
}

// 取出最低一层里离 here 最近的目标
export function takeNearest<T extends { pos: Vec3 }>(queue: T[], here: Vec3): T {
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    const a = queue[i].pos;
    const b = queue[best].pos;
    if (a.y < b.y || (a.y === b.y && a.distanceSquared(here) < b.distanceSquared(here))) best = i;
  }
  return queue.splice(best, 1)[0];
}

function isSolidSupport(b: Block | null): b is Block {
  return Boolean(b && !isEmpty(b) && !isSoft(b) && b.boundingBox === 'block');
}

function isFullCube(b: Block | null): boolean {
  if (!b || b.boundingBox !== 'block') return false;
  const shapes = (b as unknown as { shapes?: number[][] }).shapes ?? [];
  return shapes.length === 1 && shapes[0].join(',') === '0,0,0,1,1,1';
}

function withLearned(spec: BlockSpec, opt: Placement): Placement {
  const facing = spec.props.facing;
  const learned = learnedTurns.get(spec.name);
  if (learned === undefined || !opt.horizontal || !facing || !isDir(facing) || !HORIZONTAL.includes(facing)) return opt;
  return { ...opt, horizontal: turn(facing, -learned) };
}

function chooseSupport(bot: Bot, t: Target): { opt: Placement; face: Dir; ref: Block } | null {
  const plan = placementPlan(t.spec);
  for (const raw of plan.options) {
    const opt = withLearned(t.spec, raw);
    for (const face of opt.faces) {
      const ref = bot.blockAt(t.pos.minus(dirVec(face)));
      if (isSolidSupport(ref)) return { opt, face, ref };
    }
  }
  return null;
}

// 门轴：试四个点击位置，挑一个按原版规则能得到想要门轴的
function doorHitFor(bot: Bot, t: Target, horizontal: Dir, want: 'left' | 'right'): { x: number; z: number } | null {
  const neighbor = (side: 'left' | 'right', upper: boolean) => {
    const p = t.pos.plus(dirVec(doorSide(horizontal, side))).offset(0, upper ? 1 : 0, 0);
    const b = bot.blockAt(p);
    const props = (b?.getProperties() ?? {}) as Record<string, unknown>;
    return { full: isFullCube(b), lowerDoor: Boolean(b && b.name === t.spec.name && props.half === 'lower') };
  };
  for (const hit of [{ x: 0.5, z: 0.5 }, { x: 0.25, z: 0.25 }, { x: 0.75, z: 0.25 }, { x: 0.25, z: 0.75 }, { x: 0.75, z: 0.75 }]) {
    if (doorHinge(horizontal, hit, neighbor) === want) return hit;
  }
  return null;
}

function horizontalOfYaw(yaw: number): Dir {
  // mineflayer yaw：0 北、π/2 西、π 南、-π/2 东
  const i = Math.round(((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 2)) % 4;
  return (['north', 'west', 'south', 'east'] as Dir[])[i];
}

async function pickUpNear(bot: Bot, pos: Vec3, handle: TaskHandle): Promise<void> {
  await sleep(300);
  const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 3);
  if (!drop) return;
  try {
    await approach(bot, () => new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1), 8000, handle);
    await sleep(250);
  } catch {
    // 捡不到就算了
  }
}

// 走到能放的位置：不站在目标格，也不站在门上半 / 床头要占的那格
function placeGoal(bot: Bot, t: Target, face: Dir) {
  const goal = new goals.GoalPlaceBlock(t.pos, bot.world, { range: REACH - 0.5, faces: [dirVec(face).scaled(-1)], LOS: false } as never);
  // 身体（脚和头两格）不能和要放的格子重叠。safeGoto 判断「到了没」时连头那格也当节点算，
  // 所以上下各多排除一格，否则站在目标格上会被当成已经到了（「自己站在这个位置上，挪不开」）
  const cells = [t.pos, ...(t.extra ? [t.extra] : [])];
  const isEnd = goal.isEnd.bind(goal);
  goal.isEnd = (node: Parameters<typeof isEnd>[0]) =>
    !cells.some((c) => node.x === c.x && node.z === c.z && Math.abs(node.y - c.y) <= 1) && isEnd(node);
  return goal;
}

async function placeOne(e: Engine, t: Target, walk: boolean, retry = true): Promise<PlaceResult> {
  const { bot, handle } = e;
  const current = bot.blockAt(t.pos);
  if (!current) return { kind: 'skip', reason: '区块未加载' };
  if (currentMatches(bot, t)) return { kind: 'already' };
  if (!isEmpty(current) && !isSoft(current)) return { kind: 'skip', reason: `位置被 ${current.name} 占了` };
  if (t.extra) {
    const x = bot.blockAt(t.extra);
    if (x && !isEmpty(x) && !isSoft(x)) return { kind: 'skip', reason: `${t.spec.name} 要占用的 ${fmt(t.extra)} 被 ${x.name} 占了` };
  }
  let item = bot.inventory.items().find((i) => i.name === t.item);
  // 创造模式不消耗材料，没有就从创造物品栏拿一组
  if (!item && t.item && await creativeTake(bot, t.item, e.avoidScaffold)) item = bot.inventory.items().find((i) => i.name === t.item);
  if (!item) return { kind: 'skip', reason: `${t.item} 用完了` };
  const choice = chooseSupport(bot, t);
  if (!choice) return { kind: 'defer' };
  const { opt, face, ref } = choice;
  const occupied = () => occupiedByBot(bot, t.pos) || (t.extra !== null && occupiedByBot(bot, t.extra));
  const refPoint = () => ref.position.plus(cursorFor(face, opt.hitY));
  const tooFar = () => eyePos(bot).distanceTo(refPoint()) > REACH;
  if (occupied() || tooFar()) {
    if (!walk) return { kind: 'unreachable', reason: '站在这里够不着' };
    try {
      // 原版服务器放方块只检查距离、不检查视线；要求看得见那个面的话，站在地上永远放不了墙顶上的方块
      await approach(bot, () => placeGoal(bot, t, face), 12000, handle);
    } catch (err) {
      const stop = handle.check();
      if (stop) return { kind: 'fail', reason: stop };
      return { kind: 'unreachable', reason: `够不着（${(err as Error).message}）` };
    }
    if (occupied()) return { kind: 'fail', reason: '自己站在这个位置上，挪不开' };
    if (tooFar()) return { kind: 'unreachable', reason: '走到最近也够不着' };
  }

  // 朝向、俯仰、点击位置
  const eye = eyePos(bot);
  const horizontal = opt.horizontal ?? (opt.hinge ? horizontalOfYaw(Math.atan2(-(refPoint().x - eye.x), -(refPoint().z - eye.z))) : undefined);
  let hitXZ: { x: number; z: number } | undefined;
  if (opt.hinge && horizontal) {
    const hit = doorHitFor(bot, t, horizontal, opt.hinge);
    if (hit) hitXZ = hit;
    else addReason(e.notes, `门轴由旁边的方块决定，放不成 hinge=${opt.hinge}`, t.pos);
  }
  const delta = cursorFor(face, opt.hitY, hitXZ);
  const point = ref.position.plus(delta);
  const d = point.minus(eye);
  let yaw = Math.atan2(-d.x, -d.z);
  let pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  if (horizontal) yaw = yawOf(horizontal);
  if (opt.look === 'up') pitch = 1.35;
  else if (opt.look === 'down') pitch = -1.35;
  else if (opt.look) {
    yaw = yawOf(opt.look);
    pitch = 0;
  }

  if (bot.heldItem?.type !== item.type) await bot.equip(item, 'hand');
  const sneak = isInteractable(ref) || PROTECTED.test(ref.name);
  if (sneak) bot.setControlState('sneak', true);
  try {
    await bot.look(yaw, pitch);
    await (bot as unknown as { _genericPlace: (r: Block, f: Vec3, o: object) => Promise<unknown> })._genericPlace(ref, dirVec(face), { delta, forceLook: 'ignore', swingArm: 'right' });
  } catch (err) {
    log('warn', `build place ${fmt(t.pos)}: ${err}`);
    if (handle.check()) return { kind: 'fail', reason: handle.check()! };
  } finally {
    if (sneak) bot.setControlState('sneak', false);
  }
  await waitUntil(() => {
    const b = bot.blockAt(t.pos);
    return Boolean(b && !isEmpty(b) && !isSoft(b));
  }, 1500);

  const after = bot.blockAt(t.pos);
  if (!after || after.name !== t.spec.name) {
    return { kind: 'fail', reason: `放置失败（现在是 ${after?.name ?? '未知'}，可能有生物挡着或没贴住）` };
  }
  const props = after.getProperties() as Record<string, unknown>;
  if (stateMatches(t.spec, after.name, props)) return { kind: 'placed' };

  // 放上了但状态不对。朝向错了、而且是按玩家朝向决定的：记下偏差，挖掉按修正后的朝向重放一次
  const want = t.spec.props.facing;
  const got = String(props.facing ?? '');
  const wrong = Object.entries(controlledProps(t.spec)).filter(([k, v]) => String(props[k]) !== v).map(([k, v]) => `${k}=${props[k]}（要 ${v}）`);
  if (retry && horizontal && want && isDir(want) && HORIZONTAL.includes(want) && isDir(got) && HORIZONTAL.includes(got) && got !== want) {
    learnedTurns.set(t.spec.name, turnsBetween(horizontal, got));
    log('info', `build：${t.spec.name} 朝向和规则对不上，学到偏差 ${learnedTurns.get(t.spec.name)}，重放 ${fmt(t.pos)}`);
    const saved = e.grant.allowProtected;
    e.grant.allowProtected = true; // 自己刚放的，拆掉重放
    e.grant.dig.add(posKey(t.pos));
    try {
      await bot.dig(after, true);
    } catch (err) {
      return { kind: 'fail', reason: `朝向放错了（${wrong.join('，')}），想拆掉重放但失败：${(err as Error).message}` };
    } finally {
      e.grant.allowProtected = saved;
    }
    if (!bot.inventory.items().some((i) => i.name === t.item)) await pickUpNear(bot, t.pos, handle);
    return placeOne(e, t, walk, false);
  }
  addReason(e.notes, `放上了但状态不对：${wrong.join('，')}`, t.pos);
  return { kind: 'placed' };
}

// ---- 垫高 ----

interface Column {
  base: Vec3; // 垫之前脚站的格子
  height: number;
}

function findColumns(e: Engine, target: Vec3): Column[] {
  const { bot, grant } = e;
  const out: (Column & { score: number })[] = [];
  const center = target.offset(0.5, 0.5, 0.5);
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (!dx && !dz) continue;
      const cx = target.x + dx, cz = target.z + dz;
      let surface: number | null = null;
      for (let y = target.y - 1; y >= target.y - 12; y--) {
        const b = bot.blockAt(new Vec3(cx, y, cz));
        if (!b) break;
        if (isEmpty(b) || isSoft(b)) continue;
        if (b.boundingBox === 'block' && !LIQUIDS.has(b.name)) surface = y;
        break;
      }
      if (surface === null) continue;
      const feet = surface + 1;
      let height = -1;
      for (let h = 1; h <= MAX_PILLAR; h++) {
        const eyeP = new Vec3(cx + 0.5, feet + h + 1.62, cz + 0.5);
        if (eyeP.distanceTo(center) <= REACH - 0.3) {
          height = h;
          break;
        }
      }
      if (height < 0) continue;
      let ok = true;
      for (let y = feet; y <= feet + height + 1 && ok; y++) {
        const p = new Vec3(cx, y, cz);
        const b = bot.blockAt(p);
        const clear = b && (EMPTY_BLOCKS.has(b.name) || (y === feet && isSoft(b)));
        if (!clear || e.targetKeys.has(key(p))) ok = false;
      }
      if (!ok) continue;
      // 垫的方块和站上去的位置都要允许放（保护区域、农田）
      for (let y = feet; y < feet + height && ok; y++) {
        const p = new Vec3(cx, y, cz);
        const had = grant.place.has(posKey(p));
        grant.place.add(posKey(p));
        if (!checkPlace(bot, p, grant).ok) {
          ok = false;
          if (!had) grant.place.delete(posKey(p));
        }
      }
      if (!ok) continue;
      // 站在正在盖的东西上（屋顶、墙头）一般走不上去，排后面
      const onBuild = e.targetKeys.has(key(new Vec3(cx, surface, cz)));
      out.push({ base: new Vec3(cx, feet, cz), height, score: height * 3 + Math.hypot(dx, dz) + (onBuild ? 20 : 0) });
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

// 先让寻路算一下走不走得到（不动身体），省得一个个走过去试到超时
function canWalkTo(bot: Bot, p: Vec3): boolean {
  try {
    const pf = bot.pathfinder as unknown as { getPathTo?: (m: unknown, g: unknown, timeout?: number) => { status: string } };
    if (typeof pf.getPathTo !== 'function') return true;
    return pf.getPathTo(bot.pathfinder.movements, new goals.GoalBlock(p.x, p.y, p.z), 1500).status === 'success';
  } catch {
    return true;
  }
}

// 够不着 pos 的时候，在旁边垫高站上去做 work，做完下来把垫的方块挖回去。
// work 返回 true 表示这回成了，不用再换位置；最多试 3 个位置。成功返回 null，否则返回原因
async function pillarAndWork(e: Engine, pos: Vec3, verb: string, work: () => Promise<boolean>): Promise<string | null> {
  const { bot, grant, handle } = e;
  if (!scaffoldItem(bot, e.avoidScaffold)) return `太高够不着，身上也没有能垫脚的方块（泥土、圆石等）`;
  const all = findColumns(e, pos);
  if (!all.length) return '太高够不着，旁边也找不到能垫高的地方';
  const columns: Column[] = [];
  for (const c of all) {
    if (columns.length >= 3) break;
    if (canWalkTo(bot, c.base)) columns.push(c);
  }
  if (!columns.length) return `太高够不着，旁边能垫高的 ${all.length} 个位置都走不过去（在屋里、墙头或屋顶上）`;
  let lastErr = '';
  log('info', `build：${fmt(pos)} 够不着，候选垫高位置 ${columns.map((c) => `${fmt(c.base)}+${c.height}`).join(' ')}`);
  for (const col of columns) {
    if (handle.check()) break;
    try {
      await approach(bot, () => new goals.GoalBlock(col.base.x, col.base.y, col.base.z), 8000, handle);
    } catch (err) {
      lastErr = (err as Error).message;
      continue;
    }
    if (!bot.entity.position.floored().equals(col.base)) continue;
    const pillar: Vec3[] = [];
    let done = false;
    try {
      while (pillar.length < col.height && !handle.check()) {
        const step = await pillarStep(bot, grant, e.avoidScaffold);
        if (!step) break;
        pillar.push(step);
      }
      done = await work();
    } finally {
      if (pillar.length) {
        try {
          await descendPillar(bot, pillar, grant);
          await sleep(300);
        } catch (err) {
          log('warn', `从垫的方块上下来失败：${(err as Error).message ?? err}`);
        }
      }
    }
    if (done) return null;
    lastErr = pillar.length ? `垫高 ${pillar.length} 格还是${verb}不到` : '垫不起来（头顶或脚下有东西挡着）';
  }
  return `太高够不着：${lastErr || '走不到能垫高的地方'}`;
}

// 创造模式：飞到 pos 旁边悬停着做 work（不落地，下一轮要走路时会自动落地）。返回值同 pillarAndWork
async function hoverAndWork(e: Engine, pos: Vec3, verb: string, work: () => Promise<boolean>): Promise<string | null> {
  const { bot, handle } = e;
  const free = (p: Vec3) => {
    const b = bot.blockAt(p);
    return Boolean(b && b.shapes.length === 0 && !LIQUIDS.has(b.name) && !e.targetKeys.has(key(p)));
  };
  const target = pos.offset(0.5, 0.5, 0.5);
  const spots: Vec3[] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) {
    if (dx === 0 && dz === 0 && dy >= -2 && dy <= 1) continue; // 不和目标格重叠
    const c = pos.offset(dx, dy, dz);
    if (c.offset(0.5, 1.62, 0.5).distanceTo(target) > REACH - 0.5) continue;
    if (free(c) && free(c.offset(0, 1, 0))) spots.push(c);
  }
  if (!spots.length) return '太高够不着，旁边也没有能飞过去悬停的空地';
  const here = bot.entity.position;
  spots.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  let lastErr = '';
  for (const spot of spots.slice(0, 3)) {
    if (handle.check()) break;
    const r = await flyTo(bot, spot, { stay: true });
    if (!r.ok) {
      lastErr = r.message;
      continue;
    }
    if (await work()) return null;
    lastErr = `飞到旁边了还是${verb}不到`;
  }
  return `太高够不着：${lastErr || '飞不过去'}`;
}

// 站在（悬停在）这里，把够得着的 pending 都放掉；可能要好几轮：有的要等旁边的先放好才有地方贴
async function placeReachable(e: Engine, pending: Target[], placed: Set<Target>): Promise<void> {
  let progress = true;
  while (progress && !e.handle.check()) {
    progress = false;
    for (const t of pending.filter((x) => !placed.has(x)).sort((a, b) => a.pos.y - b.pos.y)) {
      if (e.handle.check()) break;
      const r = await placeOne(e, t, false);
      if (r.kind === 'placed' || r.kind === 'already') {
        placed.add(t);
        progress = true;
      }
    }
  }
}

// 够不着 first：生存模式垫高、创造模式飞过去，把够得着的 pending 目标都放掉。返回放下的目标
async function placeFromHigh(e: Engine, creative: boolean, first: Target, pending: Target[]): Promise<{ placed: Set<Target>; reason: string | null }> {
  const placed = new Set<Target>();
  const work = async () => {
    await placeReachable(e, pending, placed);
    // 垫高时放上了几个就算这回成了；飞的话要放上 first 才算（换个悬停位置很便宜）
    return creative ? placed.has(first) : placed.size > 0;
  };
  const r = creative ? await hoverAndWork(e, first.pos, '放', work) : await pillarAndWork(e, first.pos, '放', work);
  return { placed, reason: r };
}

// 挖的时候够不着的高处方块：同样垫高或飞过去，把够得着的都挖掉（从上往下）
async function digFromHigh(e: Engine, creative: boolean, first: Vec3, pending: Vec3[]): Promise<{ dug: Set<Vec3>; count: number; reason: string | null }> {
  const { bot, grant, handle } = e;
  const dug = new Set<Vec3>();
  let count = 0;
  const work = async () => {
    for (const p of pending.filter((x) => !dug.has(x)).sort((a, b) => b.y - a.y)) {
      if (handle.check()) break;
      const b = bot.blockAt(p);
      if (!b || isEmpty(b)) {
        dug.add(p);
        continue;
      }
      // 只挖站在这里就够得着、看得见的；digAt 够不着会走过去，那样就从垫的方块上下来了
      if (eyeDistance(bot, p) > REACH || (b.shapes.length && !bot.canSeeBlock(b))) continue;
      try {
        const res = await digAt(bot, p, grant, { requireDrops: false, clearFalling: true, handle });
        if (res === 'dug' || res === '已经是空的') dug.add(p);
        if (res === 'dug') count += 1;
      } catch (err) {
        log('warn', `build：在高处挖 ${fmt(p)} 失败：${(err as Error).message ?? err}`);
      }
    }
    return dug.has(first);
  };
  const r = creative ? await hoverAndWork(e, first, '挖', work) : await pillarAndWork(e, first, '挖', work);
  return { dug, count, reason: r };
}

// 悬空的目标：在它要贴的那一面旁边临时放一块泥土（空着、不是要盖的格子），贴着放好目标再把泥土挖掉
async function withTempSupport(e: Engine, t: Target): Promise<boolean> {
  const { bot, grant, handle } = e;
  const item = scaffoldItem(bot, e.avoidScaffold)?.name ?? (isCreative(bot) ? 'dirt' : null);
  if (!item) return false;
  const tried = new Set<string>();
  for (const raw of placementPlan(t.spec).options) {
    const opt = withLearned(t.spec, raw);
    for (const face of opt.faces) {
      const n = t.pos.minus(dirVec(face));
      const k = key(n);
      if (tried.has(k) || e.targetKeys.has(k)) continue;
      tried.add(k);
      const b = bot.blockAt(n);
      if (!b || !(isEmpty(b) || isSoft(b))) continue;
      grant.place.add(posKey(n));
      if (!checkPlace(bot, n, grant).ok) {
        grant.place.delete(posKey(n));
        continue;
      }
      const helper: Target = { pos: n, spec: parseBlockSpec(item), item, extra: null, late: false };
      const r1 = await placeOne(e, helper, true);
      if (r1.kind !== 'placed') continue;
      let ok = false;
      try {
        const r2 = await placeOne(e, t, true);
        ok = r2.kind === 'placed' || r2.kind === 'already';
      } finally {
        try {
          await digAt(bot, n, grant, { requireDrops: false, clearFalling: false, handle });
        } catch (err) {
          addReason(e.notes, `临时支撑没挖掉：${(err as Error).message ?? err}`, n);
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

// ---- 入口 ----

export async function runBuild(factory: ToolFactory, bot: Bot, args: BuildArgs): Promise<McpResponse> {
  const {
    replace = 'soft', allowProtected = false, unlockRegions, scaffold = true, dryRun = false, preview = false,
    timeoutSeconds = 240, interruptOnChat = true
  } = args;
  let targets: Target[];
  let companions = 0;
  try {
    ({ targets, companions } = resolveTargets(bot.version, args));
  } catch (err) {
    return factory.createResponse((err as Error).message);
  }
  if (!targets.length) return factory.createResponse('没有要处理的方块（blocks、shapes、blueprint 都为空）');

  const grant = useGrant({ allowProtected, unlockRegions });
  const { toDig, clearing, toPlace, already, skipped } = classify(bot, targets, grant, replace);

  const need = new Map<string, number>();
  for (const t of toPlace) need.set(t.item!, (need.get(t.item!) ?? 0) + 1);
  const have = inventoryCounts(bot);
  // 创造模式放方块不消耗，有一个就够；没有的开工时从创造物品栏拿
  const creative = isCreative(bot);
  const shortage = creative ? [] : [...need.entries()]
    .filter(([n, c]) => (have.get(n) ?? 0) < c)
    .map(([n, c]) => `${n} 缺 ${c - (have.get(n) ?? 0)}（需要 ${c}，有 ${have.get(n) ?? 0}）`);
  const planLines = [
    `目标 ${targets.length} 格${companions ? `（另有 ${companions} 格门上半 / 床头会自动出现）` : ''}：已符合 ${already}，要挖 ${toDig.length}，要放 ${toPlace.length}`,
    need.size ? `材料：${[...need.entries()].map(([n, c]) => `${n} x${c}`).join('，')}` : '不需要材料'
  ];
  if (clearing.size) {
    const list = [...clearing.entries()].sort((a, b) => b[1] - a[1]);
    planLines.push(`要挖掉的方块：${list.slice(0, 10).map(([n, c]) => `${n} x${c}`).join('，')}${list.length > 10 ? ' 等' : ''}${list.some(([n]) => /_log$|_leaves$/.test(n)) ? '（有树：只挖掉范围里的部分会留下半截树，先用 mine-blocks 把整棵砍掉更好）' : ''}`);
  }
  if (creative) planLines.push('创造模式：放方块不消耗材料，身上没有的开工时自动从创造物品栏拿');
  if (shortage.length) planLines.push(`材料不足：${shortage.join('；')}（可以先用 prepare-materials 从箱子里拿、自己合成）`);
  if (skipped.size) planLines.push('会跳过：', ...summarizeReasons(skipped));
  if (dryRun) return factory.createResponse(['【预演，没有实际操作】', ...planLines].join('\n'));
  if (preview) {
    const toClear = toDig.filter((p) => !toPlace.some((t) => t.pos.equals(p)));
    return factory.createResponse(['【预览，没有实际操作】', ...planLines, await showPreview(bot, toPlace, toClear)].join('\n'));
  }
  if (previewActive) {
    const err = await clearPreview();
    if (err) log('warn', `清除预览失败：${err}`);
  }

  const handle = new TaskHandle({ timeoutMs: timeoutSeconds * 1000, interruptOnChat });
  const originalMovements = bot.pathfinder.movements;
  bot.pathfinder.setMovements(createSafeMovements(bot));
  const engine: Engine = {
    bot,
    grant,
    handle,
    targetKeys: new Set(targets.filter((t) => t.spec.name !== 'air').flatMap((t) => [key(t.pos), ...(t.extra ? [key(t.extra)] : [])])),
    avoidScaffold: new Set(need.keys()),
    notes: new Map()
  };

  let dug = 0;
  let placed = 0;
  let pillars = 0;
  let flights = 0;
  let temps = 0;
  let stopReason: string | null = null;
  let consecutiveFailures = 0;
  const fail = (reason: string, pos: Vec3): boolean => {
    addReason(skipped, reason, pos);
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stopReason = `连续 ${MAX_CONSECUTIVE_FAILURES} 次失败`;
      return true;
    }
    return false;
  };

  try {
    toDig.sort((a, b) => b.y - a.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    // 走不过去够不着的高处方块，留到后面垫高（创造模式飞上去）挖；
    // 旁边同样高或更高的就不再一个个找路了，找一次路可能要十几秒
    const highDig: Vec3[] = [];
    const nearHigh = (p: Vec3) => highDig.some((h) => p.y >= h.y && Math.hypot(p.x - h.x, p.z - h.z) <= 3);
    for (const pos of toDig) {
      stopReason = handle.check();
      if (stopReason) break;
      if (scaffold && nearHigh(pos) && eyeDistance(bot, pos) > REACH) {
        highDig.push(pos);
        continue;
      }
      try {
        const result = await digAt(bot, pos, grant, { requireDrops: false, clearFalling: true, handle });
        if (result === 'dug') {
          dug += 1;
          consecutiveFailures = 0;
        } else if (scaffold && result.startsWith('够不着') && !handle.check()) {
          highDig.push(pos);
        } else if (result !== '已经是空的' && fail(result, pos)) {
          break;
        }
      } catch (err) {
        if (fail(`挖掘失败：${(err as Error).message ?? err}`, pos)) break;
      }
    }
    while (highDig.length && !stopReason) {
      stopReason = handle.check();
      if (stopReason) break;
      const first = highDig.shift()!;
      const r = await digFromHigh(engine, creative, first, [first, ...highDig]);
      if (r.count && creative) flights += 1;
      else if (r.count) pillars += 1;
      dug += r.count;
      for (const p of r.dug) {
        const i = highDig.indexOf(p);
        if (i >= 0) highDig.splice(i, 1);
      }
      if (r.reason && !r.dug.has(first)) addReason(skipped, r.reason, first);
    }

    const phases = [toPlace.filter((t) => !t.late), toPlace.filter((t) => t.late)];
    for (const phase of phases) {
      if (stopReason) break;
      let pending = phase;
      const high: Target[] = [];
      while (pending.length && !stopReason) {
        const deferred: Target[] = [];
        let progress = false;
        // 一层一层往上放；同一层每次挑离自己最近的，免得在房子两头来回跑
        const queue = [...pending];
        while (queue.length) {
          const t = takeNearest(queue, bot.entity.position);
          stopReason = handle.check();
          if (stopReason) break;
          let r: PlaceResult;
          try {
            r = await placeOne(engine, t, true);
          } catch (err) {
            stopReason = handle.check();
            if (stopReason) break;
            r = { kind: 'fail', reason: `放置失败：${(err as Error).message ?? err}` };
          }
          if (r.kind === 'placed' || r.kind === 'already') {
            if (r.kind === 'placed') placed += 1;
            progress = true;
            consecutiveFailures = 0;
          } else if (r.kind === 'defer') {
            deferred.push(t);
          } else if (r.kind === 'unreachable' && scaffold) {
            high.push(t);
          } else if (r.kind === 'skip') {
            addReason(skipped, r.reason, t.pos);
          } else if (fail(r.reason, t.pos)) {
            break;
          }
        }
        // 够不着的：垫高去放。放上之后可能又给悬空的目标提供了支撑，再来一轮
        while (high.length && !stopReason) {
          stopReason = handle.check();
          if (stopReason) break;
          const first = high.shift()!;
          const rest = [first, ...high, ...deferred];
          // 创造模式直接飞过去悬停着放，不找垫高的位置
          const r = await placeFromHigh(engine, creative, first, rest);
          if (creative) flights += 1;
          else pillars += 1;
          for (const t of r.placed) {
            placed += 1;
            progress = true;
            const i = high.indexOf(t);
            if (i >= 0) high.splice(i, 1);
            const j = deferred.indexOf(t);
            if (j >= 0) deferred.splice(j, 1);
          }
          if (r.reason && !r.placed.has(first)) addReason(skipped, r.reason, first.pos);
        }
        if (!progress) {
          // 悬空的（比如两边都空着的上半砖）：在旁边临时放一块当支撑，放好再挖掉；放上一个后别的可能就有地方贴了
          let helped: Target | null = null;
          for (const t of deferred) {
            if ((stopReason = handle.check())) break;
            if (await withTempSupport(engine, t)) {
              helped = t;
              break;
            }
          }
          if (helped) {
            placed += 1;
            temps += 1;
            pending = deferred.filter((t) => t !== helped);
            continue;
          }
          deferred.forEach((t) => addReason(skipped, '悬空，旁边没有能贴着放的方块，临时支撑也放不上（或者这个状态需要的那一面没有支撑）', t.pos));
          break;
        }
        pending = deferred;
      }
    }
  } finally {
    bot.pathfinder.setMovements(originalMovements);
    await landIfFlying(bot);
  }

  const lines = [`放置 ${placed} 个，清除 ${dug} 个，原本就符合 ${already} 个（共 ${targets.length} 格${companions ? `，另有 ${companions} 格门上半 / 床头随着自动出现` : ''}）`];
  if (pillars) lines.push(`垫高 ${pillars} 次，垫的方块都挖回来了`);
  if (flights) lines.push(`飞上去 ${flights} 次（放或挖够不着的高处），已经落地`);
  if (temps) lines.push(`${temps} 处悬空的先在旁边临时放了一块当支撑，放好后挖掉了`);
  if (shortage.length) lines.push(`开始前材料不足：${shortage.join('；')}`);
  if (engine.notes.size) lines.push('注意：', ...summarizeReasons(engine.notes));
  if (skipped.size) lines.push('未完成：', ...summarizeReasons(skipped));
  if (stopReason) lines.push(`提前停止：${stopReason}。用同样的参数再调用一次会从剩下的继续（已完成的会自动跳过）`);
  return factory.createResponse(lines.join('\n'));
}
