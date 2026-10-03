// 创造模式飞行：在空气里规划一条绕开方块的路线，一小步一小步飞过去，随时能停；可以悬停，也可以落地。
// 不用 mineflayer 自带的 creative.flyTo：它直线穿墙飞，撞墙会被服务器拉回；超时后循环停不下来，
// 一直在后台把重力设成 0、改坐标，飞过一次之后寻路就坏了
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';

const DEFAULT_GRAVITY = 0.08;
const STEP = 0.4; // 每 50ms 飞多远（8 格/秒，比原版创造飞行慢，服务器不会拉回）
const TICK_MS = 50;
const MAX_NODES = 60000;
const HALF_WIDTH = 0.3;
const HEIGHT = 1.8;
// 没有碰撞箱、但飞进去会受伤或被卡住的方块
const HAZARD = /(lava|fire|cobweb|sweet_berry_bush|powder_snow|wither_rose|end_portal|nether_portal)$/;

interface FlightState {
  flying: boolean;
  gravity: number;
  cancel: (() => void) | null;
}

const states = new WeakMap<Bot, FlightState>();

function stateOf(bot: Bot): FlightState {
  let s = states.get(bot);
  if (!s) {
    const g = bot.physics?.gravity;
    s = { flying: false, gravity: typeof g === 'number' && g > 0 ? g : DEFAULT_GRAVITY, cancel: null };
    states.set(bot, s);
  }
  return s;
}

export function canFly(bot: Bot): boolean {
  return bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator';
}

export function isFlying(bot: Bot): boolean {
  return states.get(bot)?.flying ?? false;
}

function sendAbilities(bot: Bot, flying: boolean): void {
  try {
    // 0x02 = 正在飞；让服务器和别的玩家看到的状态一致
    (bot as unknown as { _client: { write: (name: string, data: object) => void } })._client.write('abilities', { flags: flying ? 0x02 : 0 });
  } catch {
    // 发不出去不影响本地悬停
  }
}

function hold(bot: Bot): void {
  bot.physics.gravity = 0;
  bot.entity.velocity = new Vec3(0, 0, 0);
  bot.entity.onGround = false; // 落地时靠它判断是否着地，不能留着起飞前的值
}

// 开始悬停在原地
export function startFlying(bot: Bot): void {
  if (!canFly(bot)) throw new Error('只有创造模式能飞');
  const s = stateOf(bot);
  if (!s.flying) {
    const g = bot.physics.gravity;
    if (typeof g === 'number' && g > 0) s.gravity = g;
    s.flying = true;
  }
  bot.clearControlStates();
  hold(bot);
  sendAbilities(bot, true);
}

// 停止飞行，恢复重力，等落到地上（最多 timeoutMs）。返回是否已经着地
export async function stopFlying(bot: Bot, timeoutMs = 5000): Promise<boolean> {
  const s = stateOf(bot);
  s.cancel?.();
  const was = s.flying;
  s.flying = false;
  bot.physics.gravity = s.gravity;
  if (was) sendAbilities(bot, false);
  const end = Date.now() + timeoutMs;
  while (!bot.entity.onGround && Date.now() < end) await new Promise((r) => setTimeout(r, TICK_MS));
  return Boolean(bot.entity.onGround);
}

// 正在飞的话先落地（走路、寻路之前调用：悬停时寻路走不了）
export async function landIfFlying(bot: Bot): Promise<void> {
  if (isFlying(bot)) await stopFlying(bot);
}

// stop-action 用：打断正在进行的飞行（保持悬停）
export function cancelFlight(bot: Bot): void {
  states.get(bot)?.cancel?.();
}

// ---- 路线 ----

function passable(b: Block | null): boolean {
  return Boolean(b && b.shapes.length === 0 && !HAZARD.test(b.name));
}

class CellCache {
  private cache = new Map<string, boolean>();
  constructor(private bot: Bot) {}
  free(x: number, y: number, z: number): boolean {
    const k = `${x},${y},${z}`;
    let v = this.cache.get(k);
    if (v === undefined) {
      v = passable(this.bot.blockAt(new Vec3(x, y, z)));
      this.cache.set(k, v);
    }
    return v;
  }
  // 身体（2 格高）能待在以这一格为脚的位置
  body(x: number, y: number, z: number): boolean {
    return this.free(x, y, z) && this.free(x, y + 1, z);
  }
}

// 身体在 p（脚底中心）时碰到的格子都是空的
function boxClear(cells: CellCache, p: Vec3): boolean {
  const x1 = Math.floor(p.x - HALF_WIDTH), x2 = Math.floor(p.x + HALF_WIDTH - 1e-6);
  const z1 = Math.floor(p.z - HALF_WIDTH), z2 = Math.floor(p.z + HALF_WIDTH - 1e-6);
  const y1 = Math.floor(p.y), y2 = Math.floor(p.y + HEIGHT - 1e-6);
  for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) {
    if (!cells.free(x, y, z)) return false;
  }
  return true;
}

function segmentClear(cells: CellCache, a: Vec3, b: Vec3): boolean {
  const n = Math.max(1, Math.ceil(a.distanceTo(b) / 0.2));
  for (let i = 1; i <= n; i++) {
    if (!boxClear(cells, a.plus(b.minus(a).scaled(i / n)))) return false;
  }
  return true;
}

const NEIGHBORS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
  [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]
];

interface Node {
  x: number;
  y: number;
  z: number;
  g: number;
  f: number;
  parent: Node | null;
}

class Heap {
  private items: Node[] = [];
  get size() {
    return this.items.length;
  }
  push(n: Node) {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Node {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function astar(cells: CellCache, start: Vec3, goal: Vec3, minY: number, maxY: number): Vec3[] | null {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const h = (x: number, y: number, z: number) => Math.hypot(x - goal.x, y - goal.y, z - goal.z);
  const open = new Heap();
  const best = new Map<string, number>();
  open.push({ x: start.x, y: start.y, z: start.z, g: 0, f: h(start.x, start.y, start.z), parent: null });
  best.set(key(start.x, start.y, start.z), 0);
  let expanded = 0;
  while (open.size && expanded < MAX_NODES) {
    const n = open.pop();
    if (n.g > (best.get(key(n.x, n.y, n.z)) ?? Infinity)) continue;
    if (n.x === goal.x && n.y === goal.y && n.z === goal.z) {
      const path: Vec3[] = [];
      for (let c: Node | null = n; c; c = c.parent) path.push(new Vec3(c.x, c.y, c.z));
      return path.reverse();
    }
    expanded += 1;
    for (const [dx, dy, dz] of NEIGHBORS) {
      const x = n.x + dx, y = n.y + dy, z = n.z + dz;
      if (y < minY || y + 1 >= maxY) continue;
      if (!cells.body(x, y, z)) continue;
      // 斜着走不能擦过墙角
      if (dx && dz && !(cells.body(n.x + dx, y, n.z) && cells.body(n.x, y, n.z + dz))) continue;
      const g = n.g + (dx && dz ? Math.SQRT2 : 1);
      const k = key(x, y, z);
      if (g >= (best.get(k) ?? Infinity)) continue;
      best.set(k, g);
      open.push({ x, y, z, g, f: g + h(x, y, z), parent: n });
    }
  }
  return null;
}

const center = (c: Vec3) => new Vec3(c.x + 0.5, c.y, c.z + 0.5);

// 能直线飞过去的中间点省掉
function smooth(cells: CellCache, from: Vec3, points: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  let anchor = from;
  let i = 0;
  while (i < points.length) {
    let j = points.length - 1;
    while (j > i && !segmentClear(cells, anchor, points[j])) j--;
    out.push(points[j]);
    anchor = points[j];
    i = j + 1;
  }
  return out;
}

// 离 target 最近的、身体放得下的格子（先找正上方）
function nearestFree(cells: CellCache, target: Vec3, radius = 2): Vec3 | null {
  if (cells.body(target.x, target.y, target.z)) return target;
  for (let dy = 1; dy <= radius; dy++) if (cells.body(target.x, target.y + dy, target.z)) return target.offset(0, dy, 0);
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) {
    const d = Math.hypot(dx, dy, dz);
    if (d >= bestD || !cells.body(target.x + dx, target.y + dy, target.z + dz)) continue;
    best = target.offset(dx, dy, dz);
    bestD = d;
  }
  return best;
}

export interface FlightResult {
  ok: boolean;
  message: string;
}

// 飞到 target 那一格（脚所在的格子，落在格子中心）。stay=false 时到了就落地
export async function flyTo(bot: Bot, target: Vec3, { stay = false, timeoutMs }: { stay?: boolean; timeoutMs?: number } = {}): Promise<FlightResult> {
  if (!canFly(bot)) return { ok: false, message: '只有创造模式能飞' };
  const s = stateOf(bot);
  s.cancel?.();
  const wasFlying = s.flying;
  const cells = new CellCache(bot);
  const game = bot.game as unknown as { minY?: number; height?: number } | undefined;
  const minY = game?.minY ?? -64;
  const maxY = minY + (game?.height ?? 384);
  const fmt = (v: Vec3) => `(${v.x}, ${v.y}, ${v.z})`;
  const giveUp = async (message: string): Promise<FlightResult> => {
    if (!wasFlying || !stay) await stopFlying(bot);
    return { ok: false, message };
  };

  const here = bot.entity.position.floored();
  let start = here;
  if (!cells.body(start.x, start.y, start.z)) start = here.offset(0, 1, 0);
  if (!cells.body(start.x, start.y, start.z)) return giveUp(`现在的位置 ${fmt(here)} 太挤，飞不起来`);
  const wanted = target.floored();
  const goal = nearestFree(cells, wanted);
  if (!goal) return giveUp(`${fmt(wanted)} 附近被方块塞满了，没有能待的地方`);

  const cellsPath = astar(cells, start, goal, minY, maxY);
  if (!cellsPath) {
    return giveUp(`飞不过去：从 ${fmt(here)} 到 ${fmt(goal)} 没有空着的路（被墙、屋顶、玻璃或门挡住了，或者太远）。没动`);
  }
  const from = bot.entity.position.clone();
  const firstUp = center(start);
  const points = [firstUp, ...smooth(cells, firstUp, cellsPath.slice(1).map(center))];
  const length = points.reduce((sum, p, i) => sum + p.distanceTo(i ? points[i - 1] : from), 0);
  const budget = timeoutMs ?? Math.min(180000, (length / STEP) * TICK_MS * 1.5 + 5000);

  startFlying(bot);
  let stopped: string | null = null;
  const onForced = () => {
    stopped ??= `被服务器拉回来 / 被传送了，停在 ${fmt(bot.entity.position.floored())}`;
  };
  bot.on('forcedMove', onForced);
  s.cancel = () => {
    stopped ??= '飞行被打断了';
  };
  const deadline = Date.now() + budget;
  try {
    for (const p of points) {
      for (;;) {
        if (stopped) break;
        if (Date.now() > deadline) {
          stopped = `飞得太久（${Math.round(budget / 1000)} 秒）`;
          break;
        }
        const pos = bot.entity.position;
        const d = p.minus(pos);
        const dist = d.norm();
        bot.entity.position = dist <= STEP ? p.clone() : pos.plus(d.scaled(STEP / dist));
        hold(bot);
        await new Promise((r) => setTimeout(r, TICK_MS));
        if (dist <= STEP) break;
      }
      if (stopped) break;
    }
  } finally {
    bot.removeListener('forcedMove', onForced);
    s.cancel = null;
  }
  if (stopped) {
    if (!stay) await stopFlying(bot);
    return { ok: false, message: `${stopped}${stay ? '，现在悬停在空中' : '，已经落地'}` };
  }
  const at = bot.entity.position.floored();
  const moved = goal.equals(wanted) ? '' : `（${fmt(wanted)} 被占着，停在旁边能待的 ${fmt(goal)}）`;
  if (stay) return { ok: true, message: `飞到了 ${fmt(at)}${moved}，悬停在空中。要落地用 set-flying {flying:false}；走路类工具会自动先落地` };
  const landed = await stopFlying(bot);
  const ground = bot.entity.position.floored();
  return { ok: true, message: `飞到了 ${fmt(at)}${moved}，${landed ? `落地在 ${fmt(ground)}` : `正在往下落（现在 ${fmt(ground)}）`}` };
}
