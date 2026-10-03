// observe：用少量文字描述身边的情况（相对方向、门和容器、危险、玩家在看哪里）。
// 每条标来源：[可见] 视线没被挡；[看不到] 已加载但被挡住；[推断] 由朝向等估算；[记录] 来自登记数据
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { isHostile } from './reflexes.js';
import { regionStore } from './action-policy.js';
import { entranceStore } from './entrances.js';
import { currentFocus, describeFocus } from './focus.js';
import { regionContains, normalizeDimension } from './regions.js';
import { nearbyPlaces, age } from './places.js';
import { followStatus } from './follow.js';
import {
  AIR, blockProps, castFrom, compassOfYaw, fmtPos, lineOfSight, lookVector, playerLookTarget, poseOf, relative, type Pose
} from './perception.js';

const INTERESTING = /(_door|_fence_gate|_trapdoor|chest|barrel|shulker_box|_bed|furnace|smoker|crafting_table|anvil|enchanting_table|brewing_stand|ladder|bell|composter|lectern)$/;
const DANGER = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|powder_snow|cobweb)$/;
const MAX_LIST = 8;

export interface ObserveOptions {
  radius: number;
  player?: string;
}

function sight(bot: Bot, pose: Pose, p: { x: number; y: number; z: number }, isBlock = true): string {
  const s = lineOfSight(bot, pose.eye, p, isBlock);
  return s === 'visible' ? '[可见]' : s === 'blocked' ? '[看不到]' : '[视线经过未加载区块]';
}

function describeBlockState(block: Block): string {
  const props = blockProps(block);
  const parts: string[] = [];
  if (props.open !== undefined) parts.push(props.open === true ? '开着' : '关着');
  if (props.occupied === true) parts.push('有人躺着');
  return parts.length ? `，${parts.join('，')}` : '';
}

function limited<T>(items: T[], n: number, render: (t: T) => string): string[] {
  const out = items.slice(0, n).map(render);
  if (items.length > n) out.push(`- ……还有 ${items.length - n} 个没列出`);
  return out;
}

export function observe(bot: Bot, opts: ObserveOptions): string {
  const pose = poseOf(bot);
  const r = Math.max(2, Math.min(16, Math.floor(opts.radius)));
  const base = pose.pos.floored();
  const dim = normalizeDimension(pose.dimension);
  const lines: string[] = [];
  const time = new Date(pose.at).toLocaleTimeString('zh-CN', { hour12: false });
  lines.push(`[${time}] 我在 ${fmtPos(pose.pos)}（${dim}），面朝${compassOfYaw(pose.yaw)}。以下方向都相对这个朝向，范围 ${r} 格`);

  // 所在区域 / 关注目标
  const regions = regionStore().activeRegions(dim);
  if (regions === null) {
    lines.push('区域：保护区域数据读取失败');
  } else {
    const inside = regions.filter((reg) => regionContains(reg, pose.pos));
    if (inside.length) lines.push(`区域：在 ${inside.map((reg) => `「${reg.name}」（${reg.kind}）`).join('、')} 里 [记录]`);
  }
  const { focus, expired } = currentFocus(bot);
  if (focus) {
    const c = { x: (focus.min.x + focus.max.x) / 2 + 0.5, y: (focus.min.y + focus.max.y) / 2, z: (focus.min.z + focus.max.z) / 2 + 0.5 };
    lines.push(`关注目标：${describeFocus(focus)}，在${relative(pose, c).text}`);
  } else if (expired) {
    lines.push(`关注目标：${expired}`);
  }

  const places = nearbyPlaces(bot, 32);
  if (places.length) {
    lines.push(`记着的地点（32 格内）：${places.slice(0, 4).map(({ place: p }) =>
      `${p.name}（${p.kind}）在${relative(pose, { x: p.pos.x + 0.5, y: p.pos.y, z: p.pos.z + 0.5 }).text}，${age(p.updatedAt)}`).join('；')} [记录]`);
  }
  const following = followStatus();
  if (following) lines.push(`状态：${following}`);

  // 玩家
  const players = Object.values(bot.players)
    .filter((p) => p.username !== bot.username && p.entity && p.entity.position.distanceTo(pose.pos) <= 48)
    .sort((a, b) => a.entity.position.distanceTo(pose.pos) - b.entity.position.distanceTo(pose.pos));
  const wanted = opts.player?.toLowerCase();
  if (players.length) {
    lines.push('玩家：');
    for (const p of players.slice(0, 4)) {
      const e = p.entity;
      let text = `- ${p.username}：${relative(pose, e.position).text} ${sight(bot, pose, e.position.offset(0, 1.5, 0), false)}`;
      if (!wanted || p.username.toLowerCase() === wanted) {
        const look = playerLookTarget(bot, e);
        if (look.block) {
          text += `，正看着 ${fmtPos(look.block.position)} 的 ${look.block.name}（在我${relative(pose, look.block.position.offset(0.5, 0, 0.5)).text}）[推断]`;
        } else if (look.unknown) {
          text += '，看向未加载的地方 [推断]';
        } else {
          text += '，看向远处/天空 [推断]';
        }
      }
      lines.push(text);
    }
  } else {
    lines.push('玩家：48 格内没有其他玩家');
  }
  if (wanted && !players.some((p) => p.username.toLowerCase() === wanted)) {
    lines.push(`（没看到 ${opts.player}：不在线或太远，不代表不在附近的未加载区域）`);
  }

  // 正前方和头顶
  const flat = lookVector(pose.yaw, 0);
  const ahead = castFrom(bot, pose.eye.offset(0, -1, 0), flat, 8);
  if (ahead.block) {
    const d = Math.hypot(ahead.block.position.x + 0.5 - pose.pos.x, ahead.block.position.z + 0.5 - pose.pos.z);
    lines.push(`正前方：约 ${Math.max(1, Math.round(d - 0.5))} 格处是 ${ahead.block.name}${describeBlockState(ahead.block)} [可见]`);
  } else if (ahead.unknown) {
    lines.push('正前方：视线进入未加载区块，不清楚');
  } else {
    lines.push('正前方：8 格内没有挡路的方块');
  }
  let roof: Block | null = null;
  let roofDist = 0;
  for (let dy = 2; dy <= 10; dy++) {
    const b = bot.blockAt(base.offset(0, dy, 0));
    if (!b) break;
    if (!AIR.has(b.name)) {
      roof = b;
      roofDist = dy - 1;
      break;
    }
  }
  const floor = bot.blockAt(base.offset(0, -1, 0));
  lines.push(`上下：${roof ? `头顶 ${roofDist} 格是 ${roof.name}` : '头顶 10 格内是空的'}；脚下是 ${floor?.name ?? '未加载'}`);

  // 门、容器等
  const found: { block: Block; dist: number }[] = [];
  let unloadedColumns = 0;
  let columns = 0;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue;
      columns++;
      if (!bot.blockAt(base.offset(dx, 0, dz))) {
        unloadedColumns++;
        continue;
      }
      for (let dy = -4; dy <= 4; dy++) {
        const b = bot.blockAt(base.offset(dx, dy, dz));
        if (!b || !INTERESTING.test(b.name)) continue;
        const props = blockProps(b);
        if (props.half === 'upper' || props.part === 'head' || props.type === 'right') continue;
        found.push({ block: b, dist: b.position.offset(0.5, 0, 0.5).distanceTo(pose.pos) });
      }
    }
  }
  found.sort((a, b) => a.dist - b.dist);
  const doors = entranceStore().list(dim);
  if (found.length) {
    lines.push(`附近的门、容器、床等（${r} 格内）：`);
    lines.push(...limited(found, MAX_LIST, ({ block }) => {
      const entrance = doors.find((e) => e.door.x === block.position.x && e.door.y === block.position.y && e.door.z === block.position.z);
      return `- ${block.name}：${relative(pose, block.position.offset(0.5, 0, 0.5)).text}${describeBlockState(block)} ${sight(bot, pose, block.position)}` +
        (entrance ? `，是登记的入口「${entrance.name}」[记录]` : '');
    }));
  }

  // 危险：落差、岩浆等、敌对生物
  const dangers: { text: string; dist: number }[] = [];
  const seenSides = new Set<string>();
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue;
      const feet = bot.blockAt(base.offset(dx, 0, dz));
      if (!feet || !AIR.has(feet.name)) continue;
      let depth = 0;
      for (let dy = -1; dy >= -12; dy--) {
        const b = bot.blockAt(base.offset(dx, dy, dz));
        if (!b || !AIR.has(b.name)) break;
        depth++;
      }
      if (depth < 3) continue;
      const rel = relative(pose, base.offset(dx + 0.5, 0, dz + 0.5));
      if (seenSides.has(rel.side)) continue;
      seenSides.add(rel.side);
      dangers.push({ text: `${rel.side} ${rel.distance.toFixed(0)} 格有落差，至少 ${depth} 格深${depth >= 12 ? '（很深）' : ''}`, dist: rel.distance });
    }
  }
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -3; dy <= 3; dy++) {
        const b = bot.blockAt(base.offset(dx, dy, dz));
        if (!b || !DANGER.test(b.name)) continue;
        const rel = relative(pose, b.position.offset(0.5, 0, 0.5));
        dangers.push({ text: `${b.name}：${rel.text} ${sight(bot, pose, b.position)}`, dist: rel.distance });
      }
    }
  }
  for (const e of Object.values(bot.entities)) {
    if (!e.position || e === bot.entity || !isHostile(e)) continue;
    const d = e.position.distanceTo(pose.pos);
    if (d > 16) continue;
    dangers.push({ text: `${e.name ?? e.displayName}：${relative(pose, e.position).text} ${sight(bot, pose, e.position.offset(0, 1, 0), false)}`, dist: d });
  }
  dangers.sort((a, b) => a.dist - b.dist);
  if (dangers.length) {
    lines.push('危险：');
    lines.push(...limited(dangers, MAX_LIST, (d) => `- ${d.text}`));
  } else {
    lines.push('危险：没发现落差、岩浆或敌对生物（只看了已加载的方块和实体）');
  }

  if (unloadedColumns) {
    lines.push(`未知：${r} 格内有 ${Math.round((unloadedColumns / columns) * 100)}% 的位置区块未加载，那里是什么不清楚（不是空地）`);
  }
  return lines.join('\n');
}
