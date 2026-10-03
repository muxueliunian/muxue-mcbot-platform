// 感知用的公共函数：相对方向、朝向、视线检查、推断玩家正在看的方块
// 只读，不做任何动作
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';

type P = { x: number; y: number; z: number };

export const AIR = new Set(['air', 'cave_air', 'void_air']);

// mineflayer 的 yaw：0 朝北（-z），逆时针增加（π/2 朝西）
export function lookVector(yaw: number, pitch: number): Vec3 {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

const COMPASS = ['北', '西北', '西', '西南', '南', '东南', '东', '东北'];

export function compassOfYaw(yaw: number): string {
  const idx = Math.round(normalizeAngle(yaw) / (Math.PI / 4));
  return COMPASS[((idx % 8) + 8) % 8];
}

// 世界方向（dx, dz）对应的方位
export function compassOfVector(dx: number, dz: number): string {
  return compassOfYaw(Math.atan2(-dx, -dz));
}

function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r < 0) r += 2 * Math.PI;
  return r;
}

export interface Pose {
  pos: Vec3;
  eye: Vec3;
  yaw: number;
  pitch: number;
  dimension: string;
  at: number;
}

// 一次观察用同一个姿态快照计算，避免中途转头导致左右不一致
export function poseOf(bot: Bot): Pose {
  const pos = bot.entity.position.clone();
  return {
    pos,
    eye: pos.offset(0, (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62, 0),
    yaw: bot.entity.yaw,
    pitch: bot.entity.pitch,
    dimension: bot.game?.dimension ?? 'overworld',
    at: Date.now()
  };
}

// 相对自己的方向：前/后/左/右（含斜向）、上下、水平距离
export function relative(pose: Pose, target: P): { text: string; distance: number; side: string; vertical: string } {
  const dx = target.x - pose.pos.x;
  const dz = target.z - pose.pos.z;
  const dy = target.y - pose.pos.y;
  const fwd = { x: -Math.sin(pose.yaw), z: -Math.cos(pose.yaw) };
  const right = { x: Math.cos(pose.yaw), z: -Math.sin(pose.yaw) };
  const f = dx * fwd.x + dz * fwd.z;
  const r = dx * right.x + dz * right.z;
  const distance = Math.hypot(dx, dz);
  let side: string;
  if (distance < 0.8) {
    side = '脚边';
  } else {
    const angle = Math.atan2(r, f) * 180 / Math.PI; // 0 = 正前方，正数在右边
    const a = Math.abs(angle);
    if (a <= 22.5) side = '正前方';
    else if (a >= 157.5) side = '正后方';
    else if (a < 67.5) side = angle > 0 ? '右前方' : '左前方';
    else if (a <= 112.5) side = angle > 0 ? '右边' : '左边';
    else side = angle > 0 ? '右后方' : '左后方';
  }
  let vertical = '';
  if (dy >= 2.5) vertical = `，高 ${Math.round(dy)} 格`;
  else if (dy <= -2.5) vertical = `，低 ${Math.round(-dy)} 格`;
  return { text: `${side} ${distance.toFixed(0)} 格${vertical}`, distance, side, vertical };
}

// 会挡住视线的方块（玻璃、树叶等透明方块不挡）
export function blocksSight(block: Block | null): boolean {
  if (!block) return false;
  if (AIR.has(block.name)) return false;
  return block.boundingBox === 'block' && !(block as { transparent?: boolean }).transparent;
}

export type SightResult = 'visible' | 'blocked' | 'unknown';

// 从眼睛到目标方块中心逐格检查：中途有不透明方块就是被挡住；途经未加载区块就是不知道
export function lineOfSight(bot: Bot, from: Vec3, target: P, targetIsBlock = true): SightResult {
  const to = targetIsBlock ? new Vec3(Math.floor(target.x) + 0.5, Math.floor(target.y) + 0.5, Math.floor(target.z) + 0.5) : new Vec3(target.x, target.y, target.z);
  const tx = Math.floor(target.x), ty = Math.floor(target.y), tz = Math.floor(target.z);
  const delta = to.minus(from);
  const length = delta.norm();
  if (length < 0.01) return 'visible';
  const steps = Math.ceil(length / 0.2);
  let last = '';
  for (let i = 1; i < steps; i++) {
    const p = from.plus(delta.scaled(i / steps)).floored();
    const key = `${p.x},${p.y},${p.z}`;
    if (key === last) continue;
    last = key;
    if (targetIsBlock && p.x === tx && p.y === ty && p.z === tz) return 'visible';
    const b = bot.blockAt(p);
    if (!b) return 'unknown';
    if (blocksSight(b)) return 'blocked';
  }
  return 'visible';
}

// 沿视线找到第一个实体方块；途经未加载区块时返回 unknown
export function castFrom(bot: Bot, eye: Vec3, dir: Vec3, maxDistance: number): { block: Block | null; unknown: boolean } {
  const steps = Math.ceil(maxDistance / 0.1);
  const unit = dir.normalize();
  let last = '';
  for (let i = 1; i <= steps; i++) {
    const p = eye.plus(unit.scaled(i * 0.1)).floored();
    const key = `${p.x},${p.y},${p.z}`;
    if (key === last) continue;
    last = key;
    const b = bot.blockAt(p);
    if (!b) return { block: null, unknown: true };
    if (AIR.has(b.name)) continue;
    if (b.boundingBox === 'block' || /(_door|_trapdoor|_fence_gate|_slab|_stairs|_carpet|glass_pane|_bars)$/.test(b.name)) {
      return { block: b, unknown: false };
    }
  }
  return { block: null, unknown: false };
}

export function playerByName(bot: Bot, username: string): Entity | undefined {
  const key = Object.keys(bot.players).find((n) => n.toLowerCase() === username.toLowerCase());
  return key ? bot.players[key]?.entity : undefined;
}

// 根据服务器同步的头部朝向，估算玩家正在看哪个方块（推断，不是客户端准星）
export function playerLookTarget(bot: Bot, player: Entity, maxDistance = 16): { block: Block | null; unknown: boolean } {
  const yaw = (player as { headYaw?: number }).headYaw ?? player.yaw;
  const eye = player.position.offset(0, 1.62, 0);
  return castFrom(bot, eye, lookVector(yaw, player.pitch), maxDistance);
}

export function blockProps(block: Block): Record<string, unknown> {
  try {
    return (block as unknown as { getProperties(): Record<string, unknown> }).getProperties() ?? {};
  } catch {
    return {};
  }
}

export function fmtPos(p: P): string {
  return `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
}
