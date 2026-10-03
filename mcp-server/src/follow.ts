// 跟随玩家：保持距离（带迟滞，不贴身推人、不频繁启停），不停在登记的门口，
// 看不到人、对方被传送、走散时停下并发出 follow 事件，不追旧坐标。
// 连续找不到路（矿道里她挖了新路、跳下了高处）不结束跟随：原地等，她挪了位置再试，只说一次。
// 正在执行其他身体动作时暂停，不和任务抢寻路目标。stop-action 会结束跟随
// 陪挖模式（escort.ts）：跟着走之前先看有没有要打的怪、要挖的矿，有就先做
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { bodyBusy, runOutsideTask, taskGeneration } from './task-control.js';
import { entranceStore } from './entrances.js';
import { playerByName } from './perception.js';
import { Escort, type EscortOptions } from './escort.js';

const { goals } = pathfinderPkg;

export const FOLLOW_TICK_MS = 300;
const TELEPORT_JUMP = 16;
const MAX_NO_PATH = 3;
// 找不到路之后，她离卡住时的位置超过这么远、或者等了这么久就再试（她可能原地把路挖通了）
const RETRY_MOVE = 2;
const RETRY_MS = 10000;

type P = { x: number; y: number; z: number };
const key = (p: P) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

// 跟随目标：在范围内即可，但不能站在门口或对方脚下
export class GoalFollowNear extends goals.GoalNear {
  constructor(x: number, y: number, z: number, range: number, private readonly avoid: Set<string>, private readonly player: P) {
    super(x, y, z, range);
  }

  isEnd(node: P): boolean {
    if (!super.isEnd(node as never)) return false;
    if (this.avoid.has(key(node))) return false;
    return !(Math.floor(node.x) === Math.floor(this.player.x) && Math.floor(node.z) === Math.floor(this.player.z));
  }
}

interface FollowState {
  bot: Bot;
  username: string;
  distance: number;
  maxDistance: number;
  generation: number;
  timer: ReturnType<typeof setInterval>;
  lastTargetPos: Vec3 | null;
  goalAnchor: Vec3 | null;
  noPath: number;
  // 找不到路、正在原地等：卡住时她的位置；toldStuck = 这次卡住已经说过了（找到路后重置）
  stuckAt: Vec3 | null;
  stuckSince: number;
  toldStuck: boolean;
  escort: Escort | null;
  onPath: (r: { status: string }) => void;
  onEvent: (type: string, text: string) => void;
}

let state: FollowState | null = null;

function doorCells(bot: Bot): Set<string> {
  const cells = new Set<string>();
  for (const e of entranceStore().list(bot.game.dimension)) {
    for (const p of [e.door, e.inside, e.outside]) cells.add(key(p));
  }
  return cells;
}

export function followStatus(): string | null {
  if (!state) return null;
  const escort = state.escort ? `，${state.escort.status()}` : '';
  const stuck = state.stuckAt ? '，暂时过不去、原地等' : '';
  return `正在跟随 ${state.username}（保持约 ${state.distance} 格${stuck}${escort}）`;
}

export function stopFollow(reason?: string): void {
  if (!state) return;
  const s = state;
  state = null;
  clearInterval(s.timer);
  s.escort?.stop();
  s.bot.removeListener('path_update', s.onPath as never);
  try {
    s.bot.pathfinder.setGoal(null);
  } catch {
    // 连接已断开
  }
  if (reason) s.onEvent('follow', reason);
}

function tick(s: FollowState): void {
  if (state !== s) return;
  const bot = s.bot;
  if (!bot.entity) return stopFollow();
  if (taskGeneration() !== s.generation) return stopFollow();
  if (bodyBusy()) {
    // 有别的动作在跑：不碰寻路目标，等它结束
    s.goalAnchor = null;
    return;
  }
  const target = playerByName(bot, s.username);
  if (!target) return stopFollow(`看不到 ${s.username} 了（走远、下线或进了未加载的地方），我停在原地`);
  const pos = target.position.clone();
  if (s.lastTargetPos && pos.distanceTo(s.lastTargetPos) > TELEPORT_JUMP) {
    return stopFollow(`${s.username} 一下子到了 ${Math.floor(pos.distanceTo(bot.entity.position))} 格外（像是传送了），我先停下`);
  }
  s.lastTargetPos = pos;
  const dist = pos.distanceTo(bot.entity.position);
  if (dist > s.maxDistance) return stopFollow(`和 ${s.username} 走散了（相距 ${Math.floor(dist)} 格），我停在原地`);
  // 陪挖：有怪先打、有矿先挖，这期间寻路目标归它管
  if (s.escort?.tick(target)) {
    s.goalAnchor = null;
    return;
  }
  if (s.noPath >= MAX_NO_PATH && !s.stuckAt) {
    s.stuckAt = pos;
    s.stuckSince = Date.now();
    s.goalAnchor = null;
    bot.pathfinder.setGoal(null);
    if (!s.toldStuck) {
      s.toldStuck = true;
      s.onEvent('follow', `暂时跟不过去 ${s.username}（没有不用挖、不用垫的路），我在原地等，她走到能过去的地方我再跟上`);
    }
  }
  if (s.stuckAt) {
    if (pos.distanceTo(s.stuckAt) <= RETRY_MOVE && Date.now() - s.stuckSince < RETRY_MS) return;
    s.stuckAt = null;
    s.noPath = 0;
  }

  const moving = Boolean(bot.pathfinder.goal);
  if (moving && dist <= s.distance && s.goalAnchor) {
    bot.pathfinder.setGoal(null);
    s.goalAnchor = null;
    return;
  }
  const needStart = !moving && dist > s.distance + 1.5;
  const targetMoved = moving && s.goalAnchor !== null && s.goalAnchor.distanceTo(pos) > 2;
  if (needStart || targetMoved) {
    s.goalAnchor = pos;
    bot.pathfinder.setGoal(new GoalFollowNear(pos.x, pos.y, pos.z, s.distance, doorCells(bot), pos));
  }
}

export function startFollow(bot: Bot, username: string, opts: { distance: number; maxDistance: number; escort?: EscortOptions }, onEvent: (type: string, text: string) => void): string {
  stopFollow();
  const target = playerByName(bot, username);
  if (!target) return `看不到玩家 ${username}（不在线或太远）`;
  // 定时器长期存在，不能继承这次工具调用的任务上下文
  runOutsideTask(() => {
    const s: FollowState = {
      bot,
      username,
      distance: opts.distance,
      maxDistance: opts.maxDistance,
      generation: taskGeneration(),
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      lastTargetPos: null,
      goalAnchor: null,
      noPath: 0,
      stuckAt: null,
      stuckSince: 0,
      toldStuck: false,
      escort: opts.escort && (opts.escort.fight || opts.escort.ores) ? new Escort(bot, username, opts.escort, onEvent) : null,
      onPath: (r) => {
        if (state !== s || !s.goalAnchor) return;
        if (r.status === 'noPath') {
          // pathfinder 找不到路后不会自己重试：清掉目标，下一轮重新规划并计数
          s.noPath++;
          s.goalAnchor = null;
          setImmediate(() => { if (state === s && !s.goalAnchor) s.bot.pathfinder.setGoal(null); });
        } else if (r.status === 'success') {
          s.noPath = 0;
          s.toldStuck = false;
        }
      },
      onEvent
    };
    s.timer = setInterval(() => tick(s), FOLLOW_TICK_MS);
    // 不让跟随定时器单独撑住进程（MCP 进程本身由 stdin 保持运行）
    s.timer.unref?.();
    bot.on('path_update', s.onPath as never);
    bot.once('end', () => { if (state === s) stopFollow(); });
    state = s;
    tick(s);
  });
  const escort = state?.escort ? `；${state.escort.status()}：身边有怪先打、露在外面的矿先挖，挖到稀有矿、镐子坏了、背包满了会告诉你` : '';
  return `开始跟随 ${username}，保持约 ${opts.distance} 格（只走路；看不到人、走散会停下并告诉你，过不去时原地等她${escort}）`;
}
