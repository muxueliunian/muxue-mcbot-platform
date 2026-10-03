// 图纸导入（import-schematic）：Sponge v2/v3、Litematica、原版结构 .nbt 转蓝图
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { flatWorld, createFakeBot } from './helpers/fake-bot.mjs';
import { createHarness, text, tempDir } from './helpers/harness.mjs';
import { decodeSchematic, readVarints, unpackLitematica } from '../dist/schematic.js';
import { loadBlueprint } from '../dist/blueprints.js';
import { isCompanionCell, extraCell, parseBlockSpec } from '../dist/block-state.js';

const nbt = createRequire(import.meta.url)('prismarine-nbt');

const savedEnv = process.env.MCBOT_DATA_DIR;
const dataDir = tempDir('mcbot-schematic-');
process.env.MCBOT_DATA_DIR = dataDir;
const schemDir = path.join(dataDir, 'schematics');
fs.mkdirSync(schemDir, { recursive: true });
after(() => {
  if (savedEnv === undefined) delete process.env.MCBOT_DATA_DIR;
  else process.env.MCBOT_DATA_DIR = savedEnv;
});

const tag = (type, value) => ({ type, value });
const I = (v) => tag('int', v);
const S = (v) => tag('string', v);
const C = (v) => tag('compound', v);
const L = (type, value) => tag('list', { type, value });
const point = (a) => C(Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, I(a[i])])));
const entry = (Name, Properties) => ({
  Name: S(Name),
  ...(Properties ? { Properties: C(Object.fromEntries(Object.entries(Properties).map(([k, v]) => [k, S(v)]))) } : {})
});

// 独立的逐 bit 打包，不复用解包代码
function pack(ids, bits) {
  const longs = Array(Math.ceil((ids.length * bits) / 64)).fill(0n);
  ids.forEach((id, i) => {
    for (let b = 0; b < bits; b++) if ((id >>> b) & 1) {
      const at = i * bits + b;
      longs[Math.floor(at / 64)] |= 1n << BigInt(at % 64);
    }
  });
  return longs.map((v) => [Number(BigInt.asIntN(32, v >> 32n)), Number(BigInt.asIntN(32, v))]);
}

function varint(n) {
  const out = [];
  do {
    let b = n & 127;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    out.push(b > 127 ? b - 256 : b);
  } while (n);
  return out;
}

function write(name, value, { rootName = '', gzip = true } = {}) {
  const bytes = nbt.writeUncompressed({ type: 'compound', name: rootName, value });
  fs.writeFileSync(path.join(schemDir, name), gzip ? gzipSync(bytes) : bytes);
}

// 3×2×1 的小图纸：y=0 石头、橡木门下半、双层云杉半砖；y=1 空气、门上半、水；另有一格模组方块
function spongeBlocks() {
  const palette = {
    'minecraft:air': 0, 'minecraft:stone': 1, 'minecraft:oak_door[facing=east,half=lower,hinge=left,open=false,powered=false]': 2,
    'minecraft:oak_door[facing=east,half=upper,hinge=left,open=false,powered=false]': 3,
    'minecraft:spruce_slab[type=double,waterlogged=false]': 130, 'minecraft:water[level=0]': 5, 'create:cogwheel': 6
  };
  // 顺序：x 最快，然后 z，然后 y
  const ids = [1, 2, 130, 6, 3, 5];
  return { palette: C(Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, I(v)]))), data: tag('byteArray', ids.flatMap(varint)) };
}

test('Sponge v3：门上半、双层半砖、水、模组方块分别处理；预检不保存，dryRun:false 才保存，尺寸保留', async () => {
  const { palette, data } = spongeBlocks();
  write('small.schem', { Schematic: C({ Version: I(3), DataVersion: I(3955), Width: tag('short', 3), Height: tag('short', 2), Length: tag('short', 1), Offset: tag('intArray', [-5, 60, 7]), Blocks: C({ Palette: palette, Data: data, BlockEntities: L('compound', [{ Id: S('minecraft:chest') }]) }) }) });
  const h = createHarness(createFakeBot(flatWorld()));

  assert.match(text(await h.call('import-schematic', {})), /small\.schem/);
  const dry = text(await h.call('import-schematic', { file: 'small.schem' }));
  assert.match(dry, /Sponge v3，DataVersion 3955，尺寸 3×2×1/);
  assert.match(dry, /门上半\/床头\/双格植物上半 1 格/);
  assert.match(dry, /模组方块 1 格（cogwheel|模组方块 1 格/);
  assert.match(dry, /没有对应物品.*1 格（water）/);
  assert.match(dry, /spruce_slab\[type=double\] → spruce_planks 1 格/);
  assert.match(dry, /方块附加数据 1 条/);
  assert.match(dry, /最后保留 3 格/);
  assert.match(dry, /这是预检，没保存/);
  assert.throws(() => loadBlueprint('小图纸'), /没有叫/);

  assert.match(text(await h.call('import-schematic', { file: 'small.schem', dryRun: false })), /保存要给 name/);
  const saved = text(await h.call('import-schematic', { file: 'small.schem', name: '小图纸', dryRun: false, attribution: '测试作者' }));
  assert.match(saved, /已保存蓝图「小图纸」/);
  const bp = loadBlueprint('小图纸');
  assert.deepEqual(bp.size, { x: 3, y: 2, z: 1 });
  assert.deepEqual(bp.blocks, [
    [0, 0, 0, 'stone'],
    [1, 0, 0, 'oak_door[facing=east,half=lower,hinge=left]'],
    [2, 0, 0, 'spruce_planks']
  ]);
  assert.match(bp.source, /Sponge v3.*作者 测试作者/);
  assert.match(text(await h.call('import-schematic', { file: 'small.schem', name: '小图纸', dryRun: false })), /已经有叫「小图纸」的蓝图/);

  // 导入的蓝图能直接预检建造
  const plan = text(await h.call('build', { blueprint: { name: '小图纸', origin: { x: 0, y: 64, z: 0 } }, dryRun: true }));
  assert.doesNotMatch(plan, /没有叫|不对/);
});

test('Sponge v2（根名 Schematic、未压缩）和 exclude', async () => {
  const { palette, data } = spongeBlocks();
  write('v2.schem', { Version: I(2), DataVersion: I(3955), Width: tag('short', 3), Height: tag('short', 2), Length: tag('short', 1), PaletteMax: I(131), Palette: palette, BlockData: data }, { rootName: 'Schematic', gzip: false });
  const h = createHarness(createFakeBot(flatWorld()));
  const r = text(await h.call('import-schematic', { file: 'v2.schem', exclude: ['stone'] }));
  assert.match(r, /Sponge v2/);
  assert.match(r, /按 exclude 去掉 1 格/);
  assert.match(r, /最后保留 2 格/);
});

test('Litematica：负尺寸、跨 long 的位、多个区域合并，冲突默认报错，onConflict 可选', async () => {
  const names = ['air', 'stone', 'oak_planks', 'glass', 'bricks'];
  // 5 项 → 3 位；第 21 格跨两个 long
  const ids = Array.from({ length: 24 }, (_, i) => i % 5);
  ids[21] = 3;
  const region = { Position: point([10, 3, -2]), Size: point([-24, 1, 1]), BlockStatePalette: L('compound', names.map((n) => entry('minecraft:' + n))), BlockStates: tag('longArray', pack(ids, 3)) };
  const other = { Position: point([12, 3, -2]), Size: point([1, 1, 1]), BlockStatePalette: L('compound', [entry('minecraft:stone')]), BlockStates: tag('longArray', [[0, 0]]) };
  write('two.litematic', { Version: I(6), MinecraftDataVersion: I(3955), Regions: C({ a: C(region), b: C(other) }) });
  const h = createHarness(createFakeBot(flatWorld()));
  const r = text(await h.call('import-schematic', { file: 'two.litematic', name: '两个区域', dryRun: false }));
  assert.match(r, /Litematica v6.*尺寸 26×1×1.*区域 a、b/);
  const bp = loadBlueprint('两个区域');
  const expected = ids.flatMap((id, x) => (id ? [[x, 0, 0, names[id]]] : []));
  expected.push([25, 0, 0, 'stone']);
  assert.deepEqual(bp.blocks, expected);

  // 只要区域 b
  assert.match(text(await h.call('import-schematic', { file: 'two.litematic', regionNames: ['b'] })), /尺寸 1×1×1.*\n.*\n最后保留 1 格|最后保留 1 格/);
  assert.match(text(await h.call('import-schematic', { file: 'two.litematic', regionNames: ['c'] })), /没有这些区域：c/);

  // 重叠且不同：报错；last 用后面的
  const overlap = { Position: point([10, 3, -2]), Size: point([1, 1, 1]), BlockStatePalette: L('compound', [entry('minecraft:glass')]), BlockStates: tag('longArray', [[0, 0]]) };
  const base = { Position: point([10, 3, -2]), Size: point([1, 1, 1]), BlockStatePalette: L('compound', [entry('minecraft:stone')]), BlockStates: tag('longArray', [[0, 0]]) };
  write('overlap.litematic', { Version: I(6), MinecraftDataVersion: I(3955), Regions: C({ a: C(base), b: C(overlap) }) });
  assert.match(text(await h.call('import-schematic', { file: 'overlap.litematic' })), /区域 a 和 b 在图纸坐标 \(0,0,0\)/);
  await h.call('import-schematic', { file: 'overlap.litematic', onConflict: 'last', name: '重叠', dryRun: false });
  assert.deepEqual(loadBlueprint('重叠').blocks, [[0, 0, 0, 'glass']]);
});

test('原版结构 .nbt：多套配色按 paletteIndex 选，structure_void 跳过，玫瑰丛上半和床头算伴生格', async () => {
  const p1 = [entry('minecraft:stone'), entry('minecraft:rose_bush', { half: 'lower' }), entry('minecraft:rose_bush', { half: 'upper' }),
    entry('minecraft:red_bed', { facing: 'east', part: 'head', occupied: 'false' }), entry('minecraft:structure_void')];
  const p0 = [entry('minecraft:bricks'), ...p1.slice(1)];
  const blocks = [[0, 0, 0, 0], [1, 0, 0, 1], [1, 1, 0, 2], [2, 0, 0, 3], [3, 0, 0, 4]];
  write('s.nbt', {
    DataVersion: I(3955), size: L('int', [4, 2, 1]),
    palettes: L('list', [{ type: 'compound', value: p0 }, { type: 'compound', value: p1 }]),
    blocks: L('compound', blocks.map(([x, y, z, s]) => ({ pos: L('int', [x, y, z]), state: I(s) }))),
    entities: L('compound', [])
  });
  const h = createHarness(createFakeBot(flatWorld()));
  const r = text(await h.call('import-schematic', { file: 's.nbt', paletteIndex: 1, name: '结构', dryRun: false }));
  assert.match(r, /2 套配色，用的是第 1 套/);
  assert.match(r, /structure_void.*1 格/);
  assert.match(r, /双格植物上半 2 格/);
  assert.deepEqual(loadBlueprint('结构').blocks, [[0, 0, 0, 'stone'], [1, 0, 0, 'rose_bush[half=lower]']]);
  assert.match(text(await h.call('import-schematic', { file: 's.nbt', paletteIndex: 2 })), /paletteIndex 只能是 0~1/);
});

test('坏文件和不支持的情况都给出说明', async () => {
  const h = createHarness(createFakeBot(flatWorld()));
  const call = async (args) => text(await h.call('import-schematic', args));
  assert.match(await call({ file: '../x.schem' }), /不能有 \.\./);
  assert.match(await call({ file: 'C:/x.schem' }), /只写 schematics 文件夹里的文件名/);
  assert.match(await call({ file: 'nope.schem' }), /没有 nope\.schem/);
  assert.match(await call({ file: 'a.txt' }), /只支持/);

  write('old.schem', { Schematic: C({ Version: I(3), DataVersion: I(1343), Width: tag('short', 1), Height: tag('short', 1), Length: tag('short', 1), Blocks: C({ Palette: C({ 'minecraft:stone': I(0) }), Data: tag('byteArray', [0]) }) }) });
  assert.match(await call({ file: 'old.schem' }), /1\.13 以前/);
  write('nov.schem', { Version: I(2), Width: tag('short', 1), Height: tag('short', 1), Length: tag('short', 1), Palette: C({ 'minecraft:stone': I(0) }), BlockData: tag('byteArray', [0]) }, { rootName: 'Schematic' });
  assert.match(await call({ file: 'nov.schem' }), /sourceDataVersion/);
  assert.match(await call({ file: 'nov.schem', sourceDataVersion: 3955 }), /最后保留 1 格/);
  write('mcedit.schematic', { Width: tag('short', 1), Height: tag('short', 1), Length: tag('short', 1), Materials: S('Alpha'), Blocks: tag('byteArray', [1]), Data: tag('byteArray', [0]) }, { rootName: 'Schematic' });
  assert.match(await call({ file: 'mcedit.schematic' }), /MCEdit 的旧格式/);
  write('short.schem', { Schematic: C({ Version: I(3), DataVersion: I(3955), Width: tag('short', 2), Height: tag('short', 1), Length: tag('short', 1), Blocks: C({ Palette: C({ 'minecraft:stone': I(0) }), Data: tag('byteArray', [0]) }) }) });
  assert.match(await call({ file: 'short.schem' }), /截断/);
  fs.writeFileSync(path.join(schemDir, 'junk.schem'), 'not nbt at all');
  assert.match(await call({ file: 'junk.schem' }), /没导入/);
});

test('解码细节：varint 边界、Litematica 位宽、结构和 Sponge 的校验', () => {
  assert.deepEqual(readVarints([0x82, 0x01, 5], 2), [130, 5]);
  assert.throws(() => readVarints([128], 1), /截断/);
  assert.throws(() => readVarints([0, 0], 1), /多出/);
  assert.throws(() => readVarints([255, 255, 255, 255, 8], 1), /超出范围/);
  assert.deepEqual(unpackLitematica(pack([8, 1, 0], 4), 3, 9, 'r'), [8, 1, 0]);
  assert.deepEqual(unpackLitematica(pack([0, 0, 0], 2), 3, 1, 'r'), [0, 0, 0]);
  assert.throws(() => unpackLitematica([], 1, 1, 'r'), /需要 1 个 long/);
  // 三个轴都是负尺寸
  const ids = Array.from({ length: 12 }, (_, i) => i % 5);
  const dec = decodeSchematic({ Version: 6, MinecraftDataVersion: 3955, Regions: { a: {
    Position: { x: 10, y: 20, z: 30 }, Size: { x: -2, y: -2, z: -3 },
    BlockStatePalette: ['air', 'stone', 'oak_planks', 'glass', 'bricks'].map((n) => ({ Name: 'minecraft:' + n })), BlockStates: pack(ids, 3)
  } } });
  assert.deepEqual(dec.size, [2, 2, 3]);
  assert.deepEqual(dec.cells.find((c) => c[0] === 1 && c[1] === 1 && c[2] === 2), [1, 1, 2, 'minecraft:stone']);
  assert.throws(() => decodeSchematic({ Version: 2, Width: 1, Height: 1, Length: 1, Palette: { 'minecraft:air': 0 }, BlockData: [2] }), /没有的编号 2/);
  assert.throws(() => decodeSchematic({ Version: 2, Width: 0, Height: 1, Length: 1, Palette: {}, BlockData: [] }), /尺寸不对/);
  assert.throws(() => decodeSchematic({ foo: 1 }), /认不出图纸格式/);
});

test('双格植物：上半是伴生格，放下半时上面一格会被占', () => {
  assert.equal(isCompanionCell(parseBlockSpec('lilac[half=upper]')), true);
  assert.equal(isCompanionCell(parseBlockSpec('lilac[half=lower]')), false);
  assert.equal(isCompanionCell(parseBlockSpec('oak_stairs[half=top]')), false);
  assert.deepEqual(extraCell(parseBlockSpec('tall_grass[half=lower]')).toArray(), [0, 1, 0]);
});
