// 空闲小动作（程序层，不花 AI 额度）：站着没事时像真人一样看看周围、偶尔换换手上的东西、在原地附近走一两步。
// 换手和走动：有工具开始、有人聊天、被打、敌对生物靠近时立刻停下，之后冷却一段时间再做。
// 走路只用已装好的安全寻路（不挖不垫），不进登记区域，在登记区域里完全不走。
// 空闲视线（唯一的空闲转头调度，都用 idle 优先级）：
// - 关注窗口：她刚说话、小克刚对她说话、她刚走近、她刚打了小克 → 之后几秒看着她（偶尔小幅移开）
// - 平时：大部分时间看周围（她在看的方向、生物、附近方块、远处、地面、天空），偶尔瞥她一眼
// - 对视：她一直盯着小克看，就回看一会儿再别过头去，之后一段时间不再因为对视回看
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { bodyBusy, isIdle, onActivityStart } from './task-control.js';
import { mayLook } from './gaze.js';
import { socialSettings, canSee, onSpeak } from './social.js';
import { isRealPlayer } from './reactions.js';
import { followStatus } from './follow.js';
import { autoEatChoice, isHostile, reflexSettings } from './reflexes.js';
import { HOSTILE_RANGE } from './world-events.js';
import { isSafeMovements, regionStore } from './action-policy.js';
import { isDoorLike } from './entrances.js';
import { isFlying } from './flight.js';

const { goals } = pathfinderPkg;

export interface IdleTiming {
  tickMs: number;
  // 上次有工具调用结束后要安静这么久才算"真正空闲"
  quietMs: number;
  // 被打断（工具、聊天、被打、敌对生物）后这么久不做小动作
  cooldownMs: number;
  // ---- 空闲视线 ----
  // 平时看周围：每隔这么久换一个视线目标
  sceneryMinMs: number;
  sceneryMaxMs: number;
  // 平时偶尔瞥她一眼：间隔和持续时间
  peekMinMs: number;
  peekMaxMs: number;
  peekHoldMinMs: number;
  peekHoldMaxMs: number;
  peekRange: number;
  // 关注窗口：持续时间；窗口里每隔一会儿重新选一下看的位置，有一定概率小幅移开
  attentionMinMs: number;
  attentionMaxMs: number;
  attentionShiftMinMs: number;
  attentionShiftMaxMs: number;
  attentionAwayChance: number;
  // 她走进这个范围算"刚走近"；这个范围内的真人说话算"她说话"
  approachRange: number;
  hearRange: number;
  // 对视：她的视线和指向小克头部的方向夹角小于 stareAngleDeg、距离不超过 stareRange、持续 stareMs 才算被盯着
  stareAngleDeg: number;
  stareRange: number;
  stareMs: number;
  stareBackMinMs: number;
  stareBackMaxMs: number;
  // 回看之后别过头去的时间，以及之后多久内不再因为对视回看
  stareAwayMinMs: number;
  stareAwayMaxMs: number;
  stareCooldownMs: number;
  swapMinMs: number;
  swapMaxMs: number;
  swapHoldMinMs: number;
  swapHoldMaxMs: number;
  // 空闲满这么久才会走动
  walkAfterIdleMs: number;
  walkMinMs: number;
  walkMaxMs: number;
  walkTimeoutMs: number;
  walkRadius: number;
  // 换视线目标时分几步转过去（每步间隔 ms）
  lookSteps: number;
  lookStepMs: number;
}

export const DEFAULT_IDLE_TIMING: IdleTiming = {
  tickMs: 200,
  quietMs: 3000,
  cooldownMs: 20000,
  sceneryMinMs: 3000,
  sceneryMaxMs: 10000,
  peekMinMs: 15000,
  peekMaxMs: 40000,
  peekHoldMinMs: 1500,
  peekHoldMaxMs: 3000,
  peekRange: 12,
  attentionMinMs: 4000,
  attentionMaxMs: 8000,
  attentionShiftMinMs: 1500,
  attentionShiftMaxMs: 3000,
  attentionAwayChance: 0.25,
  approachRange: 8,
  hearRange: 16,
  stareAngleDeg: 10,
  stareRange: 8,
  stareMs: 1500,
  stareBackMinMs: 2000,
  stareBackMaxMs: 3000,
  stareAwayMinMs: 2000,
  stareAwayMaxMs: 4000,
  stareCooldownMs: 10000,
  swapMinMs: 180000,
  swapMaxMs: 360000,
  swapHoldMinMs: 3000,
  swapHoldMaxMs: 8000,
  walkAfterIdleMs: 30000,
  walkMinMs: 20000,
  walkMaxMs: 60000,
  walkTimeoutMs: 8000,
  walkRadius: 3,
  lookSteps: 6,
  lookStepMs: 120
};

const PLAYER_NEAR = 16;
// 看周围时，选出来的方向离她的头太近（小于这个角度）就换一个，免得"看风景"变成盯着她
const AVOID_PLAYER_RAD = 0.35;
// 她自己正看着小克这边（夹角小于这个）时，不去看"她在看的方向"
const HER_GAZE_MIN_RAD = 0.5;
const CREATURE_RANGE = 12;
const NOT_CREATURE = new Set(['player', 'object', 'orb', 'projectile', 'global', 'other']);
const MAX_PATH_NODES = 6;
const LIQUID = /^(water|lava|bubble_column)$/;
const BAD_GROUND = /^(lava|magma_block|water|campfire|soul_campfire|fire|soul_fire|powder_snow|farmland|cactus|sweet_berry_bush|.*_bed|scaffolding)$/;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function isNight(bot: Bot): boolean {
  const t = bot.time?.timeOfDay ?? 0;
  return t >= 12542 && t <= 23460;
}

function passable(b: Block | null): boolean {
  return Boolean(b && b.boundingBox === 'empty' && !LIQUID.test(b.name) && !isDoorLike(b));
}

function solid(b: Block | null): boolean {
  return Boolean(b && b.boundingBox === 'block');
}

// 这一格在不在登记区域里；读不到区域数据时当作在（宁可不走）
function inRegion(bot: Bot, p: { x: number; y: number; z: number }): boolean {
  const found = regionStore().regionsAt(bot.game?.dimension ?? 'overworld', p);
  return found === null || found.length > 0;
}

// 能不能站：脚和头能过、脚下实心且不危险、不在登记区域、旁边不是悬崖（落差 2 格以上）
function safeStand(bot: Bot, p: Vec3): boolean {
  if (!passable(bot.blockAt(p)) || !passable(bot.blockAt(p.offset(0, 1, 0)))) return false;
  const below = bot.blockAt(p.offset(0, -1, 0));
  if (!solid(below) || BAD_GROUND.test(below!.name)) return false;
  if (inRegion(bot, p)) return false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = p.offset(dx, 0, dz);
    const feet = bot.blockAt(n);
    if (!feet || LIQUID.test(feet.name)) return false;
    if (solid(feet)) continue;
    const d1 = bot.blockAt(n.offset(0, -1, 0));
    const d2 = bot.blockAt(n.offset(0, -2, 0));
    if (!d1 || LIQUID.test(d1.name)) return false;
    if (!solid(d1) && (!d2 || !solid(d2))) return false;
  }
  return true;
}

function realPlayerNear(bot: Bot, range: number): boolean {
  return Object.values(bot.players ?? {}).some((p) => p?.entity && isRealPlayer(bot, p.username)
    && p.entity.position.distanceTo(bot.entity.position) <= range);
}

// ---- 视线用的角度计算（和 mineflayer 的 lookAt 同一套约定：pitch 向上为正） ----

interface Aim { yaw: number; pitch: number }

function eyeOf(e: Entity): Vec3 {
  const eye = (e as { eyeHeight?: number }).eyeHeight ?? (e.height ?? 1.8) * 0.9;
  return e.position.offset(0, eye, 0);
}

function headOf(e: Entity): Vec3 {
  return e.position.offset(0, (e.height ?? 1.8) * 0.9, 0);
}

function aimFrom(from: Vec3, to: Vec3): Aim {
  const d = to.minus(from);
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
}

function dirOf(yaw: number, pitch: number): Vec3 {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

function angleBetween(a: Vec3, b: Vec3): number {
  const n = a.norm() * b.norm();
  if (n === 0) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b) / n)));
}

// 两个朝向之间的夹角
function aimGap(a: Aim, b: Aim): number {
  return angleBetween(dirOf(a.yaw, a.pitch), dirOf(b.yaw, b.pitch));
}

// yaw 差取最短的那一边
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// 这个人正在看的方向和"从她眼睛指向小克头部"的夹角；拿不到她的朝向时返回 null
export function stareAngle(bot: Bot, e: Entity): number | null {
  if (typeof e.yaw !== 'number' || typeof e.pitch !== 'number') return null;
  return angleBetween(dirOf(e.yaw, e.pitch), eyeOf(bot.entity).minus(eyeOf(e)));
}

// 小克现在的视线和指向这个人头部的夹角
export function gazeOffAngle(bot: Bot, e: Entity): number {
  return angleBetween(dirOf(bot.entity.yaw, bot.entity.pitch), headOf(e).minus(eyeOf(bot.entity)));
}

function realPlayersWithin(bot: Bot, range: number): Entity[] {
  const out: Entity[] = [];
  for (const p of Object.values(bot.players ?? {})) {
    if (!p?.entity?.position || !isRealPlayer(bot, p.username)) continue;
    if (p.entity.position.distanceTo(bot.entity.position) <= range) out.push(p.entity);
  }
  return out.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

interface PlannedPath {
  status: string;
  path: Array<{ x: number; y: number; z: number; toBreak?: unknown[]; toPlace?: unknown[] }>;
}

// 只算路不走（不用 getPathTo，它会改 pathfinder 内部的搜索状态）
function planPath(bot: Bot, movements: unknown, goal: unknown): PlannedPath | null {
  let result: PlannedPath | null = null;
  for (const step of bot.pathfinder.getPathFromTo(movements as never, bot.entity.position, goal as never, { timeout: 300 })) {
    result = step.result as unknown as PlannedPath;
  }
  return result;
}

export type GazeMode = 'none' | 'scenery' | 'peek' | 'attention' | 'stare-back' | 'stare-away';

export interface IdleController {
  stop(): void;
  state(): {
    anchor: Vec3 | null; walking: boolean; walks: number; glances: number; swaps: number; swappedFrom: number | null; quietUntil: number;
    gaze: { mode: GazeMode; target: string | null; attentionUntil: number; stareCooldownUntil: number };
    peeks: number; attentions: number; stareBacks: number;
  };
}

// 一个视线目标：每次都重新算朝向（跟着人、生物动），算不出来（人走了、生物没了）就换一个
interface GazeTarget {
  mode: GazeMode;
  key: string;
  aim: () => Aim | null;
}

export function startIdleActions(bot: Bot, timing: Partial<IdleTiming> = {}): IdleController {
  const T = { ...DEFAULT_IDLE_TIMING, ...timing };
  let anchor: Vec3 | null = null;
  let idleSince = 0;
  let quietUntil = 0;
  let walk: { goal: unknown; deadline: number } | null = null;
  let swap: { from: number; to: number; until: number } | null = null;
  let looking = 0; // 平滑转头的代数：被打断时加一，正在进行的转头就停下
  let turning = false;
  const now0 = Date.now();
  let nextSwap = now0 + rand(T.swapMinMs, T.swapMaxMs);
  let nextWalk = 0;
  const stats = { walks: 0, glances: 0, swaps: 0, peeks: 0, attentions: 0, stareBacks: 0 };

  // ---- 空闲视线的状态 ----
  let attention: { name: string; until: number; offset: Aim; nextShift: number } | null = null;
  let peek: { name: string; until: number } | null = null;
  let nextPeek = now0 + rand(T.peekMinMs, T.peekMaxMs);
  let stareBack: { name: string; until: number } | null = null;
  let stareAway: { until: number; aim: Aim } | null = null;
  let stareCooldownUntil = 0;
  const staringSince = new Map<string, number>();
  let scenery: { target: GazeTarget; until: number } | null = null;
  let nearBefore: Set<string> | null = null; // 上一次在 approachRange 内的人；null = 还没初始化（开始时已经在旁边的不算"走近"）
  let current: { mode: GazeMode; key: string } = { mode: 'none', key: '' };

  const stopWalk = () => {
    // 只清自己的目标：被工具或跟随换掉的目标不动，也不恢复自己的
    if (walk && bot.pathfinder?.goal === walk.goal) bot.pathfinder.setGoal(null);
    walk = null;
  };

  const restoreHand = () => {
    if (!swap) return;
    if (bot.quickBarSlot === swap.to) bot.setQuickBarSlot(swap.from);
    swap = null;
  };

  const stopTurning = () => {
    looking += 1;
    turning = false;
    current = { mode: 'none', key: '' };
  };

  // 被打断：立刻停下走动和换手，重新找锚点，冷却一段时间；工具开始时连转头也停
  const interrupt = (stopGaze = false) => {
    stopWalk();
    restoreHand();
    if (stopGaze) stopTurning();
    anchor = null;
    quietUntil = Math.max(quietUntil, Date.now() + T.cooldownMs);
  };

  const busy = () => bodyBusy() || !isIdle(0) || isFlying(bot);

  const findPlayer = (name: string): Entity | undefined => {
    const key = Object.keys(bot.players ?? {}).find((n) => n.toLowerCase() === name.toLowerCase());
    return key ? bot.players[key]?.entity : undefined;
  };

  // 开始（或延长）对某人的关注窗口
  const attend = (name: string, range: number) => {
    if (!bot.entity || !isRealPlayer(bot, name)) return;
    const e = findPlayer(name);
    if (!e?.position || e.position.distanceTo(bot.entity.position) > range) return;
    const now = Date.now();
    const until = now + rand(T.attentionMinMs, T.attentionMaxMs);
    if (attention && attention.name === name) {
      attention.until = Math.max(attention.until, until);
    } else {
      attention = { name, until, offset: { yaw: 0, pitch: 0 }, nextShift: now + rand(T.attentionShiftMinMs, T.attentionShiftMaxMs) };
    }
    // 被搭话时不再别着头
    stareAway = null;
    peek = null;
    stats.attentions += 1;
  };

  const lookAtPlayerTarget = (mode: GazeMode, name: string, offset?: () => Aim): GazeTarget => ({
    mode,
    key: `${mode}:${name}`,
    aim: () => {
      const e = findPlayer(name);
      if (!e?.position || e.position.distanceTo(bot.entity.position) > T.hearRange) return null;
      const a = aimFrom(eyeOf(bot.entity), headOf(e));
      const o = offset?.();
      return o ? { yaw: a.yaw + o.yaw, pitch: a.pitch + o.pitch } : a;
    }
  });

  const fixedTarget = (mode: GazeMode, key: string, a: Aim): GazeTarget => ({ mode, key, aim: () => a });

  // 选方向时躲开附近真人的头
  const pointsAtPlayer = (a: Aim, players: Entity[]) => players.some((p) => aimGap(a, aimFrom(eyeOf(bot.entity), headOf(p))) < AVOID_PLAYER_RAD);

  // 附近一格地表方块的顶面（看看脚边、旁边的东西）
  const nearbySurface = (): Vec3 | null => {
    const base = bot.entity.position.floored();
    for (let tries = 0; tries < 6; tries++) {
      const r = rand(2, 6);
      const t = Math.random() * Math.PI * 2;
      const x = base.x + Math.round(Math.cos(t) * r);
      const z = base.z + Math.round(Math.sin(t) * r);
      for (let y = base.y + 2; y >= base.y - 4; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) break;
        if (b.boundingBox === 'block' && passable(bot.blockAt(new Vec3(x, y + 1, z)))) return new Vec3(x + 0.5, y + 1, z + 0.5);
      }
    }
    return null;
  };

  // 平时看周围：随机选一种，选出来的方向离人太近就重选
  const pickScenery = (players: Entity[]): GazeTarget => {
    const me = bot.entity;
    const her = players[0];
    const creature = bot.nearestEntity((e) => !NOT_CREATURE.has(e.type) && e.position.distanceTo(me.position) <= CREATURE_RANGE);
    const herAngle = her ? stareAngle(bot, her) : null;
    const options: Array<[number, () => GazeTarget | null]> = [
      [3, () => {
        // 她正在看的方向（她自己看着这边时不算）
        if (!her || herAngle === null || herAngle < HER_GAZE_MIN_RAD) return null;
        const dist = rand(4, 10);
        const name = her.username ?? '';
        return {
          mode: 'scenery', key: `her-gaze:${name}:${dist}`,
          aim: () => {
            const e = findPlayer(name);
            if (!e || typeof e.yaw !== 'number' || typeof e.pitch !== 'number') return null;
            return aimFrom(eyeOf(me), eyeOf(e).plus(dirOf(e.yaw, e.pitch).scaled(dist)));
          }
        };
      }],
      [2, () => {
        if (!creature || !canSee(bot, creature)) return null;
        return {
          mode: 'scenery', key: `creature:${creature.id}`,
          aim: () => (creature.isValid === false || !bot.entities[creature.id] ? null : aimFrom(eyeOf(me), headOf(creature)))
        };
      }],
      [2, () => {
        const p = nearbySurface();
        return p ? fixedTarget('scenery', `block:${p}`, aimFrom(eyeOf(me), p)) : null;
      }],
      [3, () => fixedTarget('scenery', `far:${Math.random()}`, { yaw: me.yaw + (Math.random() < 0.5 ? -1 : 1) * rand(0.5, 1.6), pitch: rand(-0.1, 0.15) })],
      [1.5, () => fixedTarget('scenery', `ground:${Math.random()}`, { yaw: me.yaw + rand(-0.8, 0.8), pitch: rand(-0.8, -0.4) })],
      [1, () => fixedTarget('scenery', `sky:${Math.random()}`, { yaw: me.yaw + rand(-1, 1), pitch: rand(0.5, 0.9) })]
    ];
    const total = options.reduce((n, [w]) => n + w, 0);
    for (let tries = 0; tries < 6; tries++) {
      let r = Math.random() * total;
      const pick = options.find(([w]) => (r -= w) < 0) ?? options[options.length - 1];
      const t = pick[1]();
      const a = t?.aim();
      if (t && a && !pointsAtPlayer(a, players)) return t;
    }
    // 实在选不出来：背对最近的人看远处
    const away = her ? aimFrom(eyeOf(me), headOf(her)).yaw + Math.PI : me.yaw;
    return fixedTarget('scenery', `far:${Math.random()}`, { yaw: away, pitch: rand(-0.1, 0.1) });
  };

  // 别过头去：从她那边转开 1~1.8 弧度，稍微低头
  const lookAwayFrom = (name: string): Aim => {
    const e = findPlayer(name);
    const base = e ? aimFrom(eyeOf(bot.entity), headOf(e)).yaw : bot.entity.yaw;
    return { yaw: base + (Math.random() < 0.5 ? -1 : 1) * rand(1, 1.8), pitch: rand(-0.35, 0) };
  };

  const gazeFree = () => !busy() && mayLook('idle') && !bot.pathfinder?.isMoving() && !bot.targetDigBlock
    && !bot.usingHeldItem && !bot.isSleeping;

  const smoothLook = async (to: Aim) => {
    const gen = ++looking;
    turning = true;
    try {
      const y0 = bot.entity.yaw;
      const p0 = bot.entity.pitch;
      const dy = wrapAngle(to.yaw - y0);
      for (let i = 1; i <= T.lookSteps; i++) {
        if (gen !== looking || !gazeFree()) return;
        await bot.look(y0 + (dy * i) / T.lookSteps, p0 + ((to.pitch - p0) * i) / T.lookSteps, false).catch(() => undefined);
        await new Promise((r) => setTimeout(r, T.lookStepMs));
      }
    } finally {
      if (gen === looking) turning = false;
    }
  };

  // 这一刻该看哪儿（优先级：对视回看 > 别过头 > 关注窗口 > 瞥一眼 > 看周围）
  const chooseGaze = (now: number, players: Entity[]): GazeTarget => {
    if (stareBack) return lookAtPlayerTarget('stare-back', stareBack.name);
    if (stareAway) return fixedTarget('stare-away', 'stare-away', stareAway.aim);
    if (attention) {
      const a = attention;
      if (now >= a.nextShift) {
        a.nextShift = now + rand(T.attentionShiftMinMs, T.attentionShiftMaxMs);
        a.offset = Math.random() < T.attentionAwayChance
          ? { yaw: (Math.random() < 0.5 ? -1 : 1) * rand(0.2, 0.4), pitch: -rand(0, 0.2) }
          : { yaw: 0, pitch: 0 };
      }
      return lookAtPlayerTarget('attention', a.name, () => a.offset);
    }
    if (!peek && now >= nextPeek) {
      nextPeek = now + rand(T.peekMinMs, T.peekMaxMs);
      const who = players.find((p) => p.position.distanceTo(bot.entity.position) <= T.peekRange && canSee(bot, p));
      if (who?.username) {
        peek = { name: who.username, until: now + rand(T.peekHoldMinMs, T.peekHoldMaxMs) };
        stats.peeks += 1;
      }
    }
    if (peek) return lookAtPlayerTarget('peek', peek.name);
    if (!scenery || now >= scenery.until || !scenery.target.aim()) {
      scenery = { target: pickScenery(players), until: now + rand(T.sceneryMinMs, T.sceneryMaxMs) };
      stats.glances += 1;
    }
    return scenery.target;
  };

  const gazeTick = (now: number) => {
    const players = realPlayersWithin(bot, T.hearRange);

    // 她刚走近（从 approachRange 外进来，看得见）
    const near = new Set(players.filter((p) => p.position.distanceTo(bot.entity.position) <= T.approachRange && canSee(bot, p))
      .map((p) => p.username ?? ''));
    if (nearBefore) for (const name of near) if (!nearBefore.has(name)) attend(name, T.approachRange);
    nearBefore = near;

    // 过期的状态
    if (attention && (now >= attention.until || !findPlayer(attention.name))) attention = null;
    if (peek && now >= peek.until) peek = null;
    if (stareBack && now >= stareBack.until) {
      stareAway = { until: now + rand(T.stareAwayMinMs, T.stareAwayMaxMs), aim: lookAwayFrom(stareBack.name) };
      stareCooldownUntil = now + T.stareCooldownMs;
      stareBack = null;
      staringSince.clear();
    }
    if (stareAway && now >= stareAway.until) {
      stareAway = null;
      scenery = null;
    }

    // 谁在盯着小克看
    const limit = (T.stareAngleDeg * Math.PI) / 180;
    for (const p of players) {
      const name = p.username ?? '';
      const ang = stareAngle(bot, p);
      const staring = ang !== null && ang < limit && p.position.distanceTo(bot.entity.position) <= T.stareRange && canSee(bot, p);
      if (!staring) staringSince.delete(name);
      else if (!staringSince.has(name)) staringSince.set(name, now);
    }
    for (const name of [...staringSince.keys()]) if (!players.some((p) => p.username === name)) staringSince.delete(name);

    if (!socialSettings.idleLook) {
      if (current.mode !== 'none') stopTurning();
      return;
    }
    if (!gazeFree()) return;

    // 被盯着超过 stareMs：回看一会儿（关注窗口里本来就看着她，不算；冷却期内不算）
    if (!stareBack && !stareAway && !attention && now >= stareCooldownUntil) {
      for (const [name, since] of staringSince) {
        if (now - since >= T.stareMs) {
          stareBack = { name, until: now + rand(T.stareBackMinMs, T.stareBackMaxMs) };
          peek = null;
          stats.stareBacks += 1;
          break;
        }
      }
    }

    const target = chooseGaze(now, players);
    const aim = target.aim();
    if (!aim) {
      if (target.mode === 'scenery') scenery = null;
      return;
    }
    const changed = target.key !== current.key;
    current = { mode: target.mode, key: target.key };
    const here = { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
    if (changed) {
      if (aimGap(here, aim) > 0.3) {
        smoothLook(aim).catch(() => undefined);
        return;
      }
      // 新目标离得近：停掉还在转向旧目标的平滑转头，直接看过去
      looking += 1;
      turning = false;
    }
    if (turning) return;
    if (aimGap(here, aim) > 0.01) bot.look(here.yaw + wrapAngle(aim.yaw - here.yaw), aim.pitch, false).catch(() => undefined);
  };

  const trySwap = (now: number) => {
    if (swap || bot.usingHeldItem || typeof bot.setQuickBarSlot !== 'function') return;
    if (bot.quickBarSlot === null || bot.quickBarSlot === undefined) return;
    // 马上要自动进食时不换，免得和进食抢手
    if (reflexSettings.autoEat && autoEatChoice(bot)) return;
    const from = bot.quickBarSlot;
    const slots = bot.inventory.slots;
    const start = (bot.inventory as { hotbarStart?: number }).hotbarStart ?? 36;
    const withItems = Array.from({ length: 9 }, (_, i) => i).filter((i) => i !== from && slots[start + i]);
    const pool = withItems.length ? withItems : Array.from({ length: 9 }, (_, i) => i).filter((i) => i !== from);
    const to = pool[Math.floor(Math.random() * pool.length)];
    bot.setQuickBarSlot(to);
    swap = { from, to, until: now + rand(T.swapHoldMinMs, T.swapHoldMaxMs) };
    stats.swaps += 1;
  };

  // 在锚点附近找一格能站的地方，先算好路：路上不挖不放、不进登记区域、不离锚点太远
  const tryWalk = (now: number) => {
    if (!anchor || !bot.pathfinder || bot.pathfinder.goal) return;
    if (followStatus() || isNight(bot) || now - idleSince < T.walkAfterIdleMs) return;
    if (!realPlayerNear(bot, PLAYER_NEAR)) return;
    const movements = bot.pathfinder.movements;
    if (!isSafeMovements(movements)) return;
    const here = bot.entity.position.floored();
    if (inRegion(bot, here) || inRegion(bot, anchor)) return;

    const candidates: Vec3[] = [];
    const r = Math.floor(T.walkRadius);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const c = anchor.offset(dx, dy, dz);
          if (Math.hypot(dx, dz) > T.walkRadius) continue;
          const step = Math.hypot(c.x - here.x, c.z - here.z);
          if (step < 1 || step > 2.5) continue;
          if (safeStand(bot, c)) candidates.push(c);
        }
      }
    }
    for (let tries = 0; tries < 3 && candidates.length; tries++) {
      const target = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0];
      const goal = new goals.GoalBlock(target.x, target.y, target.z);
      const result = planPath(bot, movements, goal);
      if (!result || result.status !== 'success' || result.path.length > MAX_PATH_NODES) continue;
      // 路上每一格（出发点除外）也要能安全站住：不贴着悬崖和水走，不穿过登记区域
      const ok = result.path.every((n) => {
        const cell = new Vec3(n.x, n.y, n.z).floored();
        if (n.toBreak?.length || n.toPlace?.length) return false;
        if (Math.hypot(cell.x - anchor!.x, cell.z - anchor!.z) > T.walkRadius) return false;
        return cell.equals(here) || safeStand(bot, cell);
      });
      if (!ok) continue;
      bot.pathfinder.setGoal(goal);
      walk = { goal, deadline: now + T.walkTimeoutMs };
      stats.walks += 1;
      return;
    }
  };

  const tick = () => {
    if (!bot.entity) return;
    const now = Date.now();
    // 视线独立调度：idleActions 关掉、跟随、有敌对生物时照样看周围（只受 idleLook 和视线优先级管）
    gazeTick(now);
    if (busy()) {
      interrupt(true);
      return;
    }
    if (!socialSettings.idleActions) {
      stopWalk();
      restoreHand();
      return;
    }
    // 跟随玩家时身体交给跟随逻辑，小动作都不做
    if (followStatus()) {
      interrupt();
      return;
    }
    if (bot.nearestEntity((e) => isHostile(e) && e.position.distanceTo(bot.entity.position) <= HOSTILE_RANGE)) {
      interrupt();
      return;
    }
    if (walk) {
      if (bot.pathfinder?.goal !== walk.goal) {
        walk = null; // 到了，或者被别人换掉了：不恢复
      } else if (now > walk.deadline || inRegion(bot, bot.entity.position.floored())
        || (anchor && bot.entity.position.floored().distanceTo(anchor) > T.walkRadius + 1)) {
        stopWalk();
      } else {
        return;
      }
    }
    if (swap && now >= swap.until) restoreHand();
    if (now < quietUntil || !isIdle(T.quietMs)) return;
    if (!anchor) {
      anchor = bot.entity.position.floored();
      idleSince = now;
      nextWalk = now + T.walkAfterIdleMs;
    } else if (bot.entity.position.floored().distanceTo(anchor) > T.walkRadius + 3) {
      // 被推开、被传送：换个锚点重新算空闲
      anchor = bot.entity.position.floored();
      idleSince = now;
      nextWalk = now + T.walkAfterIdleMs;
    }
    if (now >= nextWalk) {
      nextWalk = now + rand(T.walkMinMs, T.walkMaxMs);
      tryWalk(now);
      if (walk) return;
    }
    if (now >= nextSwap) {
      nextSwap = now + rand(T.swapMinMs, T.swapMaxMs);
      trySwap(now);
    }
  };

  const timer = setInterval(tick, T.tickMs);
  // 兜底：走路、换手、转头期间每个物理 tick 也检查一次
  const onPhysics = () => {
    if ((walk || swap || turning) && busy()) interrupt(true);
  };
  // 有人说话：换手、走动停下冷却；说话的真人在附近就开始关注窗口
  const onChat = (username: string) => {
    if (username === bot.username) return;
    interrupt();
    attend(username, T.hearRange);
  };
  // 被打：停下小动作；是真人打的就当作关注窗口的开始（转头由 reactions 先做）
  const onHurt = (entity: unknown, source?: Entity) => {
    if (entity !== bot.entity) return;
    interrupt();
    if (source?.type === 'player' && source.username) attend(source.username, T.hearRange);
  };
  const onDeath = () => interrupt(true);
  // 工具一开始就在同一个调用栈里让出身体：换回原格子、清掉自己的寻路目标、停下转头、进冷却
  const offStart = onActivityStart(() => interrupt(true));
  // 小克对谁说话，接下来几秒就看着谁
  const offSpeak = onSpeak((to) => attend(to, T.hearRange));
  bot.on('physicsTick', onPhysics);
  bot.on('chat', onChat);
  bot.on('whisper', onChat);
  bot.on('entityHurt', onHurt);
  bot.on('death', onDeath);

  const stop = () => {
    clearInterval(timer);
    offStart();
    offSpeak();
    bot.removeListener('physicsTick', onPhysics);
    bot.removeListener('chat', onChat);
    bot.removeListener('whisper', onChat);
    bot.removeListener('entityHurt', onHurt);
    bot.removeListener('death', onDeath);
    looking += 1;
  };
  bot.once('end', stop);

  return {
    stop,
    state: () => ({
      anchor, walking: Boolean(walk), ...stats, swappedFrom: swap?.from ?? null, quietUntil,
      gaze: { mode: current.mode, target: current.key || null, attentionUntil: attention?.until ?? 0, stareCooldownUntil }
    })
  };
}
