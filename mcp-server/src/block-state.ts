// 带状态的方块写法（和原版命令一样：oak_stairs[facing=east,half=top]）、放置规则、蓝图旋转。
// 放置规则：服务器按「玩家朝向、点的是参考方块的哪个面、点在面上的哪个位置」决定新方块的状态，
// 这里把想要的状态反推成这几个条件。只写了常见的方块种类；规则没覆盖或记错时，build 会核对结果、必要时换个朝向重放
import { Vec3 } from 'vec3';

export type Dir = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
export const HORIZONTAL: Dir[] = ['north', 'east', 'south', 'west'];
export const ALL_DIRS: Dir[] = ['down', 'up', 'north', 'south', 'west', 'east'];

const VEC: Record<Dir, [number, number, number]> = {
  north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0]
};

export function dirVec(d: Dir): Vec3 {
  const [x, y, z] = VEC[d];
  return new Vec3(x, y, z);
}

export function opposite(d: Dir): Dir {
  return ({ north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' } as const)[d];
}

// 从上往下看顺时针转 90°
export function clockwise(d: Dir): Dir {
  return ({ north: 'east', east: 'south', south: 'west', west: 'north', up: 'up', down: 'down' } as const)[d];
}

export function counterClockwise(d: Dir): Dir {
  return ({ north: 'west', west: 'south', south: 'east', east: 'north', up: 'up', down: 'down' } as const)[d];
}

// mineflayer 的 yaw：0 朝北，逆时针为正
export function yawOf(d: Dir): number {
  return ({ north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 } as Record<string, number>)[d] ?? 0;
}

export function isDir(s: string): s is Dir {
  return s in VEC;
}

// ---- 写法 ----

export interface BlockSpec {
  name: string;
  props: Record<string, string>;
}

const SPEC_RE = /^\s*(?:minecraft:)?([a-z0-9_]+)\s*(?:\[([^\]]*)\])?\s*$/;

export function parseBlockSpec(text: string): BlockSpec {
  const m = SPEC_RE.exec(text.toLowerCase());
  if (!m) throw new Error(`方块写法不对：${text}（例：oak_stairs[facing=east,half=bottom]）`);
  const props: Record<string, string> = {};
  if (m[2]?.trim()) {
    for (const part of m[2].split(',')) {
      const [k, v, extra] = part.split('=').map((s) => s.trim());
      if (!k || !v || extra !== undefined) throw new Error(`方块状态写法不对：${text}（属性写成 名字=值，用逗号隔开）`);
      props[k] = v;
    }
  }
  return { name: m[1], props };
}

// 属性按名字排序，同一个状态写出来总是一样的
export function formatBlockSpec(spec: BlockSpec): string {
  const entries = Object.entries(spec.props).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `${spec.name}[${entries.map(([k, v]) => `${k}=${v}`).join(',')}]` : spec.name;
}

// 由周围方块自动决定、放置时控制不了的属性：核对时忽略
export const AUTO_PROPS = new Set([
  'waterlogged', 'shape', 'north', 'south', 'east', 'west', 'up', 'powered', 'occupied', 'open', 'in_wall', 'snowy',
  'distance', 'persistent', 'extended', 'enabled', 'triggered', 'lit', 'attached', 'disarmed', 'conditional', 'signal_fire',
  'has_book', 'has_record', 'bottom', 'leaves', 'stage', 'age', 'level', 'power', 'note', 'instrument', 'moisture', 'honey_level',
  'hatch', 'eggs', 'pickles', 'candles', 'layers', 'bites', 'rotation', 'mode', 'inverted', 'locked', 'delay', 'tilt', 'type_left'
]);

// 只核对这些由放置决定、又指定了的属性
export function controlledProps(spec: BlockSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.props)) {
    if (AUTO_PROPS.has(k)) continue;
    if (k === 'half' && (/_door$/.test(spec.name) || DOUBLE_PLANTS.has(spec.name))) continue;
    if (k === 'part' && /_bed$/.test(spec.name)) continue;
    if (k === 'type' && /chest$/.test(spec.name)) continue; // 单箱/大箱子由旁边的箱子决定
    out[k] = v;
  }
  return out;
}

export function stateMatches(spec: BlockSpec, name: string, props: Record<string, unknown>): boolean {
  if (spec.name !== name) return false;
  for (const [k, v] of Object.entries(controlledProps(spec))) {
    if (String(props[k]) !== v) return false;
  }
  return true;
}

// 上下两格的植物：放下半时上半自动长出来
export const DOUBLE_PLANTS = new Set([
  'tall_grass', 'large_fern', 'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_seagrass', 'small_dripleaf', 'pitcher_plant'
]);

// 门的上半、床头、双格植物的上半是放下半/床尾时自动出现的，不单独放
export function isCompanionCell(spec: BlockSpec): boolean {
  return ((/_door$/.test(spec.name) || DOUBLE_PLANTS.has(spec.name)) && spec.props.half === 'upper') ||
    (/_bed$/.test(spec.name) && spec.props.part === 'head');
}

// 放下后还会自动占用的另一格（相对坐标）
export function extraCell(spec: BlockSpec): Vec3 | null {
  if (/_door$/.test(spec.name) || DOUBLE_PLANTS.has(spec.name)) return new Vec3(0, 1, 0);
  if (/_bed$/.test(spec.name)) {
    const f = spec.props.facing;
    return f && isDir(f) ? dirVec(f) : null;
  }
  return null;
}

// 要靠别的方块支撑、最好等墙和地板放完再放的
export const LATE = /(_door|_bed|torch|ladder|_trapdoor|_button|^lever|lantern|_sign|_banner|tripwire_hook|_carpet|_pressure_plate|rail$|flower_pot|candle|^chain$|_head$|_skull$|^bell$|^scaffolding$)/;

// ---- 方块和物品 ----

interface RegistryLike {
  blocksByName: Record<string, { states?: { name: string; type: string; values?: string[]; num_values?: number }[] } | undefined>;
  itemsByName: Record<string, unknown>;
}

const ITEM_OF: Record<string, string> = {
  wall_torch: 'torch', soul_wall_torch: 'soul_torch', redstone_wall_torch: 'redstone_torch', redstone_wire: 'redstone',
  tripwire: 'string', skeleton_wall_skull: 'skeleton_skull', wither_skeleton_wall_skull: 'wither_skeleton_skull',
  zombie_wall_head: 'zombie_head', player_wall_head: 'player_head', creeper_wall_head: 'creeper_head',
  dragon_wall_head: 'dragon_head', piglin_wall_head: 'piglin_head'
};

// 放这个方块要用哪个物品；放不了（不是物品）返回 null
export function itemForBlock(name: string, reg: RegistryLike): string | null {
  const candidates = [ITEM_OF[name], name, name.replace(/_wall_(sign|hanging_sign|banner)$/, '_$1'), name.replace(/_wall_fan$/, '_fan')];
  for (const c of candidates) if (c && reg.itemsByName[c]) return c;
  return null;
}

function propValues(s: { type: string; values?: string[]; num_values?: number }): string[] {
  if (s.type === 'bool') return ['true', 'false'];
  // 整数属性优先用数据里的实际取值（candles、layers、delay 从 1 开始），没有才按 0..n-1
  if (s.type === 'int') return s.values?.length ? s.values : Array.from({ length: s.num_values ?? 0 }, (_, i) => String(i));
  return s.values ?? [];
}

// 检查方块名和属性是不是真的存在；有问题返回说明
export function validateSpec(spec: BlockSpec, reg: RegistryLike): string | null {
  if (spec.name === 'air') return Object.keys(spec.props).length ? 'air 不能带属性' : null;
  const block = reg.blocksByName[spec.name];
  if (!block) return `没有叫 ${spec.name} 的方块`;
  if (!itemForBlock(spec.name, reg)) return `${spec.name} 没有对应的物品，放不了`;
  const states = block.states ?? [];
  for (const [k, v] of Object.entries(spec.props)) {
    const s = states.find((st) => st.name === k);
    if (!s) return `${spec.name} 没有 ${k} 这个属性（有：${states.map((st) => st.name).join('、') || '无'}）`;
    const values = propValues(s);
    if (!values.includes(v)) return `${spec.name} 的 ${k} 只能是 ${values.join('/')}，不能是 ${v}`;
  }
  if (/_slab$/.test(spec.name) && spec.props.type === 'double') return '双层半砖放不了，请直接用对应的完整方块';
  return null;
}

// ---- 旋转（蓝图用） ----

export type Rotation = 0 | 90 | 180 | 270;

function turns(rot: Rotation): number {
  return rot / 90;
}

// 相对坐标绕 y 轴顺时针转，转完仍从 (0,0,0) 开始。size 是转之前的尺寸
export function rotatePos(p: Vec3, rot: Rotation, size: Vec3): Vec3 {
  switch (rot) {
    case 90: return new Vec3(size.z - 1 - p.z, p.y, p.x);
    case 180: return new Vec3(size.x - 1 - p.x, p.y, size.z - 1 - p.z);
    case 270: return new Vec3(p.z, p.y, size.x - 1 - p.x);
    default: return p.clone();
  }
}

export function rotatedSize(size: Vec3, rot: Rotation): Vec3 {
  return rot === 90 || rot === 270 ? new Vec3(size.z, size.y, size.x) : size.clone();
}

export function rotateSpec(spec: BlockSpec, rot: Rotation): BlockSpec {
  const n = turns(rot);
  if (!n) return spec;
  const props = { ...spec.props };
  const f = props.facing;
  if (f && isDir(f) && HORIZONTAL.includes(f)) {
    let d: Dir = f;
    for (let i = 0; i < n; i++) d = clockwise(d);
    props.facing = d;
  }
  if (props.axis && n % 2 === 1) props.axis = props.axis === 'x' ? 'z' : props.axis === 'z' ? 'x' : props.axis;
  if (props.rotation !== undefined && /^\d+$/.test(props.rotation)) props.rotation = String((Number(props.rotation) + 4 * n) % 16);
  return { name: spec.name, props };
}

// ---- 放置规则 ----

// 一种放法：点哪些面（从参考方块指向新方块的方向）、玩家朝哪边、点在面的上半还是下半
export interface Placement {
  faces: Dir[];
  horizontal?: Dir; // 玩家水平朝向
  look?: Dir; // 玩家视线最接近的方向（六个方向都可能，决定俯仰）
  hitY?: 'low' | 'high'; // 点侧面时点在上半还是下半
  hinge?: 'left' | 'right'; // 门轴，按点的位置和旁边的方块决定
}

export interface PlacementPlan {
  options: Placement[]; // 按顺序尝试，第一个找得到参考方块的就用
  // facing 由规则反推、没把握的方块：放错了会换个朝向重放
  facingGuess: boolean;
  notes: string[];
}

const SIDES: Dir[] = ['north', 'south', 'west', 'east'];
const ANY_FACE: Dir[] = ['up', ...SIDES, 'down'];

// 玩家朝向的反方向就是方块朝向（正面对着玩家）
const FACES_PLAYER = /^(chest|trapped_chest|ender_chest|furnace|smoker|blast_furnace|carved_pumpkin|jack_o_lantern|lectern|beehive|bee_nest|loom|stonecutter|repeater|comparator|end_portal_frame|chiseled_bookshelf|.*_glazed_terracotta)$/;
// 方块朝向和玩家朝向相同
const FACES_AWAY = /(_stairs|_door|_fence_gate|_bed|campfire|decorated_pot)$/;
// 六个方向，朝向 = 视线的反方向
const LOOK_OPPOSITE = /^(piston|sticky_piston|dispenser|dropper|barrel|crafter)$/;
// 朝向 = 点的那个面
const FACE_CLICKED = /^(end_rod|lightning_rod|.*amethyst_cluster|.*amethyst_bud|.*shulker_box)$/;
// 只能贴在墙侧面，朝向 = 点的那个面
const WALL_ONLY = /^(wall_torch|soul_wall_torch|redstone_wall_torch|ladder|tripwire_hook|.*_wall_banner|.*_wall_head|.*_wall_skull)$/;
const FACE_ATTACHED = /(_button|^lever|^grindstone)$/;

function sideHitY(half: string | undefined): 'low' | 'high' | undefined {
  return half === 'top' ? 'high' : half === 'bottom' ? 'low' : undefined;
}

export function placementPlan(spec: BlockSpec): PlacementPlan {
  const { name, props } = spec;
  const facing = props.facing && isDir(props.facing) ? props.facing : undefined;
  const notes: string[] = [];
  const plan = (options: Placement[], facingGuess = false): PlacementPlan => ({ options, facingGuess, notes });

  if (/_stairs$/.test(name)) {
    const half = props.half;
    const base: Placement = { faces: ANY_FACE, horizontal: facing };
    if (half === 'top') return plan([{ ...base, faces: ['down'] }, { ...base, faces: SIDES, hitY: 'high' }]);
    if (half === 'bottom') return plan([{ ...base, faces: ['up'] }, { ...base, faces: SIDES, hitY: 'low' }]);
    return plan([base]);
  }
  if (/_slab$/.test(name)) {
    if (props.type === 'top') return plan([{ faces: ['down'] }, { faces: SIDES, hitY: 'high' }]);
    if (props.type === 'bottom') return plan([{ faces: ['up'] }, { faces: SIDES, hitY: 'low' }]);
    return plan([{ faces: ANY_FACE }]);
  }
  if (props.axis) {
    const faces: Dir[] = props.axis === 'y' ? ['up', 'down'] : props.axis === 'x' ? ['east', 'west'] : ['north', 'south'];
    return plan([{ faces }]);
  }
  if (/_trapdoor$/.test(name)) {
    const half = props.half;
    const opts: Placement[] = [];
    if (facing) opts.push({ faces: [facing], hitY: sideHitY(half) });
    const vertical: Dir[] = half === 'top' ? ['down'] : half === 'bottom' ? ['up'] : ['up', 'down'];
    opts.push({ faces: vertical, horizontal: facing ? opposite(facing) : undefined });
    return plan(opts);
  }
  if (/_door$/.test(name)) {
    const hinge = props.hinge === 'left' || props.hinge === 'right' ? props.hinge : undefined;
    return plan([{ faces: ['up'], horizontal: facing, hinge }]);
  }
  if (/_bed$/.test(name)) return plan([{ faces: ['up', ...SIDES], horizontal: facing }]);
  if (/^(lantern|soul_lantern)$/.test(name)) {
    if (props.hanging === 'true') return plan([{ faces: ['down'], look: 'up' }]);
    if (props.hanging === 'false') return plan([{ faces: ['up'], look: 'down' }]);
    return plan([{ faces: ['up', 'down'] }]);
  }
  if (WALL_ONLY.test(name)) {
    return plan([{ faces: facing ? [facing] : SIDES, look: facing ? opposite(facing) : undefined }]);
  }
  if (FACE_ATTACHED.test(name)) {
    const face = props.face;
    if (face === 'floor') return plan([{ faces: ['up'], look: 'down', horizontal: facing }]);
    if (face === 'ceiling') return plan([{ faces: ['down'], look: 'up', horizontal: facing }]);
    if (face === 'wall') return plan([{ faces: facing ? [facing] : SIDES, look: facing ? opposite(facing) : undefined }]);
    return plan([{ faces: ANY_FACE, horizontal: facing }]);
  }
  if (name === 'hopper') {
    if (!facing) return plan([{ faces: ANY_FACE }]);
    return plan([{ faces: facing === 'down' ? ['up', 'down'] : [opposite(facing)] }]);
  }
  if (FACE_CLICKED.test(name)) return plan([{ faces: facing ? [facing] : ANY_FACE }]);
  if (name === 'observer') return plan([{ faces: ANY_FACE, look: facing }]);
  if (LOOK_OPPOSITE.test(name)) return plan([{ faces: ANY_FACE, look: facing ? opposite(facing) : undefined }]);
  if (name === 'anvil' || name === 'chipped_anvil' || name === 'damaged_anvil') {
    return plan([{ faces: ANY_FACE, horizontal: facing ? counterClockwise(facing) : undefined }]);
  }
  if (FACES_PLAYER.test(name)) return plan([{ faces: ANY_FACE, horizontal: facing ? opposite(facing) : undefined }]);
  if (FACES_AWAY.test(name)) return plan([{ faces: ANY_FACE, horizontal: facing }]);
  if (facing) {
    // 不认识的有朝向方块：先按「朝向 = 玩家朝向的反方向」试，放错了由调用方换朝向重放
    const horizontal = HORIZONTAL.includes(facing);
    return plan([{ faces: ANY_FACE, horizontal: horizontal ? opposite(facing) : undefined, look: horizontal ? undefined : opposite(facing) }], true);
  }
  return plan([{ faces: ANY_FACE }]);
}

// 点在参考方块面上的位置（相对参考方块的角），交给 _genericPlace 的 delta
export function cursorFor(face: Dir, hitY: 'low' | 'high' | undefined, hitXZ?: { x: number; z: number }): Vec3 {
  const v = dirVec(face);
  // 新方块 = 参考方块 + 面方向；点的位置相对新方块 = delta - v
  const relDest = new Vec3(hitXZ?.x ?? 0.5, hitY === 'high' ? 0.75 : hitY === 'low' ? 0.25 : 0.5, hitXZ?.z ?? 0.5);
  if (v.x) relDest.x = v.x > 0 ? 0 : 1;
  if (v.y) relDest.y = v.y > 0 ? 0 : 1;
  if (v.z) relDest.z = v.z > 0 ? 0 : 1;
  return relDest.plus(v);
}

// 原版 DoorBlock.getHinge：旁边整块的方块和门决定门轴，两边一样时看点在门格的哪一侧
export function doorHinge(
  facing: Dir,
  hitRel: { x: number; z: number },
  neighbor: (side: 'left' | 'right', upper: boolean) => { full: boolean; lowerDoor: boolean }
): 'left' | 'right' {
  const lLow = neighbor('left', false), lUp = neighbor('left', true), rLow = neighbor('right', false), rUp = neighbor('right', true);
  const i = (lLow.full ? -1 : 0) + (lUp.full ? -1 : 0) + (rLow.full ? 1 : 0) + (rUp.full ? 1 : 0);
  const leftDoor = lLow.lowerDoor, rightDoor = rLow.lowerDoor;
  if ((!leftDoor || rightDoor) && i <= 0) {
    if ((!rightDoor || leftDoor) && i >= 0) {
      const [j, , k] = VEC[facing];
      const d0 = hitRel.x, d1 = hitRel.z;
      return (j >= 0 || !(d1 < 0.5)) && (j <= 0 || !(d1 > 0.5)) && (k >= 0 || !(d0 > 0.5)) && (k <= 0 || !(d0 < 0.5)) ? 'left' : 'right';
    }
    return 'left';
  }
  return 'right';
}

// 门的「左边」：面朝门的朝向时的左手边
export function doorSide(facing: Dir, side: 'left' | 'right'): Dir {
  return side === 'left' ? counterClockwise(facing) : clockwise(facing);
}
