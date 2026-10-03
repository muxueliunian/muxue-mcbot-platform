// map-view：画一张北在上的俯视小地图（PNG）。
// surface：每一列最上面的方块（屋顶会挡住屋内，不代表能走通）
// slice：指定高度 y 的一层（y 处是空气且下面实心 = 能站人）
// 未加载的列单独画成"未知"，不当作空地。逐行生成，期间让出事件循环
import type { Bot } from 'mineflayer';
import pngjs from 'pngjs';
import { Vec3 } from 'vec3';
import { regionStore } from './action-policy.js';
import { entranceStore } from './entrances.js';
import { currentFocus } from './focus.js';
import { normalizeDimension } from './regions.js';
import { AIR, compassOfYaw } from './perception.js';

const { PNG } = pngjs;

type RGB = [number, number, number];

export const MAP_MAX_RADIUS = 64;
const SURFACE_WINDOW = 40;
const UNKNOWN_A: RGB = [96, 64, 96];
const UNKNOWN_B: RGB = [70, 50, 70];
const VOID: RGB = [12, 12, 20];

const PALETTE: [RegExp, RGB][] = [
  [/^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/, [52, 96, 200]],
  [/^(lava|magma_block)$/, [230, 100, 20]],
  [/(_door|_fence_gate|_trapdoor)$/, [255, 150, 40]],
  [/(chest|barrel|furnace|smoker|crafting_table|_bed|anvil|enchanting_table)$/, [200, 60, 160]],
  [/^farmland$/, [110, 70, 40]],
  [/^(wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_.*_stem)$/, [170, 200, 60]],
  [/_leaves$/, [40, 110, 40]],
  [/(grass_block|moss_block|moss_carpet)$/, [90, 160, 60]],
  [/^(short_grass|tall_grass|fern|large_fern|.*_flower|dandelion|poppy|.*_tulip|.*_sapling)$/, [110, 180, 70]],
  [/(sand|sandstone)$/, [220, 205, 150]],
  [/(snow|ice|powder_snow)/, [235, 240, 250]],
  [/(_planks|_stairs|_slab|_fence|bookshelf)$/, [190, 150, 95]],
  [/(_log|_wood|_stem|_hyphae)$/, [120, 85, 50]],
  [/(glass|_pane)$/, [180, 220, 230]],
  [/(dirt|mud|podzol|mycelium|coarse_dirt|rooted_dirt|dirt_path)$/, [140, 100, 65]],
  [/(gravel|clay)$/, [150, 145, 140]],
  [/(torch|lantern|glowstone|sea_lantern|campfire)/, [255, 230, 120]],
  [/(_ore)$/, [150, 130, 120]],
  [/(stone|cobblestone|andesite|diorite|granite|deepslate|tuff|bricks|_wall|calcite)/, [125, 125, 125]],
  [/(netherrack|nether_)/, [120, 40, 40]],
  [/(end_stone|purpur)/, [220, 220, 160]],
];

function colorOf(name: string): RGB {
  for (const [re, c] of PALETTE) if (re.test(name)) return c;
  return [150, 140, 125];
}

function shade(c: RGB, f: number): RGB {
  return [Math.max(0, Math.min(255, Math.round(c[0] * f))), Math.max(0, Math.min(255, Math.round(c[1] * f))), Math.max(0, Math.min(255, Math.round(c[2] * f)))];
}

export interface MapOptions {
  radius: number;
  mode: 'surface' | 'slice';
  y?: number;
  center?: { x: number; z: number };
  worldId?: string;
}

export interface MapResult {
  png: Buffer;
  caption: string;
  coverage: number;
}

// 世界变化计数：方块或区块变化后缓存失效
const versions = new WeakMap<Bot, { n: number }>();
function worldVersion(bot: Bot): number {
  let v = versions.get(bot);
  if (!v) {
    const counter = { n: 0 };
    v = counter;
    versions.set(bot, counter);
    const bump = () => { counter.n++; };
    for (const ev of ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload', 'respawn', 'end']) bot.on(ev as never, bump as never);
  }
  return v.n;
}

interface CacheEntry {
  key: string;
  bot: Bot;
  version: number;
  cells: Cell[];
}
let cache: CacheEntry | null = null;

interface Cell {
  kind: 'unknown' | 'void' | 'block' | 'floor' | 'air';
  name: string;
  height: number;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type FastWorld = { getBlockStateId?: (p: Vec3) => number | undefined; getColumnAt?: (p: Vec3) => unknown };

// 这一列所在区块是否已加载。注意 getBlockStateId 对未加载区块返回 0（空气），不能拿它判断
function columnLoaded(bot: Bot, pos: Vec3): boolean {
  const world = bot.world as unknown as FastWorld;
  if (world.getColumnAt) return Boolean(world.getColumnAt(pos));
  return bot.blockAt(pos) !== null;
}

// 只读方块名，不创建 Block 对象（扫描量大时快很多）。调用前先用 columnLoaded 确认区块已加载
function nameAt(bot: Bot, pos: Vec3): string | null {
  const world = bot.world as unknown as FastWorld;
  if (!world.getBlockStateId || !world.getColumnAt) return bot.blockAt(pos)?.name ?? null;
  const id = world.getBlockStateId(pos);
  if (id === undefined || id === null) return null;
  return (bot.registry as unknown as { blocksByStateId: Record<number, { name: string } | undefined> }).blocksByStateId[id]?.name ?? null;
}

// 当前维度的高度范围（登录/换维度时服务器发来）
export function heightRange(bot: Bot): { minY: number; maxY: number } {
  const game = bot.game as unknown as { minY?: number; height?: number };
  const minY = game.minY ?? -64;
  return { minY, maxY: minY + (game.height ?? 384) - 1 };
}

async function scan(bot: Bot, x0: number, z0: number, size: number, opts: MapOptions, cy: number): Promise<Cell[]> {
  const { minY, maxY } = heightRange(bot);
  const cells: Cell[] = new Array(size * size);
  const top = Math.min(maxY, cy + SURFACE_WINDOW);
  const bottom = Math.max(minY, cy - SURFACE_WINDOW);
  for (let row = 0; row < size; row++) {
    const z = z0 + row;
    for (let col = 0; col < size; col++) {
      const x = x0 + col;
      const idx = row * size + col;
      if (opts.mode === 'slice') {
        const y = opts.y!;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) {
          cells[idx] = { kind: 'unknown', name: '', height: y };
        } else if (AIR.has(b.name)) {
          const below = bot.blockAt(new Vec3(x, y - 1, z));
          const head = bot.blockAt(new Vec3(x, y + 1, z));
          const standable = below && below.boundingBox === 'block' && head && head.boundingBox !== 'block';
          cells[idx] = { kind: standable ? 'floor' : 'air', name: below?.name ?? '', height: y };
        } else {
          cells[idx] = { kind: 'block', name: b.name, height: y };
        }
        continue;
      }
      const probe = new Vec3(x, top, z);
      if (!columnLoaded(bot, probe)) {
        cells[idx] = { kind: 'unknown', name: '', height: bottom };
        continue;
      }
      let found: Cell | null = null;
      let loaded = false;
      for (let y = top; y >= bottom; y--) {
        probe.y = y;
        const name = nameAt(bot, probe);
        if (name === null) continue;
        loaded = true;
        if (AIR.has(name) || name === 'light' || name === 'barrier' || name === 'structure_void') continue;
        found = { kind: 'block', name, height: y };
        break;
      }
      cells[idx] = found ?? { kind: loaded ? 'void' : 'unknown', name: '', height: bottom };
    }
    if (row % 4 === 3) await tick();
  }
  return cells;
}

export async function renderMap(bot: Bot, opts: MapOptions): Promise<MapResult> {
  const radius = Math.floor(opts.radius);
  if (!(radius >= 4 && radius <= MAP_MAX_RADIUS)) throw new Error(`radius 要在 4~${MAP_MAX_RADIUS} 之间`);
  if (opts.mode === 'slice' && !Number.isInteger(opts.y)) throw new Error('slice 模式必须给出整数 y');
  const { minY, maxY } = heightRange(bot);
  if (opts.mode === 'slice' && (opts.y! < minY || opts.y! > maxY)) throw new Error(`y 要在 ${minY}~${maxY} 之间`);

  const me = bot.entity.position;
  const cx = Math.floor(opts.center?.x ?? me.x);
  const cz = Math.floor(opts.center?.z ?? me.z);
  const cy = Math.floor(me.y);
  const size = radius * 2 + 1;
  const x0 = cx - radius;
  const z0 = cz - radius;
  const px = Math.max(3, Math.min(16, Math.floor(768 / size)));
  const dim = normalizeDimension(bot.game.dimension);

  const key = `${dim}|${opts.mode}|${opts.y ?? ''}|${x0}|${z0}|${size}|${opts.mode === 'surface' ? cy : ''}`;
  const version = worldVersion(bot);
  let cells: Cell[];
  if (cache && cache.key === key && cache.bot === bot && cache.version === version) {
    cells = cache.cells;
  } else {
    cells = await scan(bot, x0, z0, size, opts, cy);
    // 记扫描开始前的版本：扫描期间世界有变化，下次就会重新扫描
    cache = { key, bot, version, cells };
  }

  const png = new PNG({ width: size * px, height: size * px });
  const put = (x: number, y: number, c: RGB) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const i = (y * png.width + x) * 4;
    png.data[i] = c[0];
    png.data[i + 1] = c[1];
    png.data[i + 2] = c[2];
    png.data[i + 3] = 255;
  };
  const fillCell = (col: number, row: number, c: RGB, inset = 0) => {
    for (let y = row * px + inset; y < (row + 1) * px - inset; y++) {
      for (let x = col * px + inset; x < (col + 1) * px - inset; x++) put(x, y, c);
    }
  };
  const outline = (x1: number, z1: number, x2: number, z2: number, c: RGB) => {
    const a = { col: x1 - x0, row: z1 - z0 };
    const b = { col: x2 - x0, row: z2 - z0 };
    const left = a.col * px, right = (b.col + 1) * px - 1, topY = a.row * px, bottomY = (b.row + 1) * px - 1;
    for (let x = left; x <= right; x++) { put(x, topY, c); put(x, bottomY, c); put(x, topY + 1, c); put(x, bottomY - 1, c); }
    for (let y = topY; y <= bottomY; y++) { put(left, y, c); put(right, y, c); put(left + 1, y, c); put(right - 1, y, c); }
  };

  let known = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = cells[row * size + col];
      let c: RGB;
      switch (cell.kind) {
        case 'unknown':
          c = (Math.floor((x0 + col) / 2) + Math.floor((z0 + row) / 2)) % 2 === 0 ? UNKNOWN_A : UNKNOWN_B;
          break;
        case 'void':
          known++;
          c = VOID;
          break;
        case 'floor':
          known++;
          c = shade(colorOf(cell.name), 1.25);
          break;
        case 'air':
          known++;
          c = [30, 30, 40];
          break;
        default:
          known++;
          c = opts.mode === 'slice' ? shade(colorOf(cell.name), 0.6) : shade(colorOf(cell.name), 1 + Math.max(-0.45, Math.min(0.45, (cell.height - cy) / 30)));
      }
      fillCell(col, row, c);
      // 每 8 格一条浅线（按世界坐标对齐）
      if ((x0 + col) % 8 === 0) for (let y = row * px; y < (row + 1) * px; y++) put(col * px, y, shade(c, 0.7));
      if ((z0 + row) % 8 === 0) for (let x = col * px; x < (col + 1) * px; x++) put(x, row * px, shade(c, 0.7));
    }
  }

  const inView = (x: number, z: number) => x >= x0 && x < x0 + size && z >= z0 && z < z0 + size;
  const clampBox = (a: number, b: number, lo: number) => [Math.max(a, lo), Math.min(b, lo + size - 1)];
  const regions = regionStore().activeRegions(dim) ?? [];
  const shownRegions: string[] = [];
  for (const reg of regions) {
    if (reg.max.x < x0 || reg.min.x >= x0 + size || reg.max.z < z0 || reg.min.z >= z0 + size) continue;
    const [ax, bx] = clampBox(reg.min.x, reg.max.x, x0);
    const [az, bz] = clampBox(reg.min.z, reg.max.z, z0);
    outline(ax, az, bx, bz, [250, 220, 40]);
    shownRegions.push(`${reg.name}（${reg.kind}）`);
  }
  const shownDoors: string[] = [];
  for (const e of entranceStore().list(dim)) {
    if (!inView(e.door.x, e.door.z)) continue;
    fillCell(e.door.x - x0, e.door.z - z0, [255, 120, 0], Math.floor(px / 4));
    shownDoors.push(e.name);
  }
  const { focus } = currentFocus(bot);
  if (focus && focus.dimension === bot.game.dimension) {
    const [ax, bx] = clampBox(focus.min.x, focus.max.x, x0);
    const [az, bz] = clampBox(focus.min.z, focus.max.z, z0);
    if (ax <= bx && az <= bz) outline(ax, az, bx, bz, [40, 230, 230]);
  }

  const playerLines: string[] = [];
  for (const p of Object.values(bot.players)) {
    if (!p.entity || p.username === bot.username) continue;
    const pos = p.entity.position;
    const dy = Math.round(pos.y - me.y);
    const rel = dy === 0 ? '同一高度' : dy > 0 ? `比我高 ${dy} 格` : `比我低 ${-dy} 格`;
    if (inView(Math.floor(pos.x), Math.floor(pos.z))) {
      const col = Math.floor(pos.x) - x0, row = Math.floor(pos.z) - z0;
      fillCell(col, row, [255, 255, 255], Math.max(0, Math.floor(px / 6)));
      fillCell(col, row, [40, 90, 255], Math.max(1, Math.floor(px / 4)));
      playerLines.push(`${p.username} (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}) ${rel}`);
    } else {
      playerLines.push(`${p.username} 在图外 (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`);
    }
  }

  // 自己：红色三角，尖端指向面朝方向
  if (inView(Math.floor(me.x), Math.floor(me.z))) {
    const centerX = (me.x - x0) * px;
    const centerY = (me.z - z0) * px;
    const len = Math.max(4, px * 1.2);
    const fx = -Math.sin(bot.entity.yaw), fz = -Math.cos(bot.entity.yaw);
    for (let yy = -len; yy <= len; yy++) {
      for (let xx = -len; xx <= len; xx++) {
        const along = xx * fx + yy * fz; // 沿朝向
        const across = xx * fz - yy * fx;
        if (along >= -len * 0.5 && along <= len && Math.abs(across) <= (len - along) * 0.5) {
          put(Math.round(centerX + xx), Math.round(centerY + yy), [230, 30, 30]);
        }
      }
    }
  }

  const coverage = known / (size * size);
  const buffer = PNG.sync.write(png);
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const caption = [
    `[${time}] ${opts.mode === 'surface' ? '俯视表面图' : `y=${opts.y} 的水平切面`}，北在上，1 格 = ${px} 像素；x ${x0}~${x0 + size - 1}，z ${z0}~${z0 + size - 1}；` +
      `世界 ${opts.worldId || '（未配置 world-id）'} / ${dim}`,
    `我在 (${Math.floor(me.x)}, ${Math.floor(me.y)}, ${Math.floor(me.z)})，面朝${compassOfYaw(bot.entity.yaw)}（红三角）。已加载 ${Math.round(coverage * 100)}%，紫色棋盘格 = 未加载，不清楚那里是什么`,
    opts.mode === 'surface'
      ? `表面图显示每列 y ${Math.max(minY, cy - SURFACE_WINDOW)}~${Math.min(maxY, cy + SURFACE_WINDOW)} 内最高的方块，越亮越高；屋顶会挡住屋里，不代表能走通；近黑色 = 这个高度范围内没有方块`
      : `切面图：亮色 = 这一层能站人（脚下实心、头顶有空间），暗色 = 这一层是方块（墙），深灰 = 悬空`,
    '颜色：蓝=水，橙=门/门洞登记点，品红=箱子/熔炉/床等，棕=农田或木头，深绿=树叶，灰=石头；黄框=保护区域，青框=关注目标，蓝点=玩家',
    `玩家：${playerLines.length ? playerLines.join('；') : '附近没有'}`,
  ];
  if (shownRegions.length) caption.push(`图中区域：${shownRegions.join('、')}`);
  if (shownDoors.length) caption.push(`图中入口：${shownDoors.join('、')}`);
  return { png: buffer, caption: caption.join('\n'), coverage };
}
