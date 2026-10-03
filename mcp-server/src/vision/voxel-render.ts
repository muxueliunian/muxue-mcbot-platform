// 把一组方块（蓝图或者从世界里框下来的一块）画成图：两个斜 45° 的立体图 + 每层的俯视平面图（切掉上面的部分）。
// 方块模型和贴图用 prismarine-viewer 自带的 1.21.1 数据（blocksStates/1.21.1.json + textures/1.21.1.png 贴图集），
// 正交投影 + 深度缓冲；贴图透明的地方（玻璃中间、树叶缝）镂空，半透明的（染色玻璃、冰）最后按远近混合
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import type { BlockSpec } from '../block-state.js';

const require = createRequire(import.meta.url);
const VERSION = '1.21.1';

type V3 = [number, number, number];
interface TexRef { u: number; v: number; su: number; sv: number }
interface Face { uv?: [number, number, number, number]; texture: TexRef; cullface?: string; tintindex?: number }
interface Element { from: V3; to: V3; faces: Partial<Record<string, Face>> }
interface Model { elements: Element[] }
interface Variant { model: Model; x?: number; y?: number }
interface BlockStateDef {
  variants?: Record<string, Variant | Variant[]>;
  multipart?: { when?: Record<string, unknown>; apply: Variant | Variant[] }[];
}

export interface Voxel {
  pos: Vec3; // 整数坐标
  spec: BlockSpec;
}

let assets: { states: Record<string, BlockStateDef>; atlas: PNG } | null = null;

function loadAssets() {
  if (assets) return assets;
  const root = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public');
  const states = JSON.parse(fs.readFileSync(path.join(root, 'blocksStates', `${VERSION}.json`), 'utf8'));
  const atlas = PNG.sync.read(fs.readFileSync(path.join(root, 'textures', `${VERSION}.png`)));
  assets = { states, atlas };
  return assets;
}

// ---- 方块状态 → 模型 ----

let defaultProps: ((name: string) => Record<string, string>) | null = null;

function defaults(name: string): Record<string, string> {
  if (!defaultProps) {
    const mcData = minecraftData(VERSION);
    const Block = require('prismarine-block')(VERSION);
    const cache = new Map<string, Record<string, string>>();
    defaultProps = (n: string) => {
      if (cache.has(n)) return cache.get(n)!;
      const b = mcData.blocksByName[n];
      const props: Record<string, string> = {};
      if (b) {
        const raw = Block.fromStateId(b.defaultState, 0).getProperties() as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) props[k] = String(v);
      }
      cache.set(n, props);
      return props;
    };
  }
  return defaultProps(name);
}

function whenMatches(when: Record<string, unknown> | undefined, props: Record<string, string>): boolean {
  if (!when) return true;
  if (Array.isArray((when as { OR?: unknown }).OR)) return ((when as { OR: Record<string, unknown>[] }).OR).some((w) => whenMatches(w, props));
  if (Array.isArray((when as { AND?: unknown }).AND)) return ((when as { AND: Record<string, unknown>[] }).AND).every((w) => whenMatches(w, props));
  return Object.entries(when).every(([k, v]) => String(v).split('|').includes(props[k] ?? ''));
}

function pick(v: Variant | Variant[]): Variant {
  return Array.isArray(v) ? v[0] : v;
}

function variantsFor(name: string, props: Record<string, string>): Variant[] {
  const def = loadAssets().states[name];
  if (!def) return [];
  if (def.variants) {
    for (const [key, v] of Object.entries(def.variants)) {
      if (key === '' || key.split(',').every((kv) => {
        const [k, val] = kv.split('=');
        return props[k] === val;
      })) return [pick(v)];
    }
    return [pick(Object.values(def.variants)[0])];
  }
  return (def.multipart ?? []).filter((p) => whenMatches(p.when, props)).map((p) => pick(p.apply));
}

const FULL_OPAQUE_EXCLUDE = /(glass|leaves|ice$|slime|honey_block|spawner|barrier|_stairs|_slab|_pane|iron_bars|fence|_wall$|door|trapdoor|carpet|lantern|torch|bed$|flower|sapling|grass$|fern|vine|rail|button|lever|plate|sign|banner|chain|campfire|candle|pot$|head$|skull$|bars$|scaffolding|snow$|path|farmland|cake|ladder|lectern|table$|stonecutter|grindstone|bell|anvil|hopper|cauldron|composter|brewing|enchanting|end_rod|lightning_rod|amethyst_cluster|_bud$|coral|kelp|seagrass|water|lava|air)/;

function isFullOpaque(v: Voxel | undefined): boolean {
  return Boolean(v && !FULL_OPAQUE_EXCLUDE.test(v.spec.name));
}

// ---- 几何 ----

const DIR_VEC: Record<string, V3> = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };

// 方块状态里的 x、y 旋转（绕方块中心），先 x 后 y
function rotatePoint(p: V3, rx: number, ry: number): V3 {
  let [x, y, z] = [p[0] - 8, p[1] - 8, p[2] - 8];
  for (let i = 0; i < ((rx / 90) % 4 + 4) % 4; i++) [y, z] = [z, -y];
  for (let i = 0; i < ((ry / 90) % 4 + 4) % 4; i++) [x, z] = [-z, x];
  return [x + 8, y + 8, z + 8];
}

function rotateDir(d: V3, rx: number, ry: number): V3 {
  let [x, y, z] = d;
  for (let i = 0; i < ((rx / 90) % 4 + 4) % 4; i++) [y, z] = [z, -y];
  for (let i = 0; i < ((ry / 90) % 4 + 4) % 4; i++) [x, z] = [-z, x];
  return [x, y, z];
}

function dirName(d: V3): string {
  for (const [n, v] of Object.entries(DIR_VEC)) if (v[0] === Math.round(d[0]) && v[1] === Math.round(d[1]) && v[2] === Math.round(d[2])) return n;
  return 'up';
}

// 面上参数 (a,b)：a 沿贴图横向、b 沿贴图纵向（从外面看这个面）
function faceCorners(dir: string, f: V3, t: V3): [V3, V3, V3] {
  // 返回 (a=0,b=0)、(a=1,b=0)、(a=0,b=1) 三个角
  switch (dir) {
    case 'north': return [[t[0], t[1], f[2]], [f[0], t[1], f[2]], [t[0], f[1], f[2]]];
    case 'south': return [[f[0], t[1], t[2]], [t[0], t[1], t[2]], [f[0], f[1], t[2]]];
    case 'east': return [[t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], t[2]]];
    case 'west': return [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [f[0], f[1], f[2]]];
    case 'up': return [[f[0], t[1], f[2]], [t[0], t[1], f[2]], [f[0], t[1], t[2]]];
    default: return [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [f[0], f[1], f[2]]];
  }
}

function defaultUv(dir: string, f: V3, t: V3): [number, number, number, number] {
  switch (dir) {
    case 'north': return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 'south': return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 'east': return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
    case 'west': return [f[2], 16 - t[1], t[2], 16 - f[1]];
    case 'up': return [f[0], f[2], t[0], t[2]];
    default: return [f[0], 16 - t[2], t[0], 16 - f[2]];
  }
}

const SHADE: Record<string, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, east: 0.62, west: 0.62 };

function tintFor(name: string): [number, number, number] {
  if (/birch_leaves/.test(name)) return [128, 167, 85];
  if (/spruce_leaves/.test(name)) return [97, 153, 97];
  if (/leaves|vine/.test(name)) return [119, 171, 47];
  if (/lily_pad/.test(name)) return [32, 128, 48];
  if (/water/.test(name)) return [63, 118, 228];
  return [145, 189, 89]; // 草
}

interface RFace {
  p0: V3; e1: V3; e2: V3; // 世界坐标：角、a 方向、b 方向
  normal: V3;
  tex: TexRef;
  uv: [number, number, number, number];
  shade: number;
  tint: [number, number, number] | null;
  edge: boolean; // 画淡淡的描边（大面才画）
}

// 门、床、高草的另一半没写时补上，让图和实际一样
function withCompanions(voxels: Voxel[]): Voxel[] {
  const map = new Map(voxels.map((v) => [`${v.pos.x},${v.pos.y},${v.pos.z}`, v]));
  const out = [...voxels];
  for (const v of voxels) {
    const { name, props } = v.spec;
    let other: Vec3 | null = null;
    let otherProps: Record<string, string> | null = null;
    if (/_door$/.test(name) && props.half !== 'upper') {
      other = v.pos.offset(0, 1, 0);
      otherProps = { ...props, half: 'upper' };
    } else if (/_bed$/.test(name) && props.part !== 'head' && props.facing) {
      const d = DIR_VEC[props.facing];
      other = v.pos.offset(d[0], 0, d[2]);
      otherProps = { ...props, part: 'head' };
    }
    if (other && !map.has(`${other.x},${other.y},${other.z}`)) out.push({ pos: other, spec: { name, props: otherProps! } });
  }
  return out;
}

const CONNECT_ALL = /(glass_pane|iron_bars)$|_pane$/;
const FENCE = /_fence$/;
const WALL = /_wall$/;

function connects(self: string, other: Voxel | undefined): boolean {
  if (!other) return false;
  const n = other.spec.name;
  if (CONNECT_ALL.test(self)) return CONNECT_ALL.test(n) || isFullOpaque(other) || /glass$/.test(n);
  if (FENCE.test(self)) return FENCE.test(n) || /_fence_gate$/.test(n) || isFullOpaque(other);
  if (WALL.test(self)) return WALL.test(n) || isFullOpaque(other) || /_fence_gate$/.test(n) || CONNECT_ALL.test(n);
  return false;
}

function buildFaces(voxels: Voxel[], cutY: number | null): RFace[] {
  const all = withCompanions(voxels);
  const map = new Map(all.map((v) => [`${v.pos.x},${v.pos.y},${v.pos.z}`, v]));
  const at = (x: number, y: number, z: number) => map.get(`${x},${y},${z}`);
  const faces: RFace[] = [];
  for (const v of all) {
    if (cutY !== null && v.pos.y > cutY) continue;
    const name = v.spec.name;
    const props = { ...defaults(name), ...v.spec.props };
    if (CONNECT_ALL.test(name) || FENCE.test(name) || WALL.test(name)) {
      for (const [side, d] of Object.entries({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] })) {
        const c = connects(name, at(v.pos.x + d[0], v.pos.y, v.pos.z + d[1]));
        props[side] = WALL.test(name) ? (c ? 'low' : 'none') : String(c);
      }
      if (WALL.test(name)) props.up = 'true';
    }
    if (/_stairs$/.test(name)) props.shape = 'straight';
    const variants = variantsFor(name, props);
    if (!variants.length) continue;
    const tinted = /leaves|grass|fern|vine|lily_pad|sugar_cane|water/.test(name);
    for (const variant of variants) {
      const rx = variant.x ?? 0, ry = variant.y ?? 0;
      for (const el of variant.model?.elements ?? []) {
        const big = (el.to[0] - el.from[0]) * (el.to[1] - el.from[1]) + (el.to[1] - el.from[1]) * (el.to[2] - el.from[2]) >= 128;
        for (const [dir, face] of Object.entries(el.faces)) {
          if (!face?.texture) continue;
          const nrm = rotateDir(DIR_VEC[dir], rx, ry);
          if (face.cullface) {
            const cd = rotateDir(DIR_VEC[face.cullface] ?? DIR_VEC[dir], rx, ry);
            const nb = at(v.pos.x + cd[0], v.pos.y + cd[1], v.pos.z + cd[2]);
            if (isFullOpaque(nb) && (cutY === null || nb!.pos.y <= cutY)) continue;
          }
          const [c0, c1, c2] = faceCorners(dir, el.from, el.to).map((p) => rotatePoint(p, rx, ry));
          const w = (p: V3): V3 => [v.pos.x + p[0] / 16, v.pos.y + p[1] / 16, v.pos.z + p[2] / 16];
          const p0 = w(c0), p1 = w(c1), p2 = w(c2);
          faces.push({
            p0,
            e1: [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]],
            e2: [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]],
            normal: nrm,
            tex: face.texture,
            uv: face.uv ?? defaultUv(dir, el.from, el.to),
            shade: SHADE[dirName(nrm)] ?? 0.8,
            tint: face.tintindex !== undefined && tinted ? tintFor(name) : null,
            edge: big
          });
        }
      }
    }
  }
  return faces;
}

// ---- 光栅化 ----

interface Camera {
  toCam: V3; // 指向相机的单位向量
  right: V3;
  up: V3;
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function isoCamera(fromX: number, fromZ: number, height = 0.82): Camera {
  const toCam = norm([fromX, height * Math.SQRT2, fromZ]);
  const fwd: V3 = [-toCam[0], -toCam[1], -toCam[2]];
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  return { toCam, right, up };
}

export function topCamera(): Camera {
  return { toCam: [0, 1, 0], right: [1, 0, 0], up: [0, 0, -1] };
}

function sampleAtlas(atlas: PNG, tex: TexRef, uv: [number, number, number, number], a: number, b: number): [number, number, number, number] {
  const uu = (uv[0] + (uv[2] - uv[0]) * a) / 16;
  const vv = (uv[1] + (uv[3] - uv[1]) * b) / 16;
  let px = Math.floor((tex.u + tex.su * Math.min(0.999, Math.max(0, uu))) * atlas.width);
  let py = Math.floor((tex.v + tex.sv * Math.min(0.999, Math.max(0, vv))) * atlas.height);
  px = Math.min(atlas.width - 1, Math.max(0, px));
  py = Math.min(atlas.height - 1, Math.max(0, py));
  const i = (py * atlas.width + px) * 4;
  return [atlas.data[i], atlas.data[i + 1], atlas.data[i + 2], atlas.data[i + 3]];
}

export interface Panel {
  png: PNG;
}

// 把一组面画到一张图上：自动缩放到 maxW×maxH 以内
// darkAbove：平面图里被切开的墙顶（朝上、高度不低于这个值的面）压暗，墙和地板、家具才分得清
function renderPanel(faces: RFace[], cam: Camera, maxW: number, maxH: number, bg: [number, number, number], darkAbove: number | null = null): PNG {
  const { atlas } = loadAssets();
  const vis = faces.filter((f) => dot(f.normal, cam.toCam) > 1e-6);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const proj = (p: V3) => [dot(p, cam.right), -dot(p, cam.up)] as const;
  for (const f of vis) {
    for (const p of [f.p0, [f.p0[0] + f.e1[0], f.p0[1] + f.e1[1], f.p0[2] + f.e1[2]] as V3, [f.p0[0] + f.e2[0], f.p0[1] + f.e2[1], f.p0[2] + f.e2[2]] as V3,
      [f.p0[0] + f.e1[0] + f.e2[0], f.p0[1] + f.e1[1] + f.e2[1], f.p0[2] + f.e1[2] + f.e2[2]] as V3]) {
      const [x, y] = proj(p);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (!vis.length) {
    const empty = new PNG({ width: 16, height: 16 });
    return empty;
  }
  const pad = 12;
  const scale = Math.max(2, Math.min((maxW - pad * 2) / (maxX - minX || 1), (maxH - pad * 2) / (maxY - minY || 1), 40));
  const W = Math.ceil((maxX - minX) * scale) + pad * 2;
  const H = Math.ceil((maxY - minY) * scale) + pad * 2;
  const png = new PNG({ width: W, height: H });
  const depth = new Float32Array(W * H).fill(-Infinity);
  for (let i = 0; i < W * H; i++) {
    png.data[i * 4] = bg[0]; png.data[i * 4 + 1] = bg[1]; png.data[i * 4 + 2] = bg[2]; png.data[i * 4 + 3] = 255;
  }
  const toScreen = (p: V3) => [(dot(p, cam.right) - minX) * scale + pad, (-dot(p, cam.up) - minY) * scale + pad] as [number, number];
  const translucent: { f: RFace; near: number }[] = [];

  const draw = (f: RFace, blend: boolean) => {
    const s0 = toScreen(f.p0);
    const s1 = toScreen([f.p0[0] + f.e1[0], f.p0[1] + f.e1[1], f.p0[2] + f.e1[2]]);
    const s2 = toScreen([f.p0[0] + f.e2[0], f.p0[1] + f.e2[1], f.p0[2] + f.e2[2]]);
    const ax = s1[0] - s0[0], ay = s1[1] - s0[1], bx = s2[0] - s0[0], by = s2[1] - s0[1];
    const det = ax * by - ay * bx;
    if (Math.abs(det) < 1e-9) return;
    const xs = [s0[0], s1[0], s2[0], s1[0] + bx], ys = [s0[1], s1[1], s2[1], s1[1] + by];
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    const n0 = dot(f.p0, cam.toCam), n1 = dot(f.e1, cam.toCam), n2 = dot(f.e2, cam.toCam);
    const lenA = Math.hypot(ax, ay), lenB = Math.hypot(bx, by);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5 - s0[0], qy = y + 0.5 - s0[1];
        const a = (qx * by - qy * bx) / det;
        const b = (ax * qy - ay * qx) / det;
        if (a < -1e-4 || a > 1 + 1e-4 || b < -1e-4 || b > 1 + 1e-4) continue;
        const near = n0 + n1 * a + n2 * b + 1e-4;
        const i = y * W + x;
        if (near <= depth[i]) continue;
        let [r, g, bl, al] = sampleAtlas(atlas, f.tex, f.uv, a, b);
        if (al < 16) continue;
        if (!blend && al < 230) {
          continue; // 半透明的留到后面画
        }
        if (f.tint) {
          r = (r * f.tint[0]) / 255; g = (g * f.tint[1]) / 255; bl = (bl * f.tint[2]) / 255;
        }
        let sh = f.shade;
        if (darkAbove !== null && f.normal[1] > 0.5 && f.p0[1] >= darkAbove - 1e-6) sh *= 0.42;
        if (f.edge && (a * lenA < 0.9 || (1 - a) * lenA < 0.9 || b * lenB < 0.9 || (1 - b) * lenB < 0.9)) sh *= 0.86;
        const o = i * 4;
        if (blend) {
          const t = al / 255;
          png.data[o] = Math.round(png.data[o] * (1 - t) + r * sh * t);
          png.data[o + 1] = Math.round(png.data[o + 1] * (1 - t) + g * sh * t);
          png.data[o + 2] = Math.round(png.data[o + 2] * (1 - t) + bl * sh * t);
        } else {
          png.data[o] = Math.round(r * sh);
          png.data[o + 1] = Math.round(g * sh);
          png.data[o + 2] = Math.round(bl * sh);
          depth[i] = near;
        }
      }
    }
  };

  for (const f of vis) {
    draw(f, false);
    // 半透明的像素（染色玻璃、冰等）第一遍跳过，最后按远近混合再画
    translucent.push({ f, near: dot(f.p0, cam.toCam) });
  }
  translucent.sort((x, y) => x.near - y.near);
  for (const { f } of translucent) draw(f, true);
  return png;
}

// ---- 拼图 ----

function blit(dst: PNG, src: PNG, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4, d = (dy * dst.width + dx) * 4;
      dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1]; dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = 255;
    }
  }
}

// 找楼层：某一层大部分都是实心方块、上面至少空出两格 → 当成一层楼的地板
export function detectFloors(voxels: Voxel[]): number[] {
  if (!voxels.length) return [];
  const xs = voxels.map((v) => v.pos.x), zs = voxels.map((v) => v.pos.z), ys = voxels.map((v) => v.pos.y);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const set = new Map(voxels.map((v) => [`${v.pos.x},${v.pos.y},${v.pos.z}`, v]));
  const floors: number[] = [];
  const cols: [number, number][] = [];
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) cols.push([x, z]);
  for (let y = minY; y <= maxY - 2; y++) {
    let solid = 0, openAbove = 0;
    for (const [x, z] of cols) {
      const v = set.get(`${x},${y},${z}`);
      if (!v || !isFullOpaque(v)) continue;
      solid += 1;
      const a1 = set.get(`${x},${y + 1},${z}`), a2 = set.get(`${x},${y + 2},${z}`);
      if (!isFullOpaque(a1) && !isFullOpaque(a2)) openAbove += 1;
    }
    if (solid >= cols.length * 0.3 && openAbove >= solid * 0.4) floors.push(y);
  }
  return floors.slice(0, 4);
}

export interface RenderResult {
  png: Buffer;
  caption: string;
}

// 画成一张拼图：上面两张斜 45° 立体图（左：从西南看，正面是南；右：从东北看），下面是每层的平面图（北在上）
export function renderVoxels(voxels: Voxel[], options: { plans?: boolean; front?: 'south' | 'north' | 'east' | 'west' } = {}): RenderResult {
  const bg: [number, number, number] = [232, 238, 244];
  const faces = buildFaces(voxels, null);
  const front = options.front ?? 'south';
  const views: Record<string, [number, number]> = { south: [-1, 1], west: [-1, -1], north: [1, -1], east: [1, 1] };
  const [fx, fz] = views[front];
  const iso1 = renderPanel(faces, isoCamera(fx, fz), 820, 700, bg);
  const iso2 = renderPanel(faces, isoCamera(-fx, -fz), 820, 700, bg);
  const plans: { y: number; png: PNG }[] = [];
  if (options.plans !== false) {
    for (const y of detectFloors(voxels)) {
      // 切在地板上两格：墙还在（顶面压暗），一格高的家具露出来
      plans.push({ y, png: renderPanel(buildFaces(voxels, y + 2), topCamera(), 520, 520, bg, y + 3) });
    }
  }
  const gap = 8;
  const row1W = iso1.width + gap + iso2.width;
  const row1H = Math.max(iso1.height, iso2.height);
  const row2W = plans.reduce((s, p) => s + p.png.width + gap, 0) - (plans.length ? gap : 0);
  const row2H = plans.length ? Math.max(...plans.map((p) => p.png.height)) : 0;
  const W = Math.max(row1W, row2W);
  const H = row1H + (plans.length ? gap + row2H : 0);
  const out = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    out.data[i * 4] = 255; out.data[i * 4 + 1] = 255; out.data[i * 4 + 2] = 255; out.data[i * 4 + 3] = 255;
  }
  blit(out, iso1, 0, 0);
  blit(out, iso2, iso1.width + gap, 0);
  let x = 0;
  for (const p of plans) {
    blit(out, p.png, x, row1H + gap);
    x += p.png.width + gap;
  }
  const opposite: Record<string, string> = { south: '东北', west: '东南', north: '西南', east: '西北' };
  const near: Record<string, string> = { south: '西南', west: '西北', north: '东北', east: '东南' };
  const caption = [
    `上排左：从${near[front]}斜上方看（正面朝${({ south: '南', north: '北', east: '东', west: '西' } as Record<string, string>)[front]}）；上排右：从${opposite[front]}看背面`,
    plans.length ? `下排：${plans.map((p, i) => `第 ${i + 1} 层平面图（地板 y=${p.y}，切掉 y>${p.y + 2} 的部分，深灰是墙，北在上）`).join('；')}` : '没有找到明显的楼层，没画平面图'
  ].join('\n');
  return { png: PNG.sync.write(out), caption };
}
