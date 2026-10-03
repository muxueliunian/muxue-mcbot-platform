// 图纸导入：读 Sponge .schem（v2/v3）、Litematica .litematic、原版结构方块 .nbt，转成蓝图。
// 格式细节和取舍见 docs/research/schematic_import.md。图纸放在数据目录的 schematics/ 下
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';
import { AUTO_PROPS, formatBlockSpec, isCompanionCell, parseBlockSpec, validateSpec, type BlockSpec } from './block-state.js';
import type { Blueprint } from './blueprints.js';
import { ysmDataDir } from './ysm.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_VOLUME = 2_000_000; // 解码的格数上限（和能建多少格无关）
const AIR = new Set(['air', 'cave_air', 'void_air']);
const EXTENSIONS = ['.schem', '.schematic', '.litematic', '.nbt'];
// 1.13 扁平化之后的第一个正式版
const FLATTENING = 1519;

export type SchematicFormat = 'auto' | 'sponge' | 'litematica' | 'structure';
export type ConflictMode = 'error' | 'first' | 'last';

export interface DecodedSchematic {
  format: string;
  dataVersion: number | null;
  size: [number, number, number];
  // 非空气的格子，坐标已经挪到最小角 (0,0,0)，状态是原样的（可能带 minecraft:）
  cells: [number, number, number, string][];
  regions: string[];
  paletteNote: string | null;
  declared: number;
  air: number;
  overlaps: number;
  blockEntities: number;
  entities: number;
}

export interface DecodeOptions {
  format?: SchematicFormat;
  regionNames?: string[];
  paletteIndex?: number;
  onConflict?: ConflictMode;
}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function int3(a: unknown, label: string): [number, number, number] {
  check(Array.isArray(a) && a.length === 3 && a.every((v) => Number.isSafeInteger(v)), `${label} 应该是三个整数`);
  return a as [number, number, number];
}

function dims(a: [number, number, number], label: string): [number, number, number] {
  check(a.every((v) => v > 0), `${label} 的尺寸不对：${a.join('×')}`);
  check(a[0] * a[1] * a[2] <= MAX_VOLUME, `${label} 太大：${a.join('×')}，最多解码 ${MAX_VOLUME} 格`);
  return a;
}

// Litematica / 结构方块的调色板项 { Name, Properties } → 状态字符串
function stateOf(entry: { Name?: unknown; Properties?: Record<string, unknown> }): string {
  check(entry && typeof entry.Name === 'string', '调色板项缺少 Name');
  const props = Object.entries(entry.Properties ?? {}).sort(([a], [b]) => a.localeCompare(b));
  check(props.every(([, v]) => typeof v === 'string'), `${entry.Name} 的属性值应该是字符串`);
  return props.length ? `${entry.Name}[${props.map(([k, v]) => `${k}=${v}`).join(',')}]` : entry.Name as string;
}

// Sponge 的 BlockData：每格一个 VarInt（低 7 位在前，最高位 1 表示还有下一字节）
export function readVarints(bytes: ArrayLike<number>, count: number): number[] {
  check(bytes && typeof bytes.length === 'number', '缺少方块数据');
  const out: number[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    let value = 0;
    let ended = false;
    for (let j = 0; j < 5; j++) {
      check(p < bytes.length, `方块数据被截断了（第 ${i} 格），文件可能不完整`);
      const b = bytes[p++] & 255;
      check(j !== 4 || (b & 0xf8) === 0, '方块数据里的数字超出范围，文件可能坏了');
      value += (b & 127) * 2 ** (7 * j);
      if (!(b & 128)) {
        ended = true;
        break;
      }
    }
    check(ended, '方块数据里的数字超过 5 字节，文件可能坏了');
    out.push(value);
  }
  check(p === bytes.length, `方块数据比 ${count} 格多出 ${bytes.length - p} 字节，文件可能坏了`);
  return out;
}

// prismarine-nbt 的 long 是 [高 32 位, 低 32 位]（都有符号）
function u64(v: unknown): bigint {
  if (typeof v === 'bigint') return BigInt.asUintN(64, v);
  check(Array.isArray(v) && v.length === 2 && v.every(Number.isInteger), '不认识的 long 写法');
  return (BigInt((v[0] as number) >>> 0) << 32n) | BigInt((v[1] as number) >>> 0);
}

// Litematica 的 BlockStates：每格 max(2, ceil(log2(调色板项数))) 位，从 long 的低位开始连续排，可以跨两个 long
export function unpackLitematica(longs: unknown, count: number, paletteSize: number, label: string): number[] {
  check(paletteSize > 0, `区域 ${label} 的调色板是空的`);
  const bits = Math.max(2, Math.ceil(Math.log2(paletteSize)));
  const need = Math.ceil((count * bits) / 64);
  check(Array.isArray(longs), `区域 ${label} 缺少 BlockStates`);
  check(longs.length === need, `区域 ${label}：BlockStates 需要 ${need} 个 long，实际 ${longs.length}；文件可能被截断了`);
  const a = longs.map(u64);
  const mask = (1n << BigInt(bits)) - 1n;
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const bit = i * bits;
    const q = Math.floor(bit / 64);
    const r = bit % 64;
    let v = a[q] >> BigInt(r);
    if (r + bits > 64) v |= a[q + 1] << BigInt(64 - r);
    out[i] = Number(v & mask);
  }
  return out;
}

interface Box {
  label: string;
  min: [number, number, number];
  size: [number, number, number];
  // 按 x 最快、z 其次、y 最慢排的调色板编号
  ids?: number[];
  palette?: Map<number, string>;
  // 结构方块：稀疏的格子
  sparse?: [number, number, number, string][];
}

type Nbt = Record<string, any>;

function spongeBox(raw: Nbt): { box: Box; version: number; dataVersion: number | null; blockEntities: number; entities: number } {
  const s = (raw.Schematic ?? raw) as Nbt;
  const version = s.Version as number;
  check(version === 2 || version === 3, `Sponge 图纸 Version=${String(version)}，只支持 2 和 3；Version 1 请用新版 WorldEdit 重新导出`);
  const size = dims([s.Width, s.Height, s.Length].map((v) => {
    check(Number.isInteger(v), '图纸缺少 Width/Height/Length');
    return v & 0xffff; // 无符号 short
  }) as [number, number, number], '图纸');
  const b = (version === 3 ? s.Blocks : s) as Nbt | undefined;
  check(b, '图纸里没有方块数据（可能只有生物群系）');
  check(b.Palette && typeof b.Palette === 'object', '图纸没有调色板（用的是全局数字 ID），不支持；请用新版 WorldEdit 重新导出');
  const palette = new Map<number, string>();
  for (const [name, id] of Object.entries(b.Palette as Record<string, unknown>)) {
    check(Number.isInteger(id) && (id as number) >= 0, `调色板里 ${name} 的编号不对`);
    check(!palette.has(id as number), `调色板编号 ${String(id)} 重复了`);
    palette.set(id as number, name);
  }
  const ids = readVarints(version === 3 ? b.Data : b.BlockData, size[0] * size[1] * size[2]);
  return {
    box: { label: 'Schematic', min: [0, 0, 0], size, ids, palette },
    version,
    dataVersion: Number.isInteger(s.DataVersion) ? s.DataVersion : null,
    blockEntities: (b.BlockEntities as unknown[] | undefined)?.length ?? 0,
    entities: (s.Entities as unknown[] | undefined)?.length ?? 0
  };
}

function litematicaBoxes(raw: Nbt, regionNames?: string[]) {
  const version = raw.Version as number;
  check([5, 6, 7].includes(version), `Litematica 图纸 Version=${String(version)}，只支持 5、6、7`);
  const all = Object.keys(raw.Regions as Nbt);
  check(all.length, 'Litematica 图纸里没有区域');
  const names = regionNames?.length ? regionNames : [...all].sort((a, b) => a.localeCompare(b));
  const unknown = names.filter((n) => !all.includes(n));
  check(!unknown.length, `没有这些区域：${unknown.join('、')}（有：${all.join('、')}）`);
  const boxes: Box[] = [];
  let blockEntities = 0;
  let entities = 0;
  for (const name of names) {
    const r = (raw.Regions as Nbt)[name] as Nbt;
    const signed = int3([r.Size?.x, r.Size?.y, r.Size?.z], `区域 ${name} 的 Size`);
    const pos = int3([r.Position?.x, r.Position?.y, r.Position?.z], `区域 ${name} 的 Position`);
    const size = dims(signed.map(Math.abs) as [number, number, number], `区域 ${name}`);
    // Size 可以是负的：占用 position 到 position+size-sign(size)（两端都算）
    const min = pos.map((p, i) => p + Math.min(0, signed[i] - Math.sign(signed[i]))) as [number, number, number];
    check(Array.isArray(r.BlockStatePalette), `区域 ${name} 缺少调色板`);
    const palette = new Map<number, string>((r.BlockStatePalette as Nbt[]).map((e, i) => [i, stateOf(e)]));
    const ids = unpackLitematica(r.BlockStates, size[0] * size[1] * size[2], palette.size, name);
    boxes.push({ label: name, min, size, ids, palette });
    blockEntities += (r.TileEntities as unknown[] | undefined)?.length ?? 0;
    entities += (r.Entities as unknown[] | undefined)?.length ?? 0;
  }
  return { boxes, version, dataVersion: Number.isInteger(raw.MinecraftDataVersion) ? raw.MinecraftDataVersion as number : null, blockEntities, entities };
}

function structureBox(raw: Nbt, paletteIndex: number) {
  const size = dims(int3(raw.size, 'size'), '结构');
  check(!(raw.palette && raw.palettes), '结构文件同时有 palette 和 palettes，不知道该用哪个');
  let entries: Nbt[];
  let note: string | null = null;
  if (raw.palettes) {
    const list = raw.palettes as Nbt[][];
    check(Number.isInteger(paletteIndex) && paletteIndex >= 0 && paletteIndex < list.length, `paletteIndex 只能是 0~${list.length - 1}`);
    entries = list[paletteIndex];
    note = `这个结构有 ${list.length} 套配色，用的是第 ${paletteIndex} 套（paletteIndex 可以换）`;
  } else {
    check(Array.isArray(raw.palette), '结构文件缺少 palette');
    check(!paletteIndex, '这个结构只有一套配色，paletteIndex 只能是 0');
    entries = raw.palette as Nbt[];
  }
  const palette = entries.map(stateOf);
  check(Array.isArray(raw.blocks), '结构文件缺少 blocks');
  check((raw.blocks as unknown[]).length <= MAX_VOLUME, '结构文件的方块太多');
  const sparse: [number, number, number, string][] = [];
  let blockEntities = 0;
  const seen = new Set<string>();
  for (const b of raw.blocks as Nbt[]) {
    const pos = int3(b.pos, 'blocks 的 pos');
    check(pos.every((v, i) => v >= 0 && v < size[i]), `结构里有格子超出了范围：(${pos.join(',')})`);
    check(Number.isInteger(b.state) && typeof palette[b.state] === 'string', `结构里 (${pos.join(',')}) 的调色板编号不对：${String(b.state)}`);
    const key = pos.join(',');
    check(!seen.has(key), `结构里 (${key}) 写了两次`);
    seen.add(key);
    sparse.push([pos[0], pos[1], pos[2], palette[b.state]]);
    if (b.nbt) blockEntities++;
  }
  return {
    box: { label: '结构', min: [0, 0, 0] as [number, number, number], size, sparse },
    note,
    dataVersion: Number.isInteger(raw.DataVersion) ? raw.DataVersion as number : null,
    blockEntities,
    entities: (raw.entities as unknown[] | undefined)?.length ?? 0
  };
}

function detect(raw: Nbt): Exclude<SchematicFormat, 'auto'> | null {
  if (raw.Schematic && typeof raw.Schematic === 'object') return 'sponge';
  if (raw.Regions && typeof raw.Regions === 'object') return 'litematica';
  if (raw.Version !== undefined && (raw.Palette || raw.BlockData || raw.Width !== undefined)) return 'sponge';
  if (raw.blocks && raw.size) return 'structure';
  return null;
}

// 已经 simplify 过的 NBT → 合并好的格子
export function decodeSchematic(raw: Nbt, opts: DecodeOptions = {}): DecodedSchematic {
  check(raw && typeof raw === 'object', '文件的根不是 compound');
  const found = detect(raw);
  if (!found && raw.Blocks && raw.Materials) throw new Error('这是 MCEdit 的旧格式（1.13 以前的数字 ID），不支持；请在新版 WorldEdit 或 Litematica 里打开后重新导出成 .schem / .litematic');
  check(found, '认不出图纸格式（只支持 Sponge .schem v2/v3、Litematica .litematic、原版结构 .nbt）');
  const format = opts.format && opts.format !== 'auto' ? opts.format : found;
  check(format === found, `指定的是 ${format}，但文件看起来是 ${found}`);
  if (format !== 'litematica') check(!opts.regionNames?.length, 'regionNames 只对 Litematica 图纸有用');
  if (format !== 'structure') check(!opts.paletteIndex, 'paletteIndex 只对原版结构 .nbt 有用');

  let boxes: Box[];
  let label: string;
  let dataVersion: number | null;
  let blockEntities: number;
  let entities: number;
  let paletteNote: string | null = null;
  if (format === 'sponge') {
    const r = spongeBox(raw);
    boxes = [r.box];
    label = `Sponge v${r.version}`;
    ({ dataVersion, blockEntities, entities } = r);
  } else if (format === 'litematica') {
    const r = litematicaBoxes(raw, opts.regionNames);
    boxes = r.boxes;
    label = `Litematica v${r.version}`;
    ({ dataVersion, blockEntities, entities } = r);
  } else {
    const r = structureBox(raw, opts.paletteIndex ?? 0);
    boxes = [r.box];
    label = '原版结构';
    paletteNote = r.note;
    ({ dataVersion, blockEntities, entities } = r);
  }

  // 所有区域的整体范围；区域之间的空隙保留
  const min = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i])));
  const max = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.min[i] + b.size[i] - 1)));
  const size = max.map((v, i) => v - min[i] + 1) as [number, number, number];
  check(size[0] * size[1] * size[2] <= MAX_VOLUME * 4, `合起来的范围太大：${size.join('×')}`);

  const onConflict = opts.onConflict ?? 'error';
  const merged = new Map<string, { cell: [number, number, number, string]; from: string }>();
  let declared = 0;
  let air = 0;
  let overlaps = 0;
  const put = (box: Box, x: number, y: number, z: number, state: string) => {
    const bare = state.replace(/^minecraft:/, '');
    if (AIR.has(bare.split('[')[0])) {
      air++;
      return; // 空气当透明，不盖掉别的区域
    }
    const cell: [number, number, number, string] = [x - min[0], y - min[1], z - min[2], state];
    const key = `${cell[0]},${cell[1]},${cell[2]}`;
    const old = merged.get(key);
    if (old) {
      overlaps++;
      if (old.cell[3].replace(/^minecraft:/, '') === bare || onConflict === 'first') return;
      if (onConflict === 'error') throw new Error(`区域 ${old.from} 和 ${box.label} 在图纸坐标 (${key}) 分别是 ${old.cell[3]} 和 ${state}；请用 regionNames 选区域，或者 onConflict 指定 first / last`);
    }
    merged.set(key, { cell, from: box.label });
  };
  for (const box of boxes) {
    if (box.sparse) {
      declared += box.sparse.length;
      for (const [x, y, z, state] of box.sparse) put(box, x + box.min[0], y + box.min[1], z + box.min[2], state);
      continue;
    }
    const [sx, sy, sz] = box.size;
    const volume = sx * sy * sz;
    declared += volume;
    check(box.ids!.length === volume, `区域 ${box.label} 的格数和尺寸对不上`);
    for (let i = 0; i < volume; i++) {
      const state = box.palette!.get(box.ids![i]);
      check(typeof state === 'string', `区域 ${box.label} 用到了调色板里没有的编号 ${box.ids![i]}`);
      put(box, box.min[0] + (i % sx), box.min[1] + Math.floor(i / (sx * sz)), box.min[2] + (Math.floor(i / sx) % sz), state);
    }
  }
  check(declared <= MAX_VOLUME, `区域加起来太大：${declared} 格`);
  return {
    format: label,
    dataVersion,
    size,
    cells: [...merged.values()].map((m) => m.cell),
    regions: boxes.map((b) => b.label),
    paletteNote,
    declared,
    air,
    overlaps,
    blockEntities,
    entities
  };
}

// 读文件：自动认 gzip，只接受 Java 版的大端 NBT
export async function readSchematicNbt(file: string): Promise<Nbt> {
  const stat = fs.statSync(file);
  check(stat.size <= MAX_FILE_BYTES, `文件太大：${Math.round(stat.size / 1024 / 1024)} MB`);
  const data = fs.readFileSync(file);
  const bytes = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data, { maxOutputLength: MAX_FILE_BYTES }) : data;
  let parsed: nbt.NBT;
  let size: number;
  try {
    const r = await nbt.parse(bytes, 'big');
    parsed = r.parsed;
    size = r.metadata.size;
  } catch (err) {
    throw new Error(`读不了这个文件（不是 Java 版的 NBT，或者文件坏了）：${(err as Error).message}`);
  }
  check(size === bytes.length, 'NBT 后面还有多余的数据，文件可能坏了');
  check(parsed.type === 'compound', '文件的根不是 compound');
  return nbt.simplify(parsed) as Nbt;
}

// ---- 路径 ----

export function schematicDir(): string {
  return path.join(ysmDataDir(), 'schematics');
}

// 只允许 schematics/ 里面的文件
export function resolveSchematicFile(name: string): string {
  const root = schematicDir();
  check(name && !path.isAbsolute(name) && !/^[\\/]/.test(name), '只写 schematics 文件夹里的文件名，比如 house.schem');
  check(!name.split(/[\\/]/).includes('..'), '文件名里不能有 ..');
  check(EXTENSIONS.includes(path.extname(name).toLowerCase()), `只支持 ${EXTENSIONS.join('、')} 文件`);
  const file = path.resolve(root, name);
  if (!fs.existsSync(file)) throw new Error(`schematics 文件夹里没有 ${name}（不写 file 可以列出有哪些）`);
  const real = fs.realpathSync(file);
  const realRoot = fs.realpathSync(root);
  check(real.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep), '文件不在 schematics 文件夹里');
  return real;
}

export function listSchematicFiles(): { name: string; bytes: number }[] {
  const root = schematicDir();
  const out: { name: string; bytes: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && EXTENSIONS.includes(path.extname(e.name).toLowerCase())) {
        out.push({ name: path.relative(root, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- 转成蓝图 ----

interface RegistryLike {
  blocksByName: Record<string, any>;
  itemsByName: Record<string, unknown>;
}

// 旧版本改过名的方块（1.13 以后）
const RENAMED: Record<string, string> = { grass: 'short_grass', grass_path: 'dirt_path', sign: 'oak_sign', wall_sign: 'oak_wall_sign' };

// 只能放在水里的植物：水导入不了，它们也放不下去
const WATER_ONLY = new Set(['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

// 双层半砖放不了，换成同材质的完整方块
function fullBlockOf(slab: string, reg: RegistryLike): string | null {
  const base = slab.replace(/_slab$/, '');
  const special: Record<string, string> = { petrified_oak: 'oak_planks', smooth_quartz: 'smooth_quartz', quartz: 'quartz_block' };
  const candidates = [special[base], `${base}_planks`, `${base}s`, `${base}_block`, base];
  return candidates.find((c) => c && reg.blocksByName[c]) ?? null;
}

export interface ConvertOptions {
  exclude?: string[];
  strict?: boolean;
  // 图纸比 1.21.1 新
  newerSource?: boolean;
}

export interface ConvertResult {
  blocks: [number, number, number, string][];
  skipped: Map<string, number>; // 原因 → 格数
  examples: Map<string, string[]>; // 原因 → 几个原状态
  replaced: Map<string, number>; // "a → b" → 格数
  companions: number;
  excluded: number;
}

export function convertCells(dec: DecodedSchematic, reg: RegistryLike, opts: ConvertOptions): ConvertResult {
  const exclude = new Set((opts.exclude ?? []).map((n) => n.toLowerCase().replace(/^minecraft:/, '')));
  const skipped = new Map<string, number>();
  const examples = new Map<string, string[]>();
  const replaced = new Map<string, number>();
  let companions = 0;
  let excluded = 0;
  // 同一个状态只算一次
  const cache = new Map<string, { kind: 'keep'; text: string; from?: string } | { kind: 'skip'; reason: string } | { kind: 'companion' } | { kind: 'exclude' }>();
  const judge = (state: string) => {
    const ns = /^([a-z0-9_.-]+):/.exec(state);
    if (ns && ns[1] !== 'minecraft') return { kind: 'skip' as const, reason: '模组方块' };
    let spec: BlockSpec;
    try {
      spec = parseBlockSpec(state.replace(/^minecraft:/, ''));
    } catch {
      return { kind: 'skip' as const, reason: '状态写法认不出' };
    }
    if (spec.name === 'structure_void') return { kind: 'skip' as const, reason: 'structure_void（结构的留空占位）' };
    let from: string | undefined;
    if (RENAMED[spec.name] && !reg.blocksByName[spec.name]) {
      from = spec.name;
      spec = { name: RENAMED[spec.name], props: spec.props };
    }
    if (spec.name === 'cauldron' && spec.props.level !== undefined) {
      if (spec.props.level !== '0') return { kind: 'skip' as const, reason: '装了水的炼药锅（没有对应物品）' };
      delete spec.props.level;
    }
    if (isCompanionCell(spec)) return { kind: 'companion' as const };
    if (/_slab$/.test(spec.name) && spec.props.type === 'double') {
      const full = fullBlockOf(spec.name, reg);
      if (!full) return { kind: 'skip' as const, reason: '双层半砖（找不到同材质的完整方块）' };
      from = spec.name + '[type=double]';
      spec = { name: full, props: {} };
    }
    if (exclude.has(spec.name)) return { kind: 'exclude' as const };
    if (WATER_ONLY.has(spec.name)) return { kind: 'skip' as const, reason: '只能长在水里（水本身导入不了）' };
    const kept: BlockSpec = { name: spec.name, props: {} };
    for (const [k, v] of Object.entries(spec.props)) if (!AUTO_PROPS.has(k)) kept.props[k] = v;
    const problem = validateSpec(kept, reg as never);
    if (problem) {
      if (!reg.blocksByName[kept.name]) {
        return { kind: 'skip' as const, reason: opts.newerSource ? '1.21.1 里没有的方块（可能是新版本才有的）' : '1.21.1 里没有的方块' };
      }
      if (/没有对应的物品/.test(problem)) return { kind: 'skip' as const, reason: '没有对应物品、放不了（水、岩浆、盆栽、作物等）' };
      return { kind: 'skip' as const, reason: `属性不对：${problem}` };
    }
    return { kind: 'keep' as const, text: formatBlockSpec(kept), from };
  };
  const blocks: [number, number, number, string][] = [];
  for (const [x, y, z, state] of dec.cells) {
    let v = cache.get(state);
    if (!v) {
      v = judge(state);
      cache.set(state, v);
    }
    if (v.kind === 'companion') companions++;
    else if (v.kind === 'exclude') excluded++;
    else if (v.kind === 'skip') {
      skipped.set(v.reason, (skipped.get(v.reason) ?? 0) + 1);
      const ex = examples.get(v.reason) ?? [];
      const bare = state.replace(/^minecraft:/, '').split('[')[0];
      if (ex.length < 4 && !ex.includes(bare)) ex.push(bare);
      examples.set(v.reason, ex);
    } else {
      blocks.push([x, y, z, v.text]);
      if (v.from) {
        const k = `${v.from} → ${v.text}`;
        replaced.set(k, (replaced.get(k) ?? 0) + 1);
      }
    }
  }
  if (opts.strict && skipped.size) {
    throw new Error(`strict 模式下有跳过的格子：${[...skipped.entries()].map(([r, n]) => `${r} ${n} 格`).join('；')}`);
  }
  blocks.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  return { blocks, skipped, examples, replaced, companions, excluded };
}

// 版本号：图纸里的和调用时补的要一致；1.13 以前的不支持
export function checkDataVersion(fromFile: number | null, given: number | undefined): number {
  if (fromFile !== null && given !== undefined && fromFile !== given) {
    throw new Error(`文件里的 DataVersion 是 ${fromFile}，和给的 sourceDataVersion ${given} 不一样`);
  }
  const dv = fromFile ?? given;
  if (dv === undefined) throw new Error('文件里没有 DataVersion，不知道是哪个版本的；请用 sourceDataVersion 补上（1.21.1 是 3955）');
  if (dv < FLATTENING) throw new Error(`这个文件的 DataVersion 是 ${dv}（1.13 以前），用的是旧的数字 ID，不支持；请先在新版里打开再重新导出`);
  return dv;
}

export function makeImportedBlueprint(name: string, description: string, dec: DecodedSchematic, blocks: [number, number, number, string][], source: string): Blueprint {
  return {
    version: 1,
    name,
    description,
    size: { x: dec.size[0], y: dec.size[1], z: dec.size[2] },
    blocks,
    createdAt: new Date().toISOString(),
    source
  };
}
