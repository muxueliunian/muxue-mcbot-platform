// 形状展开和蓝图：build 的 shapes（填满、空心、四面墙、直线、坡屋顶）；蓝图用相对坐标保存，放的时候可以转四个方向。
// 蓝图存在数据目录的 blueprints/<名字>.json，不分世界
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { formatBlockSpec, parseBlockSpec, rotatePos, rotateSpec, rotatedSize, type BlockSpec, type Rotation } from './block-state.js';
import { ysmDataDir } from './ysm.js';

export interface Point {
  x: number;
  y: number;
  z: number;
}

export type ShapeKind = 'fill' | 'hollow' | 'walls' | 'line' | 'roof';

export interface ShapeInput {
  shape: ShapeKind;
  from: Point;
  to: Point;
  block: string;
  ridge?: 'x' | 'z';
  ridgeBlock?: string;
  gableBlock?: string;
}

export interface Cell {
  pos: Vec3;
  block: string;
}

function bounds(from: Point, to: Point) {
  return {
    x1: Math.floor(Math.min(from.x, to.x)), x2: Math.floor(Math.max(from.x, to.x)),
    y1: Math.floor(Math.min(from.y, to.y)), y2: Math.floor(Math.max(from.y, to.y)),
    z1: Math.floor(Math.min(from.z, to.z)), z2: Math.floor(Math.max(from.z, to.z))
  };
}

function boxCells(from: Point, to: Point, limit: number, keep: (x: number, y: number, z: number) => boolean): Vec3[] {
  const { x1, x2, y1, y2, z1, z2 } = bounds(from, to);
  const volume = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
  if (volume > limit) throw new Error(`区域太大：${volume} 格，单次最多 ${limit} 格，请分块执行`);
  const out: Vec3[] = [];
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      for (let z = z1; z <= z2; z++) {
        if (keep(x, y, z)) out.push(new Vec3(x, y, z));
      }
    }
  }
  return out;
}

export function lineCells(from: Point, to: Point): Vec3[] {
  const a = new Vec3(Math.floor(from.x), Math.floor(from.y), Math.floor(from.z));
  const b = new Vec3(Math.floor(to.x), Math.floor(to.y), Math.floor(to.z));
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    out.push(new Vec3(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t), Math.round(a.z + (b.z - a.z) * t)));
  }
  return out;
}

// 楼梯名 → 同材质的半砖、完整方块（oak_stairs → oak_slab / oak_planks，stone_brick_stairs → stone_brick_slab / stone_bricks）
export function roofMaterials(stairs: string, exists: (name: string) => boolean): { slab: string | null; full: string | null } {
  const base = stairs.replace(/_stairs$/, '');
  const slab = [`${base}_slab`].find(exists) ?? null;
  const full = [`${base}_planks`, `${base}s`, base].find(exists) ?? null;
  return { slab, full };
}

// 双坡屋顶：from/to 是屋顶最下面一层的范围（可以比墙大一圈做屋檐），一层层往里收，楼梯朝屋脊。
// 屋脊方向默认沿长边；宽度是奇数时屋脊那一排用 ridgeBlock（默认同材质的下半砖）；
// 两头的三角山墙用 gableBlock 填上（默认同材质的完整方块，写 none 不填）。山墙也是楼梯的支撑
export function roofCells(s: ShapeInput, exists: (name: string) => boolean): Cell[] {
  const { x1, x2, y1, z1, z2 } = bounds(s.from, s.to);
  const stairs = parseBlockSpec(s.block).name;
  if (!/_stairs$/.test(stairs)) throw new Error(`roof 的 block 要写楼梯，比如 oak_stairs（现在是 ${s.block}）`);
  const mat = roofMaterials(stairs, exists);
  const ridgeBlock = s.ridgeBlock ?? (mat.slab ? `${mat.slab}[type=bottom]` : mat.full ?? stairs);
  const gable = s.gableBlock === 'none' ? null : s.gableBlock ?? mat.full;
  const ridge = s.ridge ?? (x2 - x1 >= z2 - z1 ? 'x' : 'z');
  const out: Cell[] = [];
  // 把「沿屋脊方向 a、横跨方向 b」换回 x/z
  const at = (a: number, y: number, b: number) => (ridge === 'x' ? new Vec3(a, y, b) : new Vec3(b, y, a));
  const [a1, a2, b1, b2] = ridge === 'x' ? [x1, x2, z1, z2] : [z1, z2, x1, x2];
  const [lowFacing, highFacing] = ridge === 'x' ? ['south', 'north'] : ['east', 'west'];
  for (let k = 0; ; k++) {
    const bl = b1 + k, br = b2 - k, y = y1 + k;
    if (bl > br) break;
    if (bl === br) {
      for (let a = a1; a <= a2; a++) out.push({ pos: at(a, y, bl), block: ridgeBlock });
      break;
    }
    for (let a = a1; a <= a2; a++) {
      out.push({ pos: at(a, y, bl), block: `${stairs}[facing=${lowFacing},half=bottom]` });
      out.push({ pos: at(a, y, br), block: `${stairs}[facing=${highFacing},half=bottom]` });
    }
    if (gable) {
      for (let b = bl + 1; b < br; b++) {
        out.push({ pos: at(a1, y, b), block: gable });
        if (a2 !== a1) out.push({ pos: at(a2, y, b), block: gable });
      }
    }
  }
  return out;
}

export function shapeCells(s: ShapeInput, limit: number, exists: (name: string) => boolean): Cell[] {
  const { x1, x2, y1, y2, z1, z2 } = bounds(s.from, s.to);
  const withBlock = (list: Vec3[]) => list.map((pos) => ({ pos, block: s.block }));
  switch (s.shape) {
    case 'fill':
      return withBlock(boxCells(s.from, s.to, limit, () => true));
    case 'walls':
      return withBlock(boxCells(s.from, s.to, limit, (x, _y, z) => x === x1 || x === x2 || z === z1 || z === z2));
    case 'hollow':
      return withBlock(boxCells(s.from, s.to, limit, (x, y, z) => x === x1 || x === x2 || z === z1 || z === z2 || y === y1 || y === y2));
    case 'line':
      return withBlock(lineCells(s.from, s.to));
    case 'roof': {
      const cells = roofCells(s, exists);
      if (cells.length > limit) throw new Error(`屋顶太大：${cells.length} 格，单次最多 ${limit} 格`);
      return cells;
    }
    default:
      throw new Error(`不认识的形状：${String((s as { shape: unknown }).shape)}`);
  }
}

// ---- 蓝图 ----

export interface Blueprint {
  version: 1;
  name: string;
  description: string;
  size: Point;
  // [x, y, z, 方块写法]，相对坐标，最小角是 (0,0,0)
  blocks: [number, number, number, string][];
  createdAt: string;
  source: string;
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;

export function blueprintDir(): string {
  return path.join(ysmDataDir(), 'blueprints');
}

function fileOf(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`蓝图名只能用字母、数字、中文、下划线和横线，最多 40 个字：${name}`);
  return path.join(blueprintDir(), `${name}.json`);
}

function isBlueprint(data: unknown): data is Blueprint {
  const d = data as Blueprint;
  return Boolean(d && d.version === 1 && typeof d.name === 'string' && Array.isArray(d.blocks) && d.size);
}

// 把一组绝对/相对坐标的方块整理成蓝图：平移到最小角 (0,0,0)，后写的覆盖先写的。
// base：从世界里框下来时用框的最小角做原点（不然最下面一层是空的时会整体下移）
export function makeBlueprint(name: string, description: string, cells: Cell[], source: string, base?: Vec3): Blueprint {
  if (!cells.length) throw new Error('蓝图里没有方块');
  const min = base ? base.clone() : new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  for (const c of cells) {
    if (!base) {
      min.x = Math.min(min.x, c.pos.x); min.y = Math.min(min.y, c.pos.y); min.z = Math.min(min.z, c.pos.z);
    }
    max.x = Math.max(max.x, c.pos.x); max.y = Math.max(max.y, c.pos.y); max.z = Math.max(max.z, c.pos.z);
  }
  const map = new Map<string, [number, number, number, string]>();
  for (const c of cells) {
    const p = c.pos.minus(min);
    map.set(`${p.x},${p.y},${p.z}`, [p.x, p.y, p.z, formatBlockSpec(parseBlockSpec(c.block))]);
  }
  return {
    version: 1,
    name,
    description,
    size: { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 },
    blocks: [...map.values()],
    createdAt: new Date().toISOString(),
    source
  };
}

export function saveBlueprint(bp: Blueprint, overwrite: boolean): string {
  const file = fileOf(bp.name);
  if (!overwrite && fs.existsSync(file)) throw new Error(`已经有叫「${bp.name}」的蓝图了；要覆盖就加 overwrite: true`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bp) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

export function loadBlueprint(name: string): Blueprint {
  const file = fileOf(name);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`没有叫「${name}」的蓝图（用 list-blueprints 看有哪些）`);
    throw err;
  }
  const data: unknown = JSON.parse(raw);
  if (!isBlueprint(data)) throw new Error(`蓝图文件格式不对：${file}`);
  return data;
}

export function listBlueprints(): Blueprint[] {
  let names: string[];
  try {
    names = fs.readdirSync(blueprintDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Blueprint[] = [];
  for (const f of names) {
    try {
      out.push(loadBlueprint(f.slice(0, -5)));
    } catch {
      // 坏文件跳过
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteBlueprint(name: string): boolean {
  const file = fileOf(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// 放到世界里：origin 是转完之后的最小角
export function placeBlueprint(bp: Blueprint, origin: Point, rotation: Rotation): Cell[] {
  const size = new Vec3(bp.size.x, bp.size.y, bp.size.z);
  const o = new Vec3(Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z));
  return bp.blocks.map(([x, y, z, block]) => ({
    pos: rotatePos(new Vec3(x, y, z), rotation, size).plus(o),
    block: formatBlockSpec(rotateSpec(parseBlockSpec(block), rotation))
  }));
}

export function blueprintFootprint(bp: Blueprint, rotation: Rotation): Point {
  const s = rotatedSize(new Vec3(bp.size.x, bp.size.y, bp.size.z), rotation);
  return { x: s.x, y: s.y, z: s.z };
}

// ---- 改蓝图 ----

export interface BlueprintEdit {
  // 换材料：from 只写名字时换掉所有这种方块，保留新方块也有的属性（朝向、上下半等）；写了属性就只换属性对得上的
  replace?: { from: string; to: string }[];
  // 只在这个范围（蓝图里的相对坐标）里换
  within?: { from: Point; to: Point };
  // 删掉这些范围里的格子（相对坐标）
  remove?: { from: Point; to: Point }[];
  // 改/加几格（相对坐标，不能是负的）；写 air 表示「盖的时候把这里清空」
  set?: { x: number; y: number; z: number; block: string }[];
}

interface EditRegistry {
  blocksByName: Record<string, { states?: { name: string; type: string; values?: string[]; num_values?: number }[] } | undefined>;
}

function inBox(x: number, y: number, z: number, box: { from: Point; to: Point }): boolean {
  const b = bounds(box.from, box.to);
  return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2 && z >= b.z1 && z <= b.z2;
}

// 旧方块的属性里，新方块也有的留下
function carryProps(props: Record<string, string>, name: string, reg: EditRegistry): Record<string, string> {
  const states = reg.blocksByName[name]?.states ?? [];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    const s = states.find((st) => st.name === k);
    if (!s) continue;
    const values = s.type === 'bool' ? ['true', 'false'] : s.values ?? [];
    if (!values.length || values.includes(v)) out[k] = v;
  }
  return out;
}

export function editBlueprint(bp: Blueprint, edit: BlueprintEdit, reg: EditRegistry): { bp: Blueprint; replaced: Map<string, number>; removed: number; set: number } {
  const map = new Map<string, [number, number, number, string]>();
  for (const b of bp.blocks) map.set(`${b[0]},${b[1]},${b[2]}`, [b[0], b[1], b[2], b[3]]);
  const replaced = new Map<string, number>();
  const rules = (edit.replace ?? []).map((r) => ({ from: parseBlockSpec(r.from), to: parseBlockSpec(r.to), text: `${r.from} → ${r.to}` }));
  for (const r of rules) {
    if (!reg.blocksByName[r.to.name] && r.to.name !== 'air') throw new Error(`没有叫 ${r.to.name} 的方块`);
    replaced.set(r.text, 0);
  }
  for (const cell of map.values()) {
    if (edit.within && !inBox(cell[0], cell[1], cell[2], edit.within)) continue;
    const spec = parseBlockSpec(cell[3]);
    // 一格只按第一条对得上的规则换一次，免得 a→b、b→a 换来换去
    const rule = rules.find((r) => r.from.name === spec.name && Object.entries(r.from.props).every(([k, v]) => spec.props[k] === v));
    if (!rule) continue;
    const props = replacedProps(rule, spec, reg);
    cell[3] = formatBlockSpec({ name: rule.to.name, props });
    replaced.set(rule.text, (replaced.get(rule.text) ?? 0) + 1);
  }
  let removed = 0;
  for (const box of edit.remove ?? []) {
    for (const [key, cell] of map) {
      if (inBox(cell[0], cell[1], cell[2], box)) {
        map.delete(key);
        removed++;
      }
    }
  }
  for (const s of edit.set ?? []) {
    const [x, y, z] = [Math.floor(s.x), Math.floor(s.y), Math.floor(s.z)];
    if (x < 0 || y < 0 || z < 0) throw new Error(`(${x}, ${y}, ${z}) 是负的：蓝图坐标从 0 开始`);
    map.set(`${x},${y},${z}`, [x, y, z, formatBlockSpec(parseBlockSpec(s.block))]);
  }
  const blocks = [...map.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  const size = { ...bp.size };
  for (const [x, y, z] of blocks) {
    size.x = Math.max(size.x, x + 1);
    size.y = Math.max(size.y, y + 1);
    size.z = Math.max(size.z, z + 1);
  }
  return { bp: { ...bp, size, blocks, createdAt: new Date().toISOString() }, replaced, removed, set: edit.set?.length ?? 0 };
}

function replacedProps(rule: { from: BlockSpec; to: BlockSpec }, spec: BlockSpec, reg: EditRegistry): Record<string, string> {
  if (rule.to.name === 'air') return {};
  return { ...carryProps(spec.props, rule.to.name, reg), ...rule.to.props };
}
