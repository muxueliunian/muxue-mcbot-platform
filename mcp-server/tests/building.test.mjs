// build 的方块状态（朝向、上下半、轴、门轴、床、墙上火把）、坡屋顶、垫高、蓝图、预览、备料
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import minecraftData from 'minecraft-data';
import { flatWorld, createFakeBot, attachTeleportKinematics, attachGravity, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, callsOf, tempDir } from './helpers/harness.mjs';
import { parseBlockSpec, validateSpec, rotateSpec, rotatePos, placementPlan } from '../dist/block-state.js';
import { roofCells, lineCells, placeBlueprint, makeBlueprint } from '../dist/blueprints.js';
import { planCraft } from '../dist/tools/blueprint-tools.js';

const mcData = minecraftData('1.21.1');
const exists = (n) => Boolean(mcData.blocksByName[n]);
const savedEnv = { MC_SERVER_DIR: process.env.MC_SERVER_DIR, MCBOT_DATA_DIR: process.env.MCBOT_DATA_DIR };
process.env.MCBOT_DATA_DIR = tempDir('mcbot-bp-');
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function props(w, x, y, z) {
  return w.get(x, y, z).getProperties();
}

function withBody(bot) {
  const stops = [attachTeleportKinematics(bot), attachGravity(bot)];
  return () => stops.forEach((s) => s());
}

// ---- 纯函数 ----

test('方块写法：解析、校验属性、双层半砖和没有物品的方块会被拒绝', () => {
  assert.deepEqual(parseBlockSpec('minecraft:Oak_Stairs[facing=east, half=top]'), { name: 'oak_stairs', props: { facing: 'east', half: 'top' } });
  assert.deepEqual(parseBlockSpec('stone'), { name: 'stone', props: {} });
  assert.throws(() => parseBlockSpec('oak_stairs[facing]'), /写法不对/);
  assert.equal(validateSpec(parseBlockSpec('oak_stairs[facing=east]'), mcData), null);
  assert.match(validateSpec(parseBlockSpec('oak_stairs[facing=up]'), mcData), /只能是/);
  assert.match(validateSpec(parseBlockSpec('oak_stairs[axis=x]'), mcData), /没有 axis/);
  assert.equal(validateSpec(parseBlockSpec('candle[candles=4]'), mcData), null);
  assert.match(validateSpec(parseBlockSpec('candle[candles=0]'), mcData), /只能是/);
  assert.equal(validateSpec(parseBlockSpec('snow[layers=8]'), mcData), null);
  assert.match(validateSpec(parseBlockSpec('oak_slab[type=double]'), mcData), /双层半砖/);
  assert.match(validateSpec(parseBlockSpec('water'), mcData), /没有对应的物品/);
  assert.equal(validateSpec(parseBlockSpec('wall_torch[facing=north]'), mcData), null);
});

test('旋转：朝向、轴、坐标一起转', () => {
  assert.deepEqual(rotateSpec(parseBlockSpec('oak_stairs[facing=east]'), 90).props.facing, 'south');
  assert.deepEqual(rotateSpec(parseBlockSpec('oak_stairs[facing=east]'), 270).props.facing, 'north');
  assert.equal(rotateSpec(parseBlockSpec('oak_log[axis=x]'), 90).props.axis, 'z');
  assert.equal(rotateSpec(parseBlockSpec('oak_log[axis=y]'), 90).props.axis, 'y');
  const size = new Vec3(3, 1, 2); // x 0..2, z 0..1
  assert.deepEqual(rotatePos(new Vec3(2, 0, 0), 90, size), new Vec3(1, 0, 2));
  assert.deepEqual(rotatePos(new Vec3(2, 0, 0), 180, size), new Vec3(0, 0, 1));
  assert.deepEqual(rotatePos(new Vec3(2, 0, 0), 270, size), new Vec3(0, 0, 0));
  // 转完的门还是朝着转过去的方向
  const bp = makeBlueprint('t', '', [{ pos: new Vec3(0, 0, 0), block: 'oak_stairs[facing=east]' }, { pos: new Vec3(2, 0, 1), block: 'stone' }], 't');
  const cells = placeBlueprint(bp, { x: 10, y: 64, z: 10 }, 90);
  assert.deepEqual(cells.map((c) => [c.pos.x, c.pos.y, c.pos.z, c.block]).sort(), [[10, 64, 12, 'stone'], [11, 64, 10, 'oak_stairs[facing=south]']].sort());
});

test('放置规则：楼梯上半要点下面或侧面上半，原木轴看点的面，火把只能贴墙', () => {
  const top = placementPlan(parseBlockSpec('oak_stairs[facing=west,half=top]'));
  assert.deepEqual(top.options.map((o) => [o.faces.join('/'), o.horizontal, o.hitY]), [['down', 'west', undefined], ['north/south/west/east', 'west', 'high']]);
  assert.deepEqual(placementPlan(parseBlockSpec('oak_log[axis=z]')).options[0].faces, ['north', 'south']);
  assert.deepEqual(placementPlan(parseBlockSpec('wall_torch[facing=east]')).options[0].faces, ['east']);
  assert.equal(placementPlan(parseBlockSpec('chest[facing=north]')).options[0].horizontal, 'south');
});

test('形状：直线、坡屋顶（奇数宽度有屋脊，山墙填满，楼梯朝屋脊）', () => {
  assert.deepEqual(lineCells({ x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 0 }).map((p) => `${p.x},${p.y}`), ['0,0', '1,1', '2,2', '3,3']);
  // x 0..4（5 宽）、z 0..6：长边是 z，屋脊沿 z，两边的坡朝东 / 西
  const cells = roofCells({ shape: 'roof', from: { x: 0, y: 70, z: 0 }, to: { x: 4, y: 70, z: 6 }, block: 'oak_stairs' }, exists);
  const at = (x, y, z) => cells.filter((c) => c.pos.x === x && c.pos.y === y && c.pos.z === z).map((c) => c.block);
  assert.deepEqual(at(0, 70, 3), ['oak_stairs[facing=east,half=bottom]']);
  assert.deepEqual(at(4, 70, 3), ['oak_stairs[facing=west,half=bottom]']);
  assert.deepEqual(at(1, 71, 3), ['oak_stairs[facing=east,half=bottom]']);
  assert.deepEqual(at(2, 72, 3), ['oak_slab[type=bottom]']);
  assert.deepEqual(at(2, 70, 0), ['oak_planks']); // 山墙
  assert.deepEqual(at(2, 70, 3), []); // 屋里是空的
  assert.equal(cells.length, 14 + 6 + 14 + 2 + 7);
  const none = roofCells({ shape: 'roof', from: { x: 0, y: 70, z: 0 }, to: { x: 3, y: 70, z: 1 }, block: 'stone_brick_stairs', gableBlock: 'none' }, exists);
  assert.ok(none.every((c) => c.block.startsWith('stone_brick_stairs')));
  assert.equal(none.length, 8);
  assert.throws(() => roofCells({ shape: 'roof', from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 2 }, block: 'oak_planks' }, exists), /楼梯/);
});

test('合成规划：原木 → 木板 → 楼梯；不会把缺的东西算成有', () => {
  const avail = new Map([['oak_log', 3]]);
  const steps = planCraft(mcData, 'oak_stairs', 8, avail, 4);
  assert.deepEqual(steps.map((s) => [s.item, s.times, s.table]), [['oak_planks', 3], ['oak_stairs', 2]].map(([i, t]) => [i, t, i === 'oak_stairs']));
  assert.equal(avail.get('oak_log'), 0);
  assert.equal(planCraft(mcData, 'oak_stairs', 8, new Map([['oak_log', 1]]), 4), null);
  assert.deepEqual(planCraft(mcData, 'glass', 1, new Map([['sand', 5]]), 4), null); // 要烧，合成不出来
});

// ---- build ----

const KIT = [['oak_stairs', 16], ['oak_slab', 8], ['oak_log', 8], ['oak_trapdoor', 4], ['oak_door', 4], ['white_bed', 2], ['torch', 8], ['stone', 32], ['calibrated_sculk_sensor', 2], ['stone_pickaxe', 1], ['stone_axe', 1]];

test('build：楼梯朝向和上下半、半砖上半、原木横放、活板门都按要求放', async () => {
  const w = flatWorld();
  w.set(3, 64, 2, 'stone');
  w.set(3, 64, 4, 'stone');
  w.set(3, 64, -2, 'stone');
  w.set(3, 64, -4, 'stone');
  const bot = createFakeBot(w, { inventory: KIT });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', {
      blocks: [
        { x: 1, y: 64, z: 0, block: 'oak_stairs[facing=east,half=bottom]' },
        { x: 2, y: 64, z: 2, block: 'oak_stairs[facing=north,half=top]' },
        { x: 2, y: 64, z: 4, block: 'oak_log[axis=x]' },
        { x: 2, y: 64, z: -2, block: 'oak_slab[type=top]' },
        { x: 2, y: 64, z: -4, block: 'oak_trapdoor[facing=west,half=top]' }
      ],
      timeoutSeconds: 30
    });
  } finally {
    stop();
  }
  assert.match(text(r), /放置 5 个/);
  assert.doesNotMatch(text(r), /未完成|状态不对/);
  assert.deepEqual([props(w, 1, 64, 0).facing, props(w, 1, 64, 0).half], ['east', 'bottom']);
  assert.deepEqual([props(w, 2, 64, 2).facing, props(w, 2, 64, 2).half], ['north', 'top']);
  assert.equal(props(w, 2, 64, 4).axis, 'x');
  assert.equal(props(w, 2, 64, -2).type, 'top');
  assert.deepEqual([props(w, 2, 64, -4).facing, props(w, 2, 64, -4).half], ['west', 'top']);
  // 再调用一次：都已经符合
  const again = await h.call('build', { blocks: [{ x: 1, y: 64, z: 0, block: 'oak_stairs[facing=east,half=bottom]' }] });
  assert.match(text(again), /原本就符合 1 个/);
});

test('build：门轴 left / right 都放得对，上半自动出现；床头在朝向那边；墙上火把贴墙', async () => {
  const w = flatWorld();
  // 东西向的墙，门洞在 (5,64,1)，门朝东
  for (const z of [0, 2]) w.fill(5, 64, z, 5, 65, z, 'stone');
  w.fill(8, 64, 0, 8, 65, 0, 'stone');
  const bot = createFakeBot(w, { inventory: KIT });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', {
      blocks: [
        { x: 5, y: 64, z: 1, block: 'oak_door[facing=east,hinge=right]' },
        { x: 5, y: 65, z: 1, block: 'oak_door[facing=east,half=upper,hinge=right]' },
        { x: 1, y: 64, z: 6, block: 'white_bed[facing=south]' },
        { x: 7, y: 65, z: 0, block: 'wall_torch[facing=west]' }
      ],
      timeoutSeconds: 30
    });
  } finally {
    stop();
  }
  assert.match(text(r), /放置 3 个/, text(r));
  assert.match(text(r), /另有 1 格门上半/, text(r));
  assert.deepEqual([props(w, 5, 64, 1).facing, props(w, 5, 64, 1).hinge, props(w, 5, 65, 1).half], ['east', 'right', 'upper']);
  assert.deepEqual([w.name(1, 64, 7), props(w, 1, 64, 7).part], ['white_bed', 'head']);
  assert.deepEqual([w.name(7, 65, 0), props(w, 7, 65, 0).facing], ['wall_torch', 'west']);
  assert.equal(bot.countOf('torch'), 7);

  // 换成 left：状态不对的门默认不拆（门是功能性方块），允许后拆掉重放
  const denied = await h.call('build', { blocks: [{ x: 5, y: 64, z: 1, block: 'oak_door[facing=east,hinge=left]' }] });
  assert.match(text(denied), /功能性方块/);
  const stop2 = withBody(bot);
  try {
    r = await h.call('build', { blocks: [{ x: 5, y: 64, z: 1, block: 'oak_door[facing=east,hinge=left]' }], allowProtected: true, timeoutSeconds: 30 });
  } finally {
    stop2();
  }
  assert.equal(props(w, 5, 64, 1).hinge, 'left', text(r));
});

test('build：朝向错的楼梯会拆掉重放；规则没把握的方块放错了会学到偏差再放一次', async () => {
  const w = flatWorld();
  w.set(2, 64, 0, 'oak_stairs', { facing: 'west' });
  const bot = createFakeBot(w, { inventory: KIT });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', {
      blocks: [
        { x: 2, y: 64, z: 0, block: 'oak_stairs[facing=east]' },
        { x: 2, y: 64, z: 3, block: 'calibrated_sculk_sensor[facing=north]' }
      ],
      timeoutSeconds: 30
    });
  } finally {
    stop();
  }
  assert.equal(props(w, 2, 64, 0).facing, 'east');
  assert.equal(props(w, 2, 64, 3).facing, 'north', text(r));
  assert.equal(callsOf(bot, 'dig').filter((c) => c.pos.z === 3).length, 1);
  assert.doesNotMatch(text(r), /状态不对/);
});

test('build：坡屋顶 + 够不着的地方垫高，放完垫的方块都挖掉；泥土优先拿来垫，不动要用的圆石', async () => {
  const w = flatWorld();
  w.fill(0, 64, 0, 4, 66, 4, 'cobblestone');
  w.fill(1, 64, 1, 3, 66, 3, 'air');
  const bot = createFakeBot(w, { position: new Vec3(-2.5, 64, 2.5), inventory: [['oak_stairs', 24], ['oak_slab', 8], ['oak_planks', 8], ['dirt', 16], ['cobblestone', 8]] });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', { shapes: [{ shape: 'roof', from: { x: 0, y: 67, z: 0 }, to: { x: 4, y: 67, z: 4 }, block: 'oak_stairs' }], timeoutSeconds: 120 });
  } finally {
    stop();
  }
  const out = text(r);
  // 屋脊沿 x：北坡朝南、南坡朝北，第三层中间是半砖
  for (let x = 0; x <= 4; x++) {
    assert.deepEqual([w.name(x, 67, 0), props(w, x, 67, 0).facing], ['oak_stairs', 'south'], out);
    assert.deepEqual([w.name(x, 67, 4), props(w, x, 67, 4).facing], ['oak_stairs', 'north'], out);
    assert.equal(w.name(x, 69, 2), 'oak_slab', out);
  }
  // 一般要垫高；机器忙的时候寻路时机不同，也可能站在先放好的屋顶上就够着了
  assert.match(out, /垫高 \d+ 次|放置 33 个/);
  // 没留下垫脚的方块
  for (let x = -4; x <= 8; x++) for (let z = -4; z <= 8; z++) for (let y = 64; y <= 72; y++) assert.notEqual(w.name(x, y, z), 'dirt', `${x},${y},${z}`);
  const placedCobble = callsOf(bot, 'place').filter((c) => c.name === 'cobblestone');
  assert.equal(placedCobble.length, 0);
});

test('build：没开 scaffold 时够不着的直接报告', async () => {
  const w = flatWorld();
  w.fill(5, 64, 0, 5, 70, 0, 'stone');
  const bot = createFakeBot(w, { inventory: [['oak_planks', 4], ['dirt', 8]] });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', { blocks: [{ x: 5, y: 71, z: 0, block: 'oak_planks' }], scaffold: false, timeoutSeconds: 30 });
  } finally {
    stop();
  }
  assert.match(text(r), /够不着/);
  assert.equal(w.name(5, 71, 0), 'air');
});

test('build：远处地上的草（没有形状，射线打不中）也能走过去清掉再放', async () => {
  const w = flatWorld();
  for (let z = 0; z <= 3; z++) w.set(9, 64, z, 'short_grass');
  const bot = createFakeBot(w, { inventory: [['oak_planks', 8]] });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', { shapes: [{ shape: 'fill', block: 'oak_planks', from: { x: 9, y: 64, z: 0 }, to: { x: 9, y: 64, z: 3 } }], timeoutSeconds: 60 });
  } finally {
    stop();
  }
  for (let z = 0; z <= 3; z++) assert.equal(w.name(9, 64, z), 'oak_planks', `${text(r)}`);
});

test('build：写法错误、只写门上半、门上方被占都有清楚的说明', async () => {
  const w = flatWorld();
  w.set(2, 65, 0, 'stone');
  const bot = createFakeBot(w, { inventory: KIT });
  const h = createHarness(bot);
  assert.match(text(await h.call('build', { blocks: [{ x: 1, y: 64, z: 0, block: 'oak_stairs[facing=up]' }] })), /只能是/);
  assert.match(text(await h.call('build', { blocks: [{ x: 1, y: 65, z: 0, block: 'oak_door[half=upper]' }] })), /门请写下半/);
  assert.match(text(await h.call('build', { blocks: [{ x: 2, y: 64, z: 0, block: 'oak_door[facing=east]' }], dryRun: true })), /被 stone 占着/);
});

// ---- 蓝图 ----

test('蓝图：手写保存、列出、转 90° 放下；从世界框下来时门只记下半', async () => {
  const w = flatWorld();
  const bot = createFakeBot(w, { inventory: KIT });
  const h = createHarness(bot);
  const saved = await h.call('save-blueprint', {
    name: '小棚子',
    description: '测试',
    blocks: [{ x: 5, y: 0, z: 5, block: 'oak_stairs[facing=east]' }, { x: 6, y: 0, z: 5, block: 'stone' }]
  });
  assert.match(text(saved), /已保存蓝图「小棚子」：2 格，尺寸 2×1×1/);
  assert.match(text(await h.call('save-blueprint', { name: '小棚子', blocks: [{ x: 0, y: 0, z: 0, block: 'stone' }] })), /已经有叫/);
  assert.match(text(await h.call('list-blueprints', {})), /小棚子：2×1×1/);
  assert.match(text(await h.call('list-blueprints', { name: '小棚子' })), /oak_stairs x1/);

  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', { blueprint: { name: '小棚子', origin: { x: 3, y: 64, z: 3 }, rotation: 90 }, timeoutSeconds: 30 });
  } finally {
    stop();
  }
  assert.match(text(r), /放置 2 个/, text(r));
  assert.deepEqual([w.name(3, 64, 3), props(w, 3, 64, 3).facing], ['oak_stairs', 'south']);
  assert.equal(w.name(3, 64, 4), 'stone');

  // 框下来
  w.set(10, 64, 0, 'oak_door', { facing: 'north', half: 'lower', hinge: 'left' });
  w.set(10, 65, 0, 'oak_door', { facing: 'north', half: 'upper', hinge: 'left' });
  w.set(11, 64, 0, 'oak_log', { axis: 'z' });
  const cap = await h.call('save-blueprint', { name: 'door-copy', capture: { from: { x: 10, y: 64, z: 0 }, to: { x: 11, y: 65, z: 0 } } });
  assert.match(text(cap), /2 格，尺寸 2×1×1/, text(cap));
  const detail = text(await h.call('list-blueprints', { name: 'door-copy' }));
  assert.match(detail, /oak_door\[facing=north,half=lower,hinge=left\] x1/);
  assert.match(detail, /oak_log\[axis=z\] x1/);
  assert.match(text(await h.call('delete-blueprint', { name: 'door-copy' })), /已删除/);
  assert.match(text(await h.call('build', { blueprint: { name: 'door-copy', origin: { x: 0, y: 64, z: 0 } } })), /没有叫「door-copy」的蓝图/);
});

// ---- 预览 ----

function rconPacket(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
}

async function fakeRcon(password) {
  const commands = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('utf8', 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (type === 3) socket.write(rconPacket(body === password ? id : -1, 2, ''));
        else if (type === 2) {
          commands.push(body);
          socket.write(rconPacket(id, 0, ''));
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, commands, close: () => new Promise((r) => server.close(r)) };
}

test('预览：用 RCON 摆发光虚影（带方块状态），要清掉的摆红玻璃；真正开工前自动清掉预览', async () => {
  const rcon = await fakeRcon('pw');
  const dir = tempDir('mcbot-server-');
  fs.writeFileSync(path.join(dir, 'server.properties'), `enable-rcon=true\nrcon.port=${rcon.port}\nrcon.password=pw\n`);
  process.env.MC_SERVER_DIR = dir;
  try {
    const w = flatWorld();
    w.set(3, 64, 0, 'dirt');
    const bot = createFakeBot(w, { inventory: KIT });
    const h = createHarness(bot);
    const r = await h.call('build', {
      blocks: [{ x: 1, y: 64, z: 0, block: 'oak_stairs[facing=east]' }, { x: 3, y: 64, z: 0, block: 'air' }],
      preview: true
    });
    assert.match(text(r), /预览/);
    assert.match(text(r), /1 个发光的虚影方块.*1 个红玻璃框/);
    assert.equal(callsOf(bot, 'place').length + callsOf(bot, 'dig').length, 0);
    assert.match(rcon.commands[0], /^kill @e\[type=minecraft:block_display,tag=mcbot_preview\]$/);
    assert.match(rcon.commands[1], /^execute in minecraft:overworld run summon minecraft:block_display 1 64 0 \{block_state:\{Name:"minecraft:oak_stairs",Properties:\{facing:"east"\}\}/);
    assert.match(rcon.commands[2], /summon minecraft:block_display 3 64 0 .*red_stained_glass/);

    const stop = withBody(bot);
    try {
      await h.call('build', { blocks: [{ x: 1, y: 64, z: 0, block: 'oak_stairs[facing=east]' }], timeoutSeconds: 30 });
    } finally {
      stop();
    }
    assert.match(rcon.commands.at(-1), /^kill @e\[type=minecraft:block_display/);
    assert.match(text(await h.call('clear-preview', {})), /已清掉/);
  } finally {
    await rcon.close();
  }
});

// ---- 备料 ----

test('备料：从附近箱子只拿缺的数量；已经放好的不算', async () => {
  const w = flatWorld();
  w.set(3, 64, 3, 'chest');
  w.containers = new Map([['3,64,3', [{ name: 'oak_stairs', count: 20 }, { name: 'cobblestone', count: 64 }]]]);
  w.set(0, 64, 5, 'oak_stairs', { facing: 'east' });
  const bot = createFakeBot(w, { inventory: [['oak_stairs', 2]] });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('prepare-materials', {
      shapes: [{ shape: 'line', from: { x: 0, y: 64, z: 5 }, to: { x: 7, y: 64, z: 5 }, block: 'oak_stairs[facing=east]' }],
      craft: false
    });
  } finally {
    stop();
  }
  assert.match(text(r), /需要：oak_stairs x7/, text(r));
  assert.match(text(r), /从箱子拿了：oak_stairs x5/);
  assert.match(text(r), /材料都齐了/);
  assert.equal(bot.countOf('oak_stairs'), 7);
  assert.deepEqual(w.containers.get('3,64,3').find((s) => s.name === 'oak_stairs').count, 15);
});

test('创造模式：不报材料不足，身上没有的材料开工时从创造物品栏拿', async () => {
  const w = flatWorld();
  const bot = createFakeBot(w, { inventory: [['dirt', 1]] });
  bot.game.gameMode = 'creative';
  const taken = [];
  bot.creative = {
    setInventorySlot: async (slot, item) => {
      taken.push(item.name);
      item.slot = slot;
      bot.inventory.slots[slot] = item;
    }
  };
  const h = createHarness(bot);
  const dry = text(await h.call('build', { blocks: [{ x: 2, y: 64, z: 0, block: 'quartz_block' }, { x: 3, y: 64, z: 0, block: 'quartz_stairs[facing=east]' }], dryRun: true }));
  assert.doesNotMatch(dry, /材料不足/);
  assert.match(dry, /创造模式/);
  const stop = withBody(bot);
  let r;
  try {
    r = text(await h.call('build', { blocks: [{ x: 2, y: 64, z: 0, block: 'quartz_block' }, { x: 3, y: 64, z: 0, block: 'quartz_stairs[facing=east]' }], timeoutSeconds: 30 }));
  } finally {
    stop();
  }
  assert.match(r, /放置 2 个/, r);
  assert.deepEqual(taken.sort(), ['quartz_block', 'quartz_stairs']);
  assert.equal(props(w, 3, 64, 0).facing, 'east');
  const prep = text(await h.call('prepare-materials', { items: [{ name: 'glass_pane', count: 10 }] }));
  assert.match(prep, /从创造物品栏拿了：glass_pane/);
});

test('build：要放的格子就是自己站的地方，先挪开再放', async () => {
  const w = flatWorld();
  const bot = createFakeBot(w, { inventory: [['stone', 4]] });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', { blocks: [{ x: 0, y: 64, z: 0, block: 'stone' }, { x: 0, y: 65, z: 1, block: 'stone' }], scaffold: false, timeoutSeconds: 30 });
  } finally {
    stop();
  }
  assert.equal(w.name(0, 64, 0), 'stone', text(r));
  assert.doesNotMatch(text(r), /挪不开/);
});

test('build：两边都空着的上半砖，旁边临时垫一块泥土当支撑，放好再挖掉', async () => {
  const w = flatWorld();
  const bot = createFakeBot(w, { inventory: [['quartz_slab', 3], ['dirt', 4]] });
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', { shapes: [{ shape: 'line', block: 'quartz_slab[type=top]', from: { x: 3, y: 64, z: 2 }, to: { x: 5, y: 64, z: 2 } }], timeoutSeconds: 60 });
  } finally {
    stop();
  }
  for (let x = 3; x <= 5; x++) assert.deepEqual([w.name(x, 64, 2), props(w, x, 64, 2).type], ['quartz_slab', 'top'], text(r));
  assert.match(text(r), /临时放了一块当支撑/);
  for (let x = 1; x <= 7; x++) for (let z = 0; z <= 4; z++) for (let y = 64; y <= 65; y++) assert.notEqual(w.name(x, y, z), 'dirt', `${x},${y},${z}`);
});

test('build：创造模式够不着的高处飞过去放，放完落地', async () => {
  const w = flatWorld();
  w.fill(6, 64, 0, 6, 69, 0, 'stone');
  const bot = createFakeBot(w, { inventory: [['oak_planks', 4]] });
  bot.game.gameMode = 'creative';
  const h = createHarness(bot);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', { blocks: [{ x: 6, y: 70, z: 0, block: 'oak_planks' }, { x: 6, y: 71, z: 0, block: 'oak_planks' }], timeoutSeconds: 60 });
  } finally {
    stop();
  }
  assert.equal(w.name(6, 70, 0), 'oak_planks', text(r));
  assert.equal(w.name(6, 71, 0), 'oak_planks', text(r));
  assert.match(text(r), /飞上去 1 次（放或挖够不着的高处），已经落地/);
  assert.equal(bot.physics.gravity, 0.08);
  assert.equal(bot.entity.position.y, 64);
});

test('灯笼：equip-item 写 lantern 拿的是灯笼不是海晶灯；build 能把灯笼立在玻璃板顶上', async () => {
  const w = flatWorld();
  w.set(2, 64, 0, 'glass_pane');
  const bot = createFakeBot(w, { inventory: [['sea_lantern', 4], ['lantern', 4], ['glass_pane', 4]] });
  const h = createHarness(bot);
  assert.match(text(await h.call('equip-item', { itemName: 'lantern' })), /Equipped lantern to hand/);
  assert.match(text(await h.call('equip-item', { itemName: 'minecraft:sea_lantern' })), /Equipped sea_lantern/);
  assert.match(text(await h.call('equip-item', { itemName: 'pane' })), /Equipped glass_pane/);
  const stop = withBody(bot);
  let r;
  try {
    r = await h.call('build', { blocks: [{ x: 2, y: 65, z: 0, block: 'lantern[hanging=false]' }], timeoutSeconds: 30 });
  } finally {
    stop();
  }
  assert.match(text(r), /放置 1 个/, text(r));
  assert.deepEqual([w.name(2, 65, 0), props(w, 2, 65, 0).hanging], ['lantern', false]);
});

test('build：清除够不着的高处方块时，生存模式垫高挖、挖完把垫的挖回来；创造模式飞上去挖', async () => {
  for (const mode of ['survival', 'creative']) {
    const w = flatWorld();
    w.set(6, 70, 0, 'stone');
    w.set(6, 71, 0, 'oak_leaves');
    const bot = createFakeBot(w, { inventory: [['dirt', 16], ['stone_pickaxe', 1]] });
    bot.game.gameMode = mode;
    const h = createHarness(bot);
    const stop = withBody(bot);
    let r;
    try {
      r = await h.call('build', { shapes: [{ shape: 'fill', from: { x: 6, y: 70, z: 0 }, to: { x: 6, y: 71, z: 0 }, block: 'air' }], replace: 'all', timeoutSeconds: 90 });
    } finally {
      stop();
    }
    const out = text(r);
    assert.equal(w.name(6, 70, 0), 'air', `${mode}\n${out}`);
    assert.equal(w.name(6, 71, 0), 'air', `${mode}\n${out}`);
    assert.match(out, /清除 2 个/, out);
    assert.match(out, mode === 'creative' ? /飞上去 1 次/ : /垫高 1 次/, out);
    for (let x = 0; x <= 12; x++) for (let z = -6; z <= 6; z++) for (let y = 64; y <= 72; y++) assert.notEqual(w.name(x, y, z), 'dirt', `${mode} ${x},${y},${z}`);
  }
});
