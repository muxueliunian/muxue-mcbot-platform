// 离线测试用的假 Bot：真实 1.21.1 方块数据 + prismarine-world 内存世界 + 真实 mineflayer-pathfinder 插件
// 不连接任何服务器。底层动作（dig/_genericPlace/activateBlock…）只记录调用并直接改内存世界
import { EventEmitter } from 'node:events';
import prismarineRegistry from 'prismarine-registry';
import prismarineWorld from 'prismarine-world';
import prismarineChunk from 'prismarine-chunk';
import prismarineItem from 'prismarine-item';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

export const VERSION = '1.21.1';
export const registry = prismarineRegistry(VERSION);
const World = prismarineWorld(registry);
const Chunk = prismarineChunk(registry);
const Item = prismarineItem(registry);
const { pathfinder, Movements, goals } = pathfinderPkg;

export { Vec3, goals, Movements };

export function stateOf(name, props) {
  const b = registry.blocksByName[name];
  if (!b) throw new Error(`unknown block ${name}`);
  if (!props) return b.defaultState;
  // 按属性计算 stateId
  let offset = 0;
  let mul = 1;
  for (const s of [...b.states].reverse()) {
    const values = s.type === 'bool' ? ['true', 'false'] : s.type === 'int' ? Array.from({ length: s.num_values }, (_, i) => String(i)) : s.values;
    const want = props[s.name];
    const idx = want === undefined
      ? values.indexOf(String(defaultProp(b, s.name)))
      : values.indexOf(String(want));
    if (idx < 0) throw new Error(`bad prop ${s.name}=${want} for ${name}`);
    offset += idx * mul;
    mul *= values.length;
  }
  return b.minStateId + offset;
}

function defaultProp(b, propName) {
  // 从 defaultState 反推默认属性
  let rest = b.defaultState - b.minStateId;
  const states = [...b.states].reverse();
  for (const s of states) {
    const len = s.type === 'bool' ? 2 : s.type === 'int' ? s.num_values : s.values.length;
    const idx = rest % len;
    rest = Math.floor(rest / len);
    if (s.name === propName) {
      const values = s.type === 'bool' ? ['true', 'false'] : s.type === 'int' ? Array.from({ length: len }, (_, i) => String(i)) : s.values;
      return values[idx];
    }
  }
  return undefined;
}

export class FakeWorld {
  constructor({ chunks = [[-1, -1], [-1, 0], [0, -1], [0, 0]] } = {}) {
    this.world = new World(null, null, 0).sync;
    for (const [cx, cz] of chunks) {
      this.world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
    }
  }

  set(x, y, z, name, props) {
    this.world.setBlockStateId(new Vec3(x, y, z), stateOf(name, props));
  }

  fill(x1, y1, z1, x2, y2, z2, name, props) {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
          this.set(x, y, z, name, props);
        }
      }
    }
  }

  get(x, y, z) {
    return this.world.getBlock(new Vec3(x, y, z));
  }

  name(x, y, z) {
    return this.get(x, y, z)?.name ?? null;
  }

  // 直接记录一片区域的实际 stateId，用于前后对比
  snapshot(x1, y1, z1, x2, y2, z2) {
    const out = [];
    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        for (let z = z1; z <= z2; z++) {
          out.push(`${x},${y},${z}=${this.get(x, y, z)?.stateId ?? 'unloaded'}`);
        }
      }
    }
    return out;
  }
}

// 地面：y 60~63 实心石头，站立高度 y=64
export function flatWorld(opts) {
  const w = new FakeWorld(opts);
  w.fill(-16, 60, -16, 15, 63, 15, 'stone');
  return w;
}

export function createFakeBot(fw, { position = new Vec3(0.5, 64, 0.5), inventory = [], dimension = 'overworld', withPathfinder = true } = {}) {
  const bot = new EventEmitter();
  bot.setMaxListeners(100);
  bot.version = VERSION;
  bot.registry = registry;
  bot.username = 'Claude';
  bot.world = fw.world;
  bot.game = { dimension, gameMode: 'survival', minY: -64, height: 384 };
  bot.calls = [];
  bot.entity = {
    position: position.clone(),
    velocity: new Vec3(0, 0, 0),
    onGround: true,
    height: 1.8,
    eyeHeight: 1.62,
    yaw: 0,
    pitch: 0,
    effects: {},
    attributes: {},
    isInWater: false,
    isInLava: false,
    isInWeb: false,
  };
  bot.entities = {};
  bot.players = {};
  bot.health = 20;
  bot.food = 20;
  bot.foodSaturation = 5;
  bot.experience = { level: 0 };
  bot.time = { timeOfDay: 1000 };
  bot.isRaining = false;
  bot.isSleeping = false;
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  bot.physics = { simulatePlayer: () => {} };
  bot.jumpTicks = 0;
  bot.jumpQueued = false;
  bot.fireworkRocketDuration = 0;
  bot.targetDigBlock = null;
  bot.usingHeldItem = false;

  const slots = new Array(46).fill(null);
  // 先放快捷栏 36..44，再放主背包 9..35
  const order = [...Array.from({ length: 9 }, (_, i) => 36 + i), ...Array.from({ length: 27 }, (_, i) => 9 + i)];
  inventory.forEach(([name, count], i) => {
    const slot = order[i];
    if (slot === undefined) throw new Error('测试背包超过 36 格');
    slots[slot] = new Item(registry.itemsByName[name].id, count);
    slots[slot].slot = slot;
  });
  bot.heldItem = slots[36] ?? null;
  bot.inventory = {
    slots,
    items: () => slots.slice(9, 45).filter(Boolean),
    count: (type) => slots.filter((s) => s && s.type === type).reduce((a, s) => a + s.count, 0),
    emptySlotCount: () => slots.slice(9, 45).filter((s) => !s).length,
  };
  // 往背包里加物品，返回放不下的数量（相当于掉在地上捡不起来）
  bot.addItem = (name, count) => {
    const id = registry.itemsByName[name].id;
    const max = registry.itemsByName[name].stackSize ?? 64;
    let left = count;
    for (let i = 9; i < 45 && left > 0; i++) {
      const s = slots[i];
      if (s && s.type === id && s.count < max) {
        const n = Math.min(left, max - s.count);
        s.count += n;
        left -= n;
      }
    }
    for (let i = 9; i < 45 && left > 0; i++) {
      if (!slots[i]) {
        const n = Math.min(left, max);
        slots[i] = new Item(id, n);
        slots[i].slot = i;
        left -= n;
      }
    }
    return left;
  };
  bot.removeItem = (type, count) => {
    let left = count;
    for (let i = 9; i < 45 && left > 0; i++) {
      const s = slots[i];
      if (s && s.type === type) {
        const n = Math.min(left, s.count);
        s.count -= n;
        left -= n;
        if (s.count === 0) {
          slots[i] = null;
          if (bot.heldItem === s) bot.heldItem = null;
        }
      }
    }
    if (left > 0) throw new Error('not enough items');
  };
  bot.countOf = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
  // 放得下才返回 true（真实游戏里放不下的掉落物会留在地上）
  bot.canFit = (name, count) => {
    const id = registry.itemsByName[name].id;
    const max = registry.itemsByName[name].stackSize ?? 64;
    let room = 0;
    for (let i = 9; i < 45; i++) {
      const s = slots[i];
      if (!s) room += max;
      else if (s.type === id) room += max - s.count;
    }
    return room >= count;
  };
  // 成熟作物的掉落（固定数量，便于断言）；未成熟只掉 1 个种子
  bot.fakeDrops = {
    wheat: (age) => (age >= 7 ? [['wheat', 1], ['wheat_seeds', 2]] : [['wheat_seeds', 1]]),
    carrots: (age) => (age >= 7 ? [['carrot', 2]] : [['carrot', 1]]),
    potatoes: (age) => (age >= 7 ? [['potato', 2]] : [['potato', 1]]),
    beetroots: (age) => (age >= 3 ? [['beetroot', 1], ['beetroot_seeds', 2]] : [['beetroot_seeds', 1]]),
  };
  // 箱子：key 为坐标，内容为 [{name,count}]，每格一叠，27 格
  fw.containers ??= new Map();
  bot.openContainer = async (block) => {
    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    if (!/(chest|barrel)$/.test(block.name)) throw new Error('not a container');
    const stacks = fw.containers.get(key) ?? [];
    fw.containers.set(key, stacks);
    record('openContainer', { pos: block.position.clone() });
    const find = (type) => stacks.filter((st) => registry.itemsByName[st.name].id === type);
    return {
      containerItems: () => stacks.map((st) => ({ name: st.name, count: st.count, type: registry.itemsByName[st.name].id })),
      deposit: async (type, _meta, count) => {
        const name = registry.items[type].name;
        const max = registry.items[type].stackSize ?? 64;
        let left = count;
        for (const st of find(type)) {
          const n = Math.min(left, max - st.count);
          st.count += n;
          left -= n;
        }
        while (left > 0 && stacks.length < 27) {
          const n = Math.min(left, max);
          stacks.push({ name, count: n });
          left -= n;
        }
        const stored = count - left;
        if (stored > 0) bot.removeItem(type, stored);
        record('deposit', { name, count: stored });
        if (left > 0) throw new Error(`destination full (${left} left)`);
      },
      withdraw: async (type, _meta, count) => {
        let left = count;
        for (const st of find(type)) {
          const n = Math.min(left, st.count);
          st.count -= n;
          left -= n;
        }
        for (let i = stacks.length - 1; i >= 0; i--) if (stacks[i].count === 0) stacks.splice(i, 1);
        const got = count - left;
        bot.addItem(registry.items[type].name, got);
        record('withdraw', { name: registry.items[type].name, count: got });
        if (left > 0) throw new Error('not enough items in container');
      },
      close: () => record('closeContainer', { pos: block.position.clone() }),
    };
  };

  bot.blockAt = (pos) => fw.world.getBlock(pos.floored ? pos.floored() : new Vec3(pos.x, pos.y, pos.z).floored());
  bot.canSeeBlock = () => true;
  bot.canDigBlock = () => true;
  bot.findBlocks = ({ matching, maxDistance = 16, count = 1, point }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    const p = (point ?? bot.entity.position).floored();
    const out = [];
    for (let x = p.x - maxDistance; x <= p.x + maxDistance; x++) {
      for (let y = Math.max(-64, p.y - maxDistance); y <= p.y + maxDistance; y++) {
        for (let z = p.z - maxDistance; z <= p.z + maxDistance; z++) {
          const b = fw.world.getBlock(new Vec3(x, y, z));
          if (b && ids.includes(b.type)) out.push(new Vec3(x, y, z));
        }
      }
    }
    out.sort((a, b) => a.distanceTo(p) - b.distanceTo(p));
    return out.slice(0, count);
  };
  bot.nearestEntity = (filter = () => true) => {
    let best = null;
    let bestD = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position || !filter(e)) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best;
  };

  // 掉落物是地上的实体，只有 Bot 走到拾取范围内（水平 1 格、竖直 1.5 格）且背包放得下才会进背包
  let nextEntityId = 5000;
  bot.dropOffset = () => new Vec3(0.5, 0.1, 0.5);
  bot.spawnDrop = (name, count, pos) => {
    const e = {
      id: nextEntityId++,
      type: 'object',
      name: 'item',
      displayName: 'Item',
      position: pos.clone(),
      height: 0.25,
      width: 0.25,
      isValid: true,
      getDroppedItem: () => ({ name, count }),
    };
    bot.entities[e.id] = e;
    bot.emit('entitySpawn', e);
    return e;
  };
  bot.groundItems = () => Object.values(bot.entities).filter((e) => e?.name === 'item');
  // 别人（玩家）捡走地上的物品：服务器发 collect 包，mineflayer 发 playerCollect(收集者, 物品)
  bot.pickedByOther = (item, collector) => {
    if (!bot.entities[item.id]) return;
    delete bot.entities[item.id];
    item.isValid = false;
    bot.emit('playerCollect', collector, item);
    bot.emit('entityGone', item);
  };
  // 物品消失但没有 collect 包（例如合并、过期、被清理）
  bot.vanish = (item) => {
    if (!bot.entities[item.id]) return;
    delete bot.entities[item.id];
    item.isValid = false;
    bot.emit('entityGone', item);
  };
  bot.pickupTick = () => {
    const p = bot.entity.position;
    for (const e of bot.groundItems()) {
      if (Math.hypot(e.position.x - p.x, e.position.z - p.z) > 1.0 || Math.abs(e.position.y - p.y) > 1.5) continue;
      const { name, count } = e.getDroppedItem();
      if (!bot.canFit(name, count)) continue;
      bot.addItem(name, count);
      delete bot.entities[e.id];
      e.isValid = false;
      bot.calls.push({ type: 'pickup', name, count });
      bot.emit('playerCollect', bot.entity, e);
      bot.emit('entityGone', e);
    }
  };

  const record = (type, data) => bot.calls.push({ type, ...data });
  // 和 mineflayer 一样：挖掘要花时间；stopDigging 会让进行中的 dig 以 "Digging aborted" 失败，方块不变
  bot.digTimeMs = 30;
  bot.stopDigging = () => {};
  bot.dig = (block) => new Promise((resolve, reject) => {
    record('dig', { pos: block.position.clone(), name: block.name });
    const pos = block.position.clone();
    const age = Number(block.getProperties().age ?? 0);
    bot.targetDigBlock = block;
    const finish = () => {
      bot.targetDigBlock = null;
      bot.stopDigging = () => {};
    };
    const timer = setTimeout(() => {
      finish();
      const current = fw.world.getBlock(pos);
      fw.world.setBlockStateId(pos, registry.blocksByName.air.defaultState);
      // 门、床是两格的：拆掉一半，另一半也没了
      const other = companionOf(current, pos);
      if (other && fw.world.getBlock(other)?.name === current.name) fw.world.setBlockStateId(other, registry.blocksByName.air.defaultState);
      record('digDone', { pos: pos.clone(), name: current?.name });
      const drops = bot.fakeDrops?.[block.name]?.(age) ?? [];
      for (const [name, count] of drops) bot.spawnDrop(name, count, pos.plus(bot.dropOffset(pos)));
      bot.emit('diggingCompleted', block);
      resolve();
    }, bot.digTimeMs);
    bot.stopDigging = () => {
      clearTimeout(timer);
      finish();
      record('digAborted', { pos: pos.clone() });
      bot.emit('diggingAborted', block);
      reject(new Error('Digging aborted'));
    };
  });
  const PLANT = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots' };
  bot._genericPlace = async (ref, face, options = {}) => {
    const dest = ref.position.plus(face);
    const held = bot.heldItem;
    record('place', { pos: dest, name: held?.name, face: faceName(face), yaw: bot.entity.yaw, pitch: bot.entity.pitch, delta: options.delta?.clone?.() });
    if (!held) return;
    const plant = PLANT[held.name];
    if (plant) {
      if (ref.name !== 'farmland' || fw.world.getBlock(dest)?.name !== 'air') return;
      fw.world.setBlockStateId(dest, registry.blocksByName[plant].defaultState);
    } else {
      // 按原版规则（自己另写的一份，和 src 的反推规则互相独立）决定方块状态
      const clicked = faceName(face);
      const d = options.delta ?? new Vec3(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const hit = d.minus(face); // 相对新方块
      const placed = fakePlacement(fw, held.name, { dest, clicked, hit, player: playerDir(bot.entity.yaw) });
      if (!placed) return;
      for (const [p, name, props] of placed) fw.set(p.x, p.y, p.z, name, props);
    }
    if (bot.inventory.slots.includes(held)) bot.removeItem(held.type, 1);
  };
  bot._placeBlockWithOptions = (ref, face, options) => bot._genericPlace(ref, face, options);
  bot.placeBlock = async (ref, face) => bot._genericPlace(ref, face, {});
  bot.placeEntity = async (ref, face) => bot._genericPlace(ref, face, {});
  bot.activateBlock = async (block) => {
    record('activateBlock', { pos: block.position.clone(), name: block.name, held: bot.heldItem?.name });
    // 木门/栅栏门：两半一起切换开关；铁门手动打不开
    if (/(_door|_fence_gate)$/.test(block.name) && !block.name.startsWith('iron_')) {
      const props = block.getProperties();
      const cells = [block.position];
      if (props.half === 'lower') cells.push(block.position.offset(0, 1, 0));
      if (props.half === 'upper') cells.push(block.position.offset(0, -1, 0));
      for (const c of cells) {
        const b = fw.world.getBlock(c);
        if (b && b.name === block.name) fw.set(c.x, c.y, c.z, b.name, { ...b.getProperties(), open: !props.open });
      }
    }
  };
  bot.activateItem = () => record('activateItem', { held: bot.heldItem?.name });
  bot.deactivateItem = () => {};
  bot.activateEntity = async () => record('activateEntity', {});
  bot.attack = () => record('attack', {});
  bot.equip = async (item) => {
    record('equip', { name: item.name ?? item });
    const found = typeof item === 'object' ? item : null;
    if (found) bot.heldItem = bot.inventory.slots.find((s) => s && s.type === found.type) ?? found;
  };
  bot.unequip = async () => {
    record('unequip', {});
    bot.heldItem = null;
  };
  bot.toss = async () => record('toss', {});
  bot.lookAt = async (p) => {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
    const d = p.minus(eye);
    bot.entity.yaw = Math.atan2(-d.x, -d.z);
    bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  };
  bot.look = async (yaw, pitch) => {
    bot.entity.yaw = yaw;
    bot.entity.pitch = pitch;
  };
  bot.setControlState = (k, v) => { bot.controlState[k] = v; };
  bot.clearControlStates = () => { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false; };
  bot.swingArm = () => {};
  bot.chat = (msg) => record('chat', { msg });
  bot.blockAtCursor = () => null;
  bot.quit = () => bot.emit('end', 'quit');

  if (withPathfinder) pathfinder(bot);
  return bot;
}

// 用"瞬移"代替物理：每个 tick 把 Bot 放到路径的下一个节点上，让真实 pathfinder 走完整个执行流程
export function attachTeleportKinematics(bot) {
  let path = [];
  const onUpdate = (r) => { path = r.path.slice(); };
  const onReset = () => { path = []; };
  bot.on('path_update', onUpdate);
  bot.on('path_reset', onReset);
  bot.on('path_stop', onReset);
  bot.on('goal_reached', onReset);
  const timer = setInterval(() => {
    bot.emit('physicsTick');
    bot.pickupTick();
    const next = path[0];
    if (!next) return;
    if (next.toBreak?.length || next.toPlace?.length) return; // 等 pathfinder 自己去挖/放
    bot.entity.position = new Vec3(next.x, next.y, next.z);
    path.shift();
  }, 5);
  // 没有寻路路径时，按住前进键就沿朝向慢慢走（关着的门、墙会挡住）
  const walker = setInterval(() => {
    if (path.length || !bot.controlState.forward) return;
    const p = bot.entity.position;
    const next = p.offset(-Math.sin(bot.entity.yaw) * 0.12, 0, -Math.cos(bot.entity.yaw) * 0.12);
    const cells = [next, next.offset(0, 1, 0)].map((c) => bot.blockAt(c));
    if (cells.every(walkable)) bot.entity.position = next;
    bot.pickupTick();
  }, 5);
  return () => {
    clearInterval(timer);
    clearInterval(walker);
    bot.removeListener('path_update', onUpdate);
    bot.removeListener('path_reset', onReset);
    bot.removeListener('path_stop', onReset);
    bot.removeListener('goal_reached', onReset);
  };
}

// 跳跃和重力：按住 jump 时从地面跳起约 1.2 格；脚下是空的就往下掉，落在方块上。垫高、从垫的方块上下来要用
export function attachGravity(bot) {
  let airborneUntil = 0;
  const timer = setInterval(() => {
    const p = bot.entity.position;
    if (bot.physics.gravity === 0) return; // 飞行悬停
    if (bot.controlState.jump && bot.entity.onGround) {
      bot.entity.position = new Vec3(p.x, Math.floor(p.y) + 1.2, p.z);
      bot.entity.onGround = false;
      airborneUntil = Date.now() + 60;
      return;
    }
    if (Date.now() < airborneUntil) return;
    const below = bot.blockAt(new Vec3(p.x, Math.ceil(p.y) - 1, p.z));
    const empty = !below || below.boundingBox === 'empty';
    if (empty) {
      bot.entity.position = new Vec3(p.x, Math.ceil(p.y) - 1, p.z);
      bot.entity.onGround = false;
    } else {
      if (p.y !== Math.ceil(p.y)) bot.entity.position = new Vec3(p.x, Math.ceil(p.y), p.z);
      bot.entity.onGround = true;
    }
  }, 5);
  return () => clearInterval(timer);
}

const FACES = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };

function faceName(v) {
  for (const [n, [x, y, z]] of Object.entries(FACES)) if (v.x === x && v.y === y && v.z === z) return n;
  return null;
}

function faceVec(n) {
  const [x, y, z] = FACES[n];
  return new Vec3(x, y, z);
}

// yaw 0 北、π/2 西、π 南、-π/2 东
function playerDir(yaw) {
  const i = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  return ['north', 'west', 'south', 'east'][i];
}

function fullCube(b) {
  return Boolean(b && b.boundingBox === 'block' && b.shapes?.length === 1 && b.shapes[0].join(',') === '0,0,0,1,1,1');
}

// 假服务器的放置规则：返回要写进世界的 [坐标, 方块名, 属性]；放不了返回 null
function fakePlacement(fw, item, { dest, clicked, hit, player }) {
  const at = (p) => fw.world.getBlock(p);
  let name = item;
  if (item === 'torch' && clicked !== 'up') {
    if (clicked === 'down') return null;
    return [[dest, 'wall_torch', { facing: clicked }]];
  }
  const b = registry.blocksByName[name];
  if (!b) return null;
  const has = (prop) => b.states.some((s) => s.name === prop);
  const topHalf = clicked === 'down' || (clicked !== 'up' && hit.y > 0.5);
  if (/_stairs$/.test(name)) return [[dest, name, { facing: player, half: topHalf ? 'top' : 'bottom' }]];
  if (/_slab$/.test(name)) return [[dest, name, { type: topHalf ? 'top' : 'bottom' }]];
  if (has('axis')) return [[dest, name, { axis: clicked === 'up' || clicked === 'down' ? 'y' : clicked === 'east' || clicked === 'west' ? 'x' : 'z' }]];
  if (/_trapdoor$/.test(name)) {
    if (clicked === 'up' || clicked === 'down') return [[dest, name, { facing: OPP[player], half: clicked === 'up' ? 'bottom' : 'top' }]];
    return [[dest, name, { facing: clicked, half: hit.y > 0.5 ? 'top' : 'bottom' }]];
  }
  if (/_door$/.test(name)) {
    const up = dest.offset(0, 1, 0);
    if (at(up)?.name !== 'air') return null;
    // 原版 DoorBlock.getHinge
    const left = CCW[player], right = CW[player];
    const lp = dest.plus(faceVec(left)), rp = dest.plus(faceVec(right));
    const i = (fullCube(at(lp)) ? -1 : 0) + (fullCube(at(lp.offset(0, 1, 0))) ? -1 : 0) + (fullCube(at(rp)) ? 1 : 0) + (fullCube(at(rp.offset(0, 1, 0))) ? 1 : 0);
    const lDoor = at(lp)?.name === name && at(lp).getProperties().half === 'lower';
    const rDoor = at(rp)?.name === name && at(rp).getProperties().half === 'lower';
    let hinge;
    if ((!lDoor || rDoor) && i <= 0) {
      if ((!rDoor || lDoor) && i >= 0) {
        const [j, , k] = FACES[player];
        const d0 = hit.x, d1 = hit.z;
        hinge = (j >= 0 || !(d1 < 0.5)) && (j <= 0 || !(d1 > 0.5)) && (k >= 0 || !(d0 > 0.5)) && (k <= 0 || !(d0 < 0.5)) ? 'left' : 'right';
      } else hinge = 'left';
    } else hinge = 'right';
    return [[dest, name, { facing: player, half: 'lower', hinge }], [up, name, { facing: player, half: 'upper', hinge }]];
  }
  if (/_bed$/.test(name)) {
    const head = dest.plus(faceVec(player));
    if (at(head)?.name !== 'air') return null;
    return [[dest, name, { facing: player, part: 'foot' }], [head, name, { facing: player, part: 'head' }]];
  }
  if (/_fence_gate$/.test(name)) return [[dest, name, { facing: player }]];
  if (/^(chest|furnace|smoker|blast_furnace|loom)$/.test(name)) return [[dest, name, { facing: OPP[player] }]];
  // 故意和 src 的默认猜测（朝向 = 玩家朝向的反方向）不同，用来测「放错了学到偏差再重放」
  if (name === 'calibrated_sculk_sensor') return [[dest, name, { facing: player }]];
  return [[dest, name, undefined]];
}

function companionOf(block, pos) {
  if (!block) return null;
  const p = block.getProperties();
  if (/_door$/.test(block.name)) return pos.offset(0, p.half === 'lower' ? 1 : -1, 0);
  if (/_bed$/.test(block.name)) {
    const v = faceVec(p.facing);
    return p.part === 'foot' ? pos.plus(v) : pos.minus(v);
  }
  return null;
}

function walkable(b) {
  if (!b) return false;
  if (['air', 'cave_air', 'void_air'].includes(b.name)) return true;
  if (/(_door|_fence_gate)$/.test(b.name)) return b.getProperties().open === true;
  return b.boundingBox === 'empty';
}

// 原来（修复前）默认寻路的配置：会挖路、会垫方块，只按材质黑名单保护
export function legacyMovements(bot, protectFromPathfinder) {
  const m = new Movements(bot);
  m.allowSprinting = false;
  if (protectFromPathfinder) protectFromPathfinder(m, registry);
  return m;
}

// 算到最终结果为止（默认每次只算 40ms，机器忙时会得到 partial，测试结论就不可靠了）
export function pathTo(bot, movements, goal) {
  let result = null;
  for (const step of bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout: 20000, tickTimeout: 20000 })) {
    result = step.result;
  }
  return result;
}
