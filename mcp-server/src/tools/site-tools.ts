// 选址：survey-site 看一块地的高低、树、水、已有的建筑和保护区域；find-site 在附近找一块够大、够平、没东西挡着的空地
import { z } from "zod";
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { regionStore } from '../action-policy.js';
import { PROTECTED, BUILDING } from '../protected-blocks.js';
import { vec3Schema, fmt, EMPTY_BLOCKS, LIQUIDS, SOFT } from './block-ops.js';
import { loadBlueprint, blueprintFootprint } from '../blueprints.js';

const TREE = /(_log|_wood|_leaves|_stem|_hyphae|_wart_block|shroomlight|mangrove_roots|bee_nest|cocoa|vine)$/;
const PLANT = /(bush|_sapling|_mushroom|sugar_cane|cactus|bamboo|pumpkin|melon|pointed_dripstone|big_dripleaf|small_dripleaf|azalea|moss_carpet|snow)$/;
const MAX_SURVEY = 64 * 64;

type Kind = 'ground' | 'tree' | 'water' | 'lava' | 'built' | 'plant' | 'unloaded';

interface Column {
  x: number;
  z: number;
  ground: number | null; // 最上面一格自然地面方块的 y
  groundName: string;
  above: Kind | null; // 地面以上最显眼的东西
  aboveName: string;
  aboveTop: number;
}

function classifyBlock(name: string): Kind | 'empty' | 'soft' {
  if (EMPTY_BLOCKS.has(name)) return 'empty';
  if (name === 'water' || name === 'bubble_column' || name === 'seagrass' || name === 'tall_seagrass' || name === 'kelp' || name === 'kelp_plant') return 'water';
  if (name === 'lava') return 'lava';
  if (TREE.test(name)) return 'tree';
  if (SOFT.test(name)) return 'soft';
  if (PLANT.test(name)) return 'plant';
  if (PROTECTED.test(name) || BUILDING.test(name)) return 'built';
  return 'ground';
}

// 从 topY 往下找每一列的地面，记下地面以上最显眼的东西（树、水、建筑）
function scanColumn(bot: Bot, x: number, z: number, topY: number, depth = 48): Column {
  const col: Column = { x, z, ground: null, groundName: '', above: null, aboveName: '', aboveTop: -Infinity };
  const rank: Record<string, number> = { plant: 1, tree: 2, water: 3, built: 4, lava: 5 };
  for (let y = topY; y > topY - depth; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) {
      col.above = 'unloaded';
      return col;
    }
    const k = classifyBlock(b.name);
    if (k === 'empty' || k === 'soft') continue;
    if (k === 'ground') {
      col.ground = y;
      col.groundName = b.name;
      return col;
    }
    if (k === 'water' || k === 'lava') {
      // 水面下面的地不算能盖的地面，水本身就是障碍
      if (!col.above || rank[k] > rank[col.above]) {
        col.above = k;
        col.aboveName = b.name;
      }
      col.aboveTop = Math.max(col.aboveTop, y);
      continue;
    }
    if (!col.above || (rank[k] ?? 0) > (rank[col.above] ?? 0)) {
      col.above = k;
      col.aboveName = b.name;
    }
    col.aboveTop = Math.max(col.aboveTop, y);
  }
  return col;
}

function scanArea(bot: Bot, x1: number, z1: number, x2: number, z2: number, topY: number): Column[][] {
  const rows: Column[][] = [];
  for (let z = z1; z <= z2; z++) {
    const row: Column[] = [];
    for (let x = x1; x <= x2; x++) row.push(scanColumn(bot, x, z, topY));
    rows.push(row);
  }
  return rows;
}

function mode(values: number[]): number {
  const count = new Map<number, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

interface SiteStats {
  columns: number;
  unloaded: number;
  minY: number;
  maxY: number;
  floor: number; // 建议的一楼地板 y（最常见地面 + 1）
  cut: number; // 高出最常见地面、要挖的列数
  fill: number; // 低于最常见地面、要垫的列数
  maxDiff: number;
  counts: Record<string, number>;
  samples: Record<string, Vec3[]>;
}

function stats(rows: Column[][]): SiteStats {
  const cols = rows.flat();
  const grounds = cols.filter((c) => c.ground !== null && c.above !== 'water' && c.above !== 'lava').map((c) => c.ground!);
  const base = grounds.length ? mode(grounds) : 0;
  const s: SiteStats = {
    columns: cols.length, unloaded: 0, minY: grounds.length ? Math.min(...grounds) : 0, maxY: grounds.length ? Math.max(...grounds) : 0,
    floor: base + 1, cut: 0, fill: 0, maxDiff: 0, counts: {}, samples: {}
  };
  for (const c of cols) {
    if (c.above === 'unloaded') {
      s.unloaded += 1;
      continue;
    }
    if (c.ground !== null && c.above !== 'water' && c.above !== 'lava') {
      if (c.ground > base) s.cut += 1;
      if (c.ground < base) s.fill += 1;
      s.maxDiff = Math.max(s.maxDiff, Math.abs(c.ground - base));
    }
    if (c.above && c.above !== 'plant') {
      const key = c.above;
      s.counts[key] = (s.counts[key] ?? 0) + 1;
      (s.samples[key] ??= []).length < 3 && s.samples[key].push(new Vec3(c.x, c.aboveTop, c.z));
    }
  }
  return s;
}

// 每列一个字符的小地图：. 和建议地面一样高，1~9/+ 高出几格，a~i/- 低几格，T 树，~ 水，! 岩浆，# 建筑，? 没加载
function asciiMap(rows: Column[][], base: number): string[] {
  return rows.map((row) => row.map((c) => {
    if (c.above === 'unloaded') return '?';
    if (c.above === 'lava') return '!';
    if (c.above === 'water') return '~';
    if (c.above === 'built') return '#';
    if (c.above === 'tree') return 'T';
    if (c.ground === null) return '?';
    const d = c.ground - base;
    if (d === 0) return '.';
    if (d > 0) return d <= 9 ? String(d) : '+';
    return -d <= 9 ? String.fromCharCode(96 - d) : '-';
  }).join(''));
}

const KIND_ZH: Record<string, string> = { tree: '树', water: '水', lava: '岩浆', built: '人造方块（可能是别人的建筑）' };

// 和这个范围（y 从地板到 top）有交集的登记区域
function regionHits(bot: Bot, x1: number, z1: number, x2: number, z2: number, y: number, top: number): string[] {
  const dim = bot.game?.dimension ?? 'overworld';
  return (regionStore().activeRegions(dim) ?? [])
    .filter((r) => r.min.x <= x2 && r.max.x >= x1 && r.min.z <= z2 && r.max.z >= z1 && r.min.y <= top && r.max.y >= y)
    .map((r) => `「${r.name}」（${r.kind}）`);
}

export function registerSiteTools(factory: ToolFactory, getBot: () => Bot): void {
  const footprintOf = (args: { from?: { x: number; y: number; z: number }; to?: { x: number; y: number; z: number }; blueprint?: { name: string; origin: { x: number; y: number; z: number }; rotation?: number } }) => {
    if (args.blueprint) {
      const rot = (args.blueprint.rotation ?? 0) as 0 | 90 | 180 | 270;
      const size = blueprintFootprint(loadBlueprint(args.blueprint.name), rot);
      const o = args.blueprint.origin;
      return { x1: Math.floor(o.x), z1: Math.floor(o.z), x2: Math.floor(o.x) + size.x - 1, z2: Math.floor(o.z) + size.z - 1, y: Math.floor(o.y), height: size.y };
    }
    if (args.from && args.to) {
      return {
        x1: Math.floor(Math.min(args.from.x, args.to.x)), x2: Math.floor(Math.max(args.from.x, args.to.x)),
        z1: Math.floor(Math.min(args.from.z, args.to.z)), z2: Math.floor(Math.max(args.from.z, args.to.z)),
        y: Math.floor(Math.min(args.from.y, args.to.y)), height: Math.abs(args.to.y - args.from.y) + 1
      };
    }
    return null;
  };

  factory.registerTool(
    "survey-site",
    "Check a building site before designing/placing: ground heights (suggested floor y, how many columns need digging or filling), trees, water, lava, man-made blocks (someone's building!) and registered regions inside it, with a one-character-per-column map. " +
    "Give `from`/`to` (the footprint; y = where the floor would go) or `blueprint` {name, origin, rotation} to check exactly where a blueprint would land. Also checks a 2-block margin around it",
    {
      from: vec3Schema.optional(),
      to: vec3Schema.optional(),
      blueprint: z.object({ name: z.string(), origin: vec3Schema, rotation: z.coerce.number().int().optional() }).optional(),
      margin: z.coerce.number().int().min(0).max(8).optional().describe("Blocks around the footprint to include (default: 2)")
    },
    async (args) => {
      const bot = getBot();
      let fp;
      try {
        fp = footprintOf(args);
      } catch (err) {
        return factory.createResponse((err as Error).message);
      }
      if (!fp) return factory.createResponse('给 from/to 或者 blueprint');
      const m = args.margin ?? 2;
      const x1 = fp.x1 - m, x2 = fp.x2 + m, z1 = fp.z1 - m, z2 = fp.z2 + m;
      if ((x2 - x1 + 1) * (z2 - z1 + 1) > MAX_SURVEY) return factory.createResponse(`范围太大，最多 ${MAX_SURVEY} 列`);
      const top = fp.y + Math.max(fp.height, 8) + 16;
      const rows = scanArea(bot, x1, z1, x2, z2, top);
      const inner = rows.slice(m, rows.length - m).map((r) => r.slice(m, r.length - m));
      const s = stats(inner);
      const lines = [
        `范围 x ${fp.x1}~${fp.x2}，z ${fp.z1}~${fp.z2}（${fp.x2 - fp.x1 + 1}×${fp.z2 - fp.z1 + 1}），周围多看 ${m} 格`,
        `地面高度 ${s.minY}~${s.maxY}，最常见的是 ${s.floor - 1} → 一楼地板建议放在 y=${s.floor}（贴着地面上面一层）；你给的 y=${fp.y}${fp.y === s.floor ? '，正好' : fp.y < s.floor ? '，偏低，地板会埋进地里（要 replace: "all" 挖地）' : '，偏高，下面会悬空（要垫地基）'}`,
        `高低差：${s.cut} 列比它高（要挖），${s.fill} 列比它低（要垫），最大差 ${s.maxDiff} 格${s.maxDiff >= 3 ? '，地不平，考虑换地方或者先平整' : ''}`
      ];
      const obstacles = Object.entries(s.counts).filter(([k]) => KIND_ZH[k]);
      if (obstacles.length) {
        lines.push('范围里有：' + obstacles.map(([k, c]) => `${KIND_ZH[k]} ${c} 列（如 ${s.samples[k].map(fmt).join(' ')}）`).join('；'));
        if (s.counts.tree) lines.push('- 有树：先用 mine-blocks 砍掉原木（blockTypes ["*_log"]），树叶会自己掉光；或者挪开几格');
        if (s.counts.built) lines.push('- 有人造方块：可能是别人的建筑，不能拆，换地方');
        if (s.counts.water || s.counts.lava) lines.push('- 有水 / 岩浆：build 挖不掉液体，换地方或者先填好');
      } else {
        lines.push('范围里没有树、水、建筑挡着');
      }
      if (s.unloaded) lines.push(`${s.unloaded} 列的区块没加载，走近一点再看`);
      const regions = regionHits(bot, fp.x1, fp.z1, fp.x2, fp.z2, fp.y, fp.y + Math.max(fp.height, 8));
      if (regions.length) lines.push(`和登记的区域重叠：${regions.join('、')}（里面的方块默认不动）`);
      lines.push(`小地图（北在上，每行是一个 z，从 x=${x1} 开始；外面 ${m} 圈是周围）：. 和建议地面一样高，数字高出几格，a~i 低几格，T 树，~ 水，! 岩浆，# 人造方块，? 没加载`);
      lines.push(...asciiMap(rows, s.floor - 1));
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "find-site",
    "Search around a point for flat, clear places big enough for a building (no trees, water, lava, man-made blocks or registered regions inside; ground within ±1). Returns the best few with the floor y to use as origin. Only loaded chunks are searched, so stand near the area first",
    {
      size: z.object({ x: z.coerce.number().int().min(1).max(48), z: z.coerce.number().int().min(1).max(48) }).describe("Footprint size (for a blueprint: its size after rotation)"),
      center: z.object({ x: z.coerce.number(), z: z.coerce.number() }).optional().describe("Search around here (default: where you stand)"),
      radius: z.coerce.number().int().min(4).max(48).optional().describe("Default: 32"),
      margin: z.coerce.number().int().min(0).max(6).optional().describe("Clear space around the footprint (default: 2)"),
      avoid: z.array(z.object({ from: vec3Schema, to: vec3Schema })).max(8).optional().describe("Boxes to stay away from (e.g. the last build)")
    },
    async ({ size, center, radius = 32, margin = 2, avoid = [] }) => {
      const bot = getBot();
      const c = center ? new Vec3(Math.floor(center.x), 0, Math.floor(center.z)) : bot.entity.position.floored();
      const top = Math.floor(bot.entity.position.y) + 32;
      const x1 = c.x - radius, z1 = c.z - radius, x2 = c.x + radius, z2 = c.z + radius;
      const rows = scanArea(bot, x1, z1, x2, z2, top);
      const at = (x: number, z: number) => rows[z - z1]?.[x - x1];
      const results: { x: number; z: number; floor: number; spread: number; dist: number }[] = [];
      const W = size.x + margin * 2, D = size.z + margin * 2;
      const blocked = (x: number, z: number) => avoid.some((b: { from: { x: number; z: number }; to: { x: number; z: number } }) => x >= Math.min(b.from.x, b.to.x) - margin && x <= Math.max(b.from.x, b.to.x) + margin && z >= Math.min(b.from.z, b.to.z) - margin && z <= Math.max(b.from.z, b.to.z) + margin);
      for (let ox = x1; ox + W - 1 <= x2; ox++) {
        for (let oz = z1; oz + D - 1 <= z2; oz++) {
          let lo = Infinity, hi = -Infinity, ok = true;
          for (let x = ox; x < ox + W && ok; x++) {
            for (let z = oz; z < oz + D; z++) {
              const col = at(x, z);
              if (!col || col.above || col.ground === null || blocked(x, z)) {
                ok = false;
                break;
              }
              lo = Math.min(lo, col.ground);
              hi = Math.max(hi, col.ground);
              if (hi - lo > 1) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) continue;
          const fx = ox + margin, fz = oz + margin;
          results.push({ x: fx, z: fz, floor: hi + 1, spread: hi - lo, dist: Math.hypot(fx + size.x / 2 - c.x, fz + size.z / 2 - c.z) });
        }
      }
      if (!results.length) return factory.createResponse(`${radius} 格内没找到 ${size.x}×${size.z}（外加 ${margin} 格空地）的平地。换个地方、减小尺寸，或者用 survey-site 看看哪块地可以先平整`);
      results.sort((a, b) => a.spread - b.spread || a.dist - b.dist);
      const picked: typeof results = [];
      for (const r of results) {
        if (picked.some((p) => Math.abs(p.x - r.x) < size.x && Math.abs(p.z - r.z) < size.z)) continue;
        const regions = regionHits(bot, r.x, r.z, r.x + size.x - 1, r.z + size.z - 1, r.floor, r.floor + 12);
        if (regions.length) continue;
        picked.push(r);
        if (picked.length >= 3) break;
      }
      if (!picked.length) return factory.createResponse('找到的平地都在登记的区域里，换个地方找');
      return factory.createResponse([
        `找到 ${picked.length} 块 ${size.x}×${size.z} 的平地（最小角 x,z；floor 是一楼地板的 y，蓝图 origin 用它）：`,
        ...picked.map((r, i) => `${i + 1}. origin (${r.x}, ${r.floor}, ${r.z})，${r.spread ? '有 1 格起伏' : '完全平'}，离中心 ${Math.round(r.dist)} 格`),
        '放之前再用 survey-site 确认一下'
      ].join('\n'));
    }
  );
}
