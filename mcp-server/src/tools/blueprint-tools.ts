// 蓝图（保存 / 列出 / 删除）、清除建筑预览、备料（从箱子里拿、自己合成）
import { z } from "zod";
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { TaskHandle } from '../task-control.js';
import { log } from '../logger.js';
import { vec3Schema, fmt, isEmpty, approach, inventoryCounts, sleep, isCreative, creativeTake } from './block-ops.js';
import { AUTO_PROPS, formatBlockSpec, isCompanionCell, itemForBlock, parseBlockSpec, validateSpec, type BlockSpec } from '../block-state.js';
import {
  deleteBlueprint, editBlueprint, listBlueprints, loadBlueprint, makeBlueprint, saveBlueprint, shapeCells, type Cell
} from '../blueprints.js';
import { MAX_BUILD, clearPreview, materialNeeds, resolveTargets, shapeSchema, targetSchema } from '../building.js';
import { renderVoxels, type Voxel } from '../vision/voxel-render.js';
import { rotatedSize, rotatePos, rotateSpec } from '../block-state.js';
import {
  checkDataVersion, convertCells, decodeSchematic, listSchematicFiles, makeImportedBlueprint, readSchematicNbt, resolveSchematicFile, schematicDir
} from '../schematic.js';

const { goals } = pathfinderPkg;
const MAX_CAPTURE_VOLUME = 32768;

function describeSize(s: { x: number; y: number; z: number }): string {
  return `${s.x}×${s.y}×${s.z}（x×y×z）`;
}

function materialsOf(version: string, blocks: [number, number, number, string][]): Map<string, number> {
  const mcData = minecraftData(version);
  const out = new Map<string, number>();
  for (const [, , , text] of blocks) {
    const spec = parseBlockSpec(text);
    if (spec.name === 'air' || isCompanionCell(spec)) continue;
    const item = itemForBlock(spec.name, mcData as never) ?? spec.name;
    out.set(item, (out.get(item) ?? 0) + 1);
  }
  return out;
}

// 从世界里框一块下来：去掉由周围决定的属性，门只记下半、床只记床尾
function captureCells(bot: Bot, from: Vec3, to: Vec3, includeAir: boolean): { cells: Cell[]; skipped: Map<string, number> } {
  const mcData = minecraftData(bot.version);
  const [x1, x2] = [Math.min(from.x, to.x), Math.max(from.x, to.x)];
  const [y1, y2] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
  const [z1, z2] = [Math.min(from.z, to.z), Math.max(from.z, to.z)];
  const volume = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
  if (volume > MAX_CAPTURE_VOLUME) throw new Error(`框的范围太大：${volume} 格，最多 ${MAX_CAPTURE_VOLUME} 格`);
  const cells: Cell[] = [];
  const skipped = new Map<string, number>();
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      for (let z = z1; z <= z2; z++) {
        const pos = new Vec3(x, y, z);
        const b = bot.blockAt(pos);
        if (!b) throw new Error(`${fmt(pos)} 的区块没加载，走近一点再框`);
        if (isEmpty(b)) {
          if (includeAir && ['air', 'cave_air', 'void_air'].includes(b.name)) cells.push({ pos, block: 'air' });
          continue;
        }
        const props = b.getProperties() as Record<string, unknown>;
        if (isCompanionCell({ name: b.name, props: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v)])) })) continue;
        if (!itemForBlock(b.name, mcData as never)) {
          skipped.set(b.name, (skipped.get(b.name) ?? 0) + 1);
          continue;
        }
        const spec: BlockSpec = { name: b.name, props: {} };
        for (const [k, v] of Object.entries(props)) if (!AUTO_PROPS.has(k)) spec.props[k] = String(v);
        cells.push({ pos, block: formatBlockSpec(spec) });
      }
    }
  }
  return { cells, skipped };
}

// ---- 备料 ----

interface Recipe {
  inShape?: (number | null)[][];
  ingredients?: number[];
  result: { id: number; count: number };
}

interface CraftStep {
  item: string;
  times: number;
  table: boolean;
}

function recipeNeeds(r: Recipe): Map<number, number> {
  const out = new Map<number, number>();
  const cells = r.inShape ? r.inShape.flat() : r.ingredients ?? [];
  for (const id of cells) if (typeof id === 'number') out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

function needsTable(r: Recipe): boolean {
  if (r.inShape) return r.inShape.length > 2 || r.inShape.some((row) => row.length > 2);
  return (r.ingredients?.length ?? 0) > 4;
}

// 规划怎么合成出 count 个 item：avail 是能用的物品（背包 + 箱子里的），会被扣掉；返回按先后顺序的合成步骤，做不到返回 null
export function planCraft(mcData: ReturnType<typeof minecraftData>, item: string, count: number, avail: Map<string, number>, depth: number): CraftStep[] | null {
  if (depth <= 0 || count <= 0) return count <= 0 ? [] : null;
  const id = mcData.itemsByName[item]?.id;
  const recipes = (id !== undefined ? (mcData.recipes as unknown as Record<number, Recipe[]>)[id] : undefined) ?? [];
  // 先试原料最齐的配方
  const scored = recipes.map((r) => {
    let missing = 0;
    for (const [ing, per] of recipeNeeds(r)) {
      const name = mcData.items[ing]?.name ?? '';
      missing += Math.max(0, per * Math.ceil(count / r.result.count) - (avail.get(name) ?? 0));
    }
    return { r, missing };
  }).sort((a, b) => a.missing - b.missing);
  for (const { r } of scored) {
    const trial = new Map(avail);
    const times = Math.ceil(count / r.result.count);
    const steps: CraftStep[] = [];
    let ok = true;
    for (const [ing, per] of recipeNeeds(r)) {
      const name = mcData.items[ing]?.name;
      if (!name) {
        ok = false;
        break;
      }
      const want = per * times;
      const have = trial.get(name) ?? 0;
      if (have < want) {
        const sub = planCraft(mcData, name, want - have, trial, depth - 1);
        if (!sub) {
          ok = false;
          break;
        }
        steps.push(...sub);
      }
      trial.set(name, (trial.get(name) ?? 0) - want);
    }
    if (!ok) continue;
    steps.push({ item, times, table: needsTable(r) });
    trial.set(item, (trial.get(item) ?? 0) + times * r.result.count);
    avail.clear();
    for (const [k, v] of trial) avail.set(k, v);
    return steps;
  }
  return null;
}

const CONTAINER = /^(chest|trapped_chest|barrel)$/;

interface ChestInfo {
  pos: Vec3;
  items: Map<string, number>;
}

async function openAt(bot: Bot, pos: Vec3, handle: TaskHandle) {
  const block = bot.blockAt(pos);
  if (!block || !CONTAINER.test(block.name)) throw new Error(`${fmt(pos)} 不是箱子或木桶`);
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
    await approach(bot, () => new goals.GoalNear(pos.x, pos.y, pos.z, 3), 20000, handle);
  }
  return bot.openContainer(block as Block);
}

function subtract(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of a) {
    const left = v - (b.get(k) ?? 0);
    if (left > 0) out.set(k, left);
  }
  return out;
}

function listMap(m: Map<string, number>): string {
  return [...m.entries()].map(([n, c]) => `${n} x${c}`).join('，');
}

export function registerBlueprintTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "save-blueprint",
    "Save a building design as a reusable blueprint (relative coordinates, can be placed later with build's `blueprint` at any origin and rotation). Either give `blocks`/`shapes` (coordinates are normalised so the minimum corner becomes 0,0,0; states like oak_stairs[facing=east] allowed) or `capture` a box from the world (e.g. copy something the player built; states are kept, door upper halves / bed heads are implied)",
    {
      name: z.string().describe("Blueprint name: letters, digits, Chinese, _ or -, up to 40 chars"),
      description: z.string().max(200).optional().describe("What it is, e.g. \"7x7 oak cabin with gable roof, door facing east\""),
      blocks: z.array(z.object({ x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number(), block: z.string() })).max(MAX_BUILD).optional(),
      shapes: z.array(shapeSchema).max(32).optional(),
      capture: z.object({
        from: vec3Schema,
        to: vec3Schema,
        includeAir: z.boolean().optional().describe("Also record empty cells, so building it clears grass etc. inside (default: false)")
      }).optional().describe("Copy the blocks inside this world box instead"),
      overwrite: z.boolean().optional().describe("Replace an existing blueprint with the same name (default: false)")
    },
    async ({ name, description = '', blocks, shapes, capture, overwrite = false }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const exists = (n: string) => Boolean(mcData.blocksByName[n]);
      let cells: Cell[] = [];
      let base: Vec3 | undefined;
      const notes: string[] = [];
      try {
        if (capture) {
          const from = new Vec3(capture.from.x, capture.from.y, capture.from.z).floored();
          const to = new Vec3(capture.to.x, capture.to.y, capture.to.z).floored();
          const got = captureCells(bot, from, to, capture.includeAir ?? false);
          cells = got.cells;
          base = new Vec3(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.min(from.z, to.z));
          if (got.skipped.size) notes.push(`没记下的（放不了的方块）：${listMap(got.skipped)}`);
        } else {
          for (const s of shapes ?? []) cells.push(...shapeCells(s, MAX_BUILD, exists));
          for (const b of blocks ?? []) cells.push({ pos: new Vec3(b.x, b.y, b.z).floored(), block: b.block });
        }
        const bad = new Set<string>();
        for (const c of cells) {
          const problem = validateSpec(parseBlockSpec(c.block), mcData as never);
          if (problem) bad.add(problem);
        }
        if (bad.size) return factory.createResponse(`没保存：${[...bad].slice(0, 6).join('；')}`);
        if (cells.length > MAX_BUILD) return factory.createResponse(`没保存：${cells.length} 格，蓝图最多 ${MAX_BUILD} 格`);
        const bp = makeBlueprint(name, description, cells, capture ? `从世界 ${fmt(base!)} 起框下来` : '手写', base);
        saveBlueprint(bp, overwrite);
        const mats = materialsOf(bot.version, bp.blocks);
        return factory.createResponse([
          `已保存蓝图「${name}」：${bp.blocks.length} 格，尺寸 ${describeSize(bp.size)}`,
          `材料：${listMap(mats) || '无'}`,
          ...notes,
          `用法：build 的 blueprint: { name: "${name}", origin: {最小角坐标}, rotation: 0/90/180/270 }，先 preview 给对方看`
        ].join('\n'));
      } catch (err) {
        return factory.createResponse(`没保存：${(err as Error).message}`);
      }
    }
  );

  factory.registerTool(
    "list-blueprints",
    "List saved blueprints with size and materials; give `name` to see one in detail (block counts per layer, from the bottom)",
    {
      name: z.string().optional()
    },
    async ({ name }) => {
      if (name) {
        let bp;
        try {
          bp = loadBlueprint(name);
        } catch (err) {
          return factory.createResponse((err as Error).message);
        }
        const layers = new Map<number, Map<string, number>>();
        for (const [, y, , text] of bp.blocks) {
          const layer = layers.get(y) ?? new Map<string, number>();
          layer.set(text, (layer.get(text) ?? 0) + 1);
          layers.set(y, layer);
        }
        const lines = [
          `蓝图「${bp.name}」${bp.description ? `：${bp.description}` : ''}`,
          `尺寸 ${describeSize(bp.size)}，${bp.blocks.length} 格，${bp.source}，${bp.createdAt.slice(0, 10)}`,
          `材料：${listMap(materialsOf('1.21.1', bp.blocks)) || '无'}`,
          ...[...layers.entries()].sort((a, b) => a[0] - b[0]).map(([y, m]) => `- 第 ${y} 层：${listMap(m)}`)
        ];
        return factory.createResponse(lines.join('\n'));
      }
      const all = listBlueprints();
      if (!all.length) return factory.createResponse('还没有保存的蓝图（用 save-blueprint 保存）');
      return factory.createResponse(all.map((bp) =>
        `- ${bp.name}：${describeSize(bp.size)}，${bp.blocks.length} 格${bp.description ? `，${bp.description}` : ''}`
      ).join('\n'));
    }
  );

  factory.registerTool(
    "render-blueprint",
    "Draw a design as a picture so you can check how it looks before (or after) building: two 45° 3D views (front and back) plus a cut-away floor plan for each floor (walls dark grey, north up), with real block textures. " +
    "Give `name` for a saved blueprint (optionally `rotation`), or `area` to draw what is actually in the world (e.g. after building, to compare with the plan). Look at it critically: proportions, depth, repeated plain walls, window rhythm, colours, roof edge, whether rooms are furnished",
    {
      name: z.string().optional().describe("Saved blueprint name"),
      rotation: z.coerce.number().int().optional().describe("0/90/180/270, same as build"),
      area: z.object({ from: vec3Schema, to: vec3Schema }).optional().describe("World box to draw instead (max 32768 blocks)"),
      front: z.enum(['south', 'north', 'east', 'west']).optional().describe("Which side is the front, drawn in the left view (default: south)"),
      plans: z.boolean().optional().describe("Also draw floor plans (default: true)")
    },
    async ({ name, rotation = 0, area, front, plans }) => {
      let voxels: Voxel[] = [];
      let what = '';
      try {
        if (name) {
          if (![0, 90, 180, 270].includes(rotation)) return factory.createResponse('rotation 只能是 0、90、180、270');
          const bp = loadBlueprint(name);
          const size = new Vec3(bp.size.x, bp.size.y, bp.size.z);
          const rot = rotation as 0 | 90 | 180 | 270;
          voxels = bp.blocks.filter((b) => !b[3].startsWith('air')).map(([x, y, z, text]) => ({
            pos: rotatePos(new Vec3(x, y, z), rot, size),
            spec: rotateSpec(parseBlockSpec(text), rot)
          }));
          const s = rotatedSize(size, rot);
          what = `蓝图「${name}」${rot ? `（转 ${rot}°）` : ''}，${s.x}×${s.y}×${s.z}，坐标是蓝图里的相对坐标`;
        } else if (area) {
          const bot = getBot();
          const from = new Vec3(Math.min(area.from.x, area.to.x), Math.min(area.from.y, area.to.y), Math.min(area.from.z, area.to.z)).floored();
          const to = new Vec3(Math.max(area.from.x, area.to.x), Math.max(area.from.y, area.to.y), Math.max(area.from.z, area.to.z)).floored();
          const volume = (to.x - from.x + 1) * (to.y - from.y + 1) * (to.z - from.z + 1);
          if (volume > MAX_CAPTURE_VOLUME) return factory.createResponse(`范围太大：${volume} 格，最多 ${MAX_CAPTURE_VOLUME} 格`);
          for (let y = from.y; y <= to.y; y++) for (let x = from.x; x <= to.x; x++) for (let z = from.z; z <= to.z; z++) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (!b) return factory.createResponse(`${fmt(new Vec3(x, y, z))} 的区块没加载，走近一点再画`);
            if (['air', 'cave_air', 'void_air'].includes(b.name)) continue;
            const props: Record<string, string> = {};
            for (const [k, v] of Object.entries(b.getProperties() as Record<string, unknown>)) props[k] = String(v);
            voxels.push({ pos: new Vec3(x, y, z).minus(from), spec: { name: b.name, props } });
          }
          what = `世界里 ${fmt(from)} 到 ${fmt(to)} 的实际样子（平面图的 y 是相对 ${from.y} 的）`;
        } else {
          return factory.createResponse('给 name（蓝图）或者 area（世界里的范围）');
        }
      } catch (err) {
        return factory.createResponse((err as Error).message);
      }
      if (!voxels.length) return factory.createResponse('里面没有方块');
      const r = renderVoxels(voxels, { front, plans });
      return factory.createImageResponse(r.png, 'image/png', `${what}
${r.caption}`);
    }
  );

  factory.registerTool(
    "edit-blueprint",
    "Change a saved blueprint without re-writing it: `replace` materials (e.g. {from: \"black_concrete\", to: \"spruce_planks\"}; a bare name swaps every such block and keeps facing/half etc. where the new block has them, a state like oak_stairs[half=top] only swaps matching ones), " +
    "optionally only `within` a box, `remove` boxes of cells, and `set` a few cells (relative blueprint coordinates, 0,0,0 is the minimum corner; see list-blueprints / render-blueprint). " +
    "Saves to `saveAs` (a new name, keeps the old version) or over the same blueprint with overwrite: true. Render it again afterwards",
    {
      name: z.string().describe("Blueprint to change"),
      replace: z.array(z.object({ from: z.string(), to: z.string() })).max(32).optional(),
      within: z.object({ from: vec3Schema, to: vec3Schema }).optional().describe("Only replace inside this box (blueprint coordinates)"),
      remove: z.array(z.object({ from: vec3Schema, to: vec3Schema })).max(32).optional().describe("Delete the cells in these boxes (blueprint coordinates)"),
      set: z.array(z.object({ x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number(), block: z.string() })).max(MAX_BUILD).optional().describe("Put these blocks (blueprint coordinates; \"air\" means clear it when building)"),
      saveAs: z.string().optional().describe("Save as a new blueprint (default: same name, needs overwrite: true)"),
      description: z.string().max(200).optional(),
      overwrite: z.boolean().optional()
    },
    async ({ name, replace, within, remove, set, saveAs, description, overwrite = false }) => {
      if (!replace?.length && !remove?.length && !set?.length) return factory.createResponse('给 replace、remove 或 set，说要改什么');
      if (!saveAs && !overwrite) return factory.createResponse(`改完存到哪：给 saveAs 存成新蓝图（保留原来的），或者 overwrite: true 直接改「${name}」`);
      let version = '1.21.1';
      try {
        version = getBot().version ?? version;
      } catch {
        // 不在线也能改
      }
      const mcData = minecraftData(version);
      try {
        const old = loadBlueprint(name);
        const r = editBlueprint(old, { replace, within, remove, set }, mcData as never);
        const bad = new Set<string>();
        for (const [, , , text] of r.bp.blocks) {
          const problem = validateSpec(parseBlockSpec(text), mcData as never);
          if (problem) bad.add(problem);
        }
        if (bad.size) return factory.createResponse(`没保存：${[...bad].slice(0, 6).join('；')}`);
        if (r.bp.blocks.length > MAX_BUILD) return factory.createResponse(`没保存：${r.bp.blocks.length} 格，蓝图最多 ${MAX_BUILD} 格`);
        const target = saveAs ?? name;
        const bp = { ...r.bp, name: target, description: description ?? old.description, source: saveAs ? `由「${name}」改出来（${old.source}）` : old.source };
        saveBlueprint(bp, overwrite);
        const lines = [`已保存蓝图「${target}」：${bp.blocks.length} 格，尺寸 ${describeSize(bp.size)}`];
        for (const [rule, n] of r.replaced) lines.push(`- 换 ${rule}：${n} 格${n ? '' : '（一格都没对上，检查名字和属性）'}`);
        if (remove?.length) lines.push(`- 删掉 ${r.removed} 格`);
        if (set?.length) lines.push(`- 改/加 ${r.set} 格`);
        lines.push(`材料：${listMap(materialsOf(version, bp.blocks)) || '无'}`, '改完用 render-blueprint 再看一眼');
        return factory.createResponse(lines.join('\n'));
      } catch (err) {
        return factory.createResponse(`没保存：${(err as Error).message}`);
      }
    }
  );

  factory.registerTool(
    "import-schematic",
    "Turn a downloaded building schematic (Sponge/WorldEdit .schem v2/v3, Litematica .litematic, vanilla structure block .nbt) from the data/schematics folder into a blueprint. " +
    "Without `file` it lists the files there. By default it is a dry run that reports what would be kept and skipped (air, door tops, bed heads, water, potted plants, mod blocks, chest contents, sign text...); run again with dryRun: false to save. " +
    "Then render-blueprint to look at it and build with blueprint as usual. Downloaded works are for personal use only",
    {
      file: z.string().optional().describe("File name inside data/schematics, e.g. \"house.schem\""),
      name: z.string().optional().describe("Blueprint name to save as (required when dryRun is false)"),
      description: z.string().max(200).optional(),
      format: z.enum(['auto', 'sponge', 'litematica', 'structure']).optional().describe("Default: auto"),
      regionNames: z.array(z.string()).max(64).optional().describe("Litematica: which regions to take (default: all)"),
      paletteIndex: z.coerce.number().int().min(0).optional().describe("Structure .nbt with several palettes: which one (default: 0)"),
      sourceDataVersion: z.coerce.number().int().optional().describe("Only when the file has no DataVersion (1.21.1 is 3955)"),
      onConflict: z.enum(['error', 'first', 'last']).optional().describe("Litematica regions overlapping with different blocks (default: error)"),
      exclude: z.array(z.string()).max(64).optional().describe("Block names to leave out, e.g. [\"dirt\", \"grass_block\"] to drop the ground under the house"),
      strict: z.boolean().optional().describe("Fail instead of skipping unsupported blocks (default: false)"),
      dryRun: z.boolean().optional().describe("Only report, don't save (default: true)"),
      overwrite: z.boolean().optional(),
      sourceUrl: z.string().max(300).optional(),
      attribution: z.string().max(100).optional().describe("Author, e.g. \"EcoSMP\""),
      licenseNote: z.string().max(200).optional()
    },
    async (args) => {
      if (!args.file) {
        const files = listSchematicFiles();
        if (!files.length) return factory.createResponse(`${schematicDir()} 里还没有图纸（支持 .schem / .litematic / .nbt）`);
        return factory.createResponse(['schematics 文件夹里的图纸：', ...files.map((f) => `- ${f.name}（${Math.max(1, Math.round(f.bytes / 1024))} KB）`)].join('\n'));
      }
      const dryRun = args.dryRun ?? true;
      if (!dryRun && !args.name) return factory.createResponse('保存要给 name（蓝图名）');
      let version = '1.21.1';
      try {
        version = getBot().version ?? version;
      } catch {
        // 不在线也能导入
      }
      const mcData = minecraftData(version);
      const target = (mcData.version as { dataVersion?: number }).dataVersion ?? 3955;
      try {
        const dec = decodeSchematic(await readSchematicNbt(resolveSchematicFile(args.file)), args);
        const dv = checkDataVersion(dec.dataVersion, args.sourceDataVersion);
        const conv = convertCells(dec, mcData as never, { exclude: args.exclude, strict: args.strict, newerSource: dv > target });
        const lines: string[] = [];
        lines.push(`图纸 ${args.file}：${dec.format}，DataVersion ${dv}${dv > target ? `（比 ${version} 新，新版才有的方块会跳过）` : ''}，尺寸 ${describeSize({ x: dec.size[0], y: dec.size[1], z: dec.size[2] })}${dec.regions.length > 1 ? `，区域 ${dec.regions.join('、')}` : ''}`);
        if (dec.paletteNote) lines.push(dec.paletteNote);
        lines.push(`读了 ${dec.declared} 格：空气 ${dec.air}，非空气 ${dec.cells.length}${dec.overlaps ? `（区域重叠 ${dec.overlaps} 格）` : ''}`);
        const skips: string[] = [];
        if (conv.companions) skips.push(`门上半/床头/双格植物上半 ${conv.companions} 格（放下半时自动出现）`);
        if (conv.excluded) skips.push(`按 exclude 去掉 ${conv.excluded} 格`);
        for (const [reason, n] of conv.skipped) skips.push(`${reason} ${n} 格（${conv.examples.get(reason)!.join('、')}）`);
        if (skips.length) lines.push(`跳过：${skips.join('；')}`);
        if (conv.replaced.size) lines.push(`换掉：${[...conv.replaced.entries()].map(([k, n]) => `${k} ${n} 格`).join('；')}`);
        const lost: string[] = [];
        if (dec.blockEntities) lost.push(`方块附加数据 ${dec.blockEntities} 条（箱子里的东西、告示牌的字、旗帜图案等）`);
        if (dec.entities) lost.push(`实体 ${dec.entities} 个（物品展示框、盔甲架等）`);
        if (lost.length) lines.push(`没导入：${lost.join('，')}`);
        if (!conv.blocks.length) return factory.createResponse([...lines, '没有可保存的方块：全是空气或者放不了的'].join('\n'));
        lines.push(`最后保留 ${conv.blocks.length} 格；材料：${listMap(materialsOf(version, conv.blocks))}`);
        const ground = conv.blocks.filter((b) => ['dirt', 'grass_block', 'coarse_dirt', 'podzol'].includes(b[3])).length;
        if (ground) lines.push(`其中泥土/草方块 ${ground} 格，多半是房子下面的地面；不想要可以加 exclude: ["dirt", "grass_block"]`);
        if (conv.blocks.length > MAX_BUILD) {
          lines.push(`超过上限：最多 ${MAX_BUILD} 格，没法存成一张蓝图；用 exclude 去掉一些方块，或者选 Litematica 的部分区域`);
          return factory.createResponse(lines.join('\n'));
        }
        if (dryRun) {
          lines.push(`这是预检，没保存。确认没问题就加 dryRun: false${args.name ? '' : ' 和 name'} 再调一次`);
          return factory.createResponse(lines.join('\n'));
        }
        const source = [
          `图纸 ${args.file}（${dec.format}，DataVersion ${dv}）`,
          args.attribution && `作者 ${args.attribution}`,
          args.sourceUrl,
          args.licenseNote
        ].filter(Boolean).join('，');
        const bp = makeImportedBlueprint(args.name!, args.description ?? '', dec, conv.blocks, source);
        saveBlueprint(bp, args.overwrite ?? false);
        lines.push(`已保存蓝图「${bp.name}」。先 render-blueprint 看看，再 build 的 blueprint 盖（先 preview）。别人的作品只能自己玩，不要公开分享`);
        return factory.createResponse(lines.join('\n'));
      } catch (err) {
        return factory.createResponse(`没导入：${(err as Error).message}`);
      }
    }
  );

  factory.registerTool(
    "delete-blueprint",
    "Delete a saved blueprint",
    { name: z.string() },
    async ({ name }) => {
      try {
        return factory.createResponse(deleteBlueprint(name) ? `已删除蓝图「${name}」` : `没有叫「${name}」的蓝图`);
      } catch (err) {
        return factory.createResponse((err as Error).message);
      }
    }
  );

  factory.registerTool(
    "clear-preview",
    "Remove the ghost blocks shown by build with preview: true",
    {},
    async () => {
      const err = await clearPreview();
      return factory.createResponse(err ? `没清掉：${err}` : '预览已清掉');
    }
  );

  factory.registerTool(
    "prepare-materials",
    "Get the materials a build needs before building: takes the same `blocks` / `shapes` / `blueprint` as build (and/or an explicit `items` list), counts what is still missing from the inventory, " +
    "takes it from chests/barrels (the listed ones, or all within searchRadius), then crafts what is still missing from what you have (e.g. logs → planks → stairs/doors/fences/sticks; needs a placed crafting table within 32 blocks for 3x3 recipes). Takes only what is needed. Smelting is not done",
    {
      ...targetSchema,
      items: z.array(z.object({ name: z.string(), count: z.coerce.number().int().min(1).max(2304) })).max(32).optional().describe("Extra items to get"),
      chests: z.array(vec3Schema).max(16).optional().describe("Chests/barrels to take from (default: every chest/barrel within searchRadius)"),
      searchRadius: z.coerce.number().int().min(1).max(32).optional().describe("Default: 12"),
      craft: z.boolean().optional().describe("Craft what is still missing (default: true)"),
      timeoutSeconds: z.coerce.number().int().min(10).max(600).optional().describe("Default: 180")
    },
    async (args) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const handle = new TaskHandle({ timeoutMs: (args.timeoutSeconds ?? 180) * 1000, interruptOnChat: true });
      let need = new Map<string, number>();
      try {
        if (args.blocks?.length || args.shapes?.length || args.blueprint) {
          need = materialNeeds(bot, resolveTargets(bot.version, args).targets);
        }
      } catch (err) {
        return factory.createResponse((err as Error).message);
      }
      for (const it of args.items ?? []) {
        const n = it.name.toLowerCase().replace(/^minecraft:/, '');
        if (!mcData.itemsByName[n]) return factory.createResponse(`没有叫 ${it.name} 的物品`);
        need.set(n, (need.get(n) ?? 0) + it.count);
      }
      if (!need.size) return factory.createResponse('不需要材料（目标都已经放好了，或者没给目标）');

      // 创造模式：放方块不消耗，每种有一组就够，直接从创造物品栏拿
      if (isCreative(bot)) {
        const got: string[] = [];
        const failed: string[] = [];
        const have = inventoryCounts(bot);
        for (const n of need.keys()) {
          if (have.has(n)) continue;
          if (await creativeTake(bot, n, new Set(need.keys()))) got.push(n);
          else failed.push(n);
        }
        return factory.createResponse([
          `创造模式：放方块不消耗材料，每种有一组就够`,
          got.length ? `从创造物品栏拿了：${got.join('，')}` : '需要的都已经在身上了',
          failed.length ? `没拿到：${failed.join('，')}` : '材料都齐了，可以 build 了'
        ].join('\n'));
      }
      const missing = () => subtract(need, inventoryCounts(bot));
      const taken = new Map<string, number>();
      const add = (m: Map<string, number>, n: string, c: number) => m.set(n, (m.get(n) ?? 0) + c);
      const lines: string[] = [];
      let stop: string | null = null;

      // 1. 箱子：先拿直接要用的，记下箱子里还有什么（合成原料可能也在里面）
      const ids = Object.values(mcData.blocksByName).filter((b) => CONTAINER.test(b.name)).map((b) => b.id);
      const chestPos = args.chests?.length
        ? args.chests.map((p: { x: number; y: number; z: number }) => new Vec3(p.x, p.y, p.z).floored())
        : bot.findBlocks({ matching: ids, maxDistance: args.searchRadius ?? 12, count: 32 });
      const chests: ChestInfo[] = [];
      const opened: Vec3[] = [];
      const takeFrom = async (pos: Vec3, wanted: Map<string, number>): Promise<Map<string, number>> => {
        const container = await openAt(bot, pos, handle);
        const got = new Map<string, number>();
        try {
          for (const [n, c] of wanted) {
            const items = container.containerItems().filter((i) => i.name === n);
            const have = items.reduce((s, i) => s + i.count, 0);
            const amount = Math.min(c, have);
            if (amount <= 0) continue;
            await container.withdraw(items[0].type, null, amount);
            add(got, n, amount);
          }
          const left = new Map<string, number>();
          for (const i of container.containerItems()) add(left, i.name, i.count);
          const info = chests.find((ch) => ch.pos.equals(pos));
          if (info) info.items = left;
          else chests.push({ pos, items: left });
        } finally {
          container.close();
        }
        await sleep(150);
        return got;
      };
      for (const pos of chestPos) {
        stop = handle.check();
        if (stop) break;
        // 大箱子两半打开的是同一个箱子，挨着开过的同种容器跳过
        const b = bot.blockAt(pos);
        if (!b || !CONTAINER.test(b.name)) {
          lines.push(`${fmt(pos)} 不是箱子或木桶，跳过`);
          continue;
        }
        if (opened.some((o) => o.distanceTo(pos) <= 1 && bot.blockAt(o)?.name === b.name && b.name !== 'barrel')) continue;
        opened.push(pos);
        try {
          const got = await takeFrom(pos, missing());
          for (const [n, c] of got) add(taken, n, c);
          if (got.size) lines.push(`从 ${b.name} ${fmt(pos)} 拿了：${listMap(got)}`);
        } catch (err) {
          lines.push(`${b.name} ${fmt(pos)} 打不开：${(err as Error).message}`);
        }
      }

      // 2. 合成：用背包 + 箱子里剩下的规划，缺的原料先去箱子拿
      const crafted = new Map<string, number>();
      if (!stop && (args.craft ?? true) && missing().size) {
        const inv = inventoryCounts(bot);
        const inChests = new Map<string, number>();
        for (const ch of chests) for (const [n, c] of ch.items) add(inChests, n, c);
        // 能拿来当原料的量 = 背包 + 箱子 − 建筑本身要直接用的（不能把要铺地板的木板拿去做楼梯）
        const start = new Map<string, number>();
        for (const n of new Set([...inv.keys(), ...inChests.keys()])) {
          start.set(n, Math.max(0, (inv.get(n) ?? 0) + (inChests.get(n) ?? 0) - (need.get(n) ?? 0)));
        }
        const avail = new Map(start);
        const steps: CraftStep[] = [];
        const cannot: string[] = [];
        for (const [n, c] of missing()) {
          const plan = planCraft(mcData, n, c, avail, 4);
          if (plan) steps.push(...plan);
          else cannot.push(`${n} x${c}`);
        }
        // 规划里用到、背包里多出来的又不够的原料，去箱子拿
        const used = new Map<string, number>();
        for (const [n, c] of inChests) {
          const consumed = (start.get(n) ?? 0) - (avail.get(n) ?? 0);
          const invSurplus = Math.max(0, (inv.get(n) ?? 0) - (need.get(n) ?? 0));
          const fromChest = Math.min(c, consumed - invSurplus);
          if (fromChest > 0) used.set(n, fromChest);
        }
        for (const ch of chests) {
          if (!used.size || stop) break;
          const wanted = new Map<string, number>();
          for (const [n, c] of used) {
            const here = Math.min(c, ch.items.get(n) ?? 0);
            if (here > 0) wanted.set(n, here);
          }
          if (!wanted.size) continue;
          try {
            const got = await takeFrom(ch.pos, wanted);
            for (const [n, c] of got) {
              add(taken, n, c);
              used.set(n, (used.get(n) ?? 0) - c);
              if ((used.get(n) ?? 0) <= 0) used.delete(n);
            }
            if (got.size) lines.push(`从 ${fmt(ch.pos)} 拿了合成原料：${listMap(got)}`);
          } catch (err) {
            lines.push(`${fmt(ch.pos)} 打不开：${(err as Error).message}`);
          }
        }
        // 按顺序合成；要工作台的先走到工作台旁边
        const tableId = mcData.blocksByName.crafting_table.id;
        for (const step of steps) {
          stop = handle.check();
          if (stop) break;
          if (step.table) {
            const table = bot.findBlocks({ matching: tableId, maxDistance: 32, count: 1 })[0];
            if (!table) {
              lines.push(`合成 ${step.item} 要工作台，32 格内没有放好的工作台`);
              break;
            }
            if (bot.entity.position.distanceTo(table.offset(0.5, 0.5, 0.5)) > 3.5) {
              try {
                await approach(bot, () => new goals.GoalNear(table.x, table.y, table.z, 2), 20000, handle);
              } catch (err) {
                lines.push(`走不到工作台 ${fmt(table)}：${(err as Error).message}`);
                break;
              }
            }
          }
          const before = inventoryCounts(bot).get(step.item) ?? 0;
          try {
            await factory.invoke('craft-item', { outputItem: step.item, amount: step.times });
          } catch (err) {
            lines.push(`合成 ${step.item} 失败：${(err as Error).message}`);
            break;
          }
          const made = (inventoryCounts(bot).get(step.item) ?? 0) - before;
          if (made > 0) add(crafted, step.item, made);
        }
        if (cannot.length) lines.push(`合成不出来（原料不够或没有配方，比如要烧的玻璃）：${cannot.join('，')}`);
      }

      const still = missing();
      const head = [
        `需要：${listMap(need)}`,
        taken.size ? `从箱子拿了：${listMap(taken)}` : '没从箱子拿东西',
        crafted.size ? `合成了：${listMap(crafted)}` : null,
        still.size ? `还缺：${listMap(still)}` : '材料都齐了，可以 build 了'
      ].filter(Boolean) as string[];
      if (stop) head.push(`提前停止：${stop}`);
      log('info', `prepare-materials: ${head.join(' | ')}`);
      return factory.createResponse([...head, ...lines].join('\n'));
    }
  );
}
