// YSM（Yes Steve Model）动画：通过本机 RCON 执行 `ysm play <玩家> <动画>`，让装了 YSM 的客户端看到 Bot 的模型动作
// 服务器目录取环境变量 MC_SERVER_DIR，映射表所在的数据目录取 MCBOT_DATA_DIR；每次调用时现读，改完映射不用重连
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyBusy, onActivityStart } from './task-control.js';
import { log } from './logger.js';

const RCON_HOST = '127.0.0.1';
const RCON_TIMEOUT_MS = 3000;
export const YSM_EMOTES_FILE = 'ysm-emotes.json';

// 动画名和用户名会拼进命令里，只放行安全字符，防止注入别的命令
const ANIMATION_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// RCON 包类型
const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const AUTH_ID = 1;
const COMMAND_ID = 2;

export function serverDir(): string {
  return process.env.MC_SERVER_DIR || fileURLToPath(new URL('../../server', import.meta.url));
}

export function ysmDataDir(): string {
  return process.env.MCBOT_DATA_DIR || fileURLToPath(new URL('../../data', import.meta.url));
}

export type RconResult = { ok: true; reply: string } | { ok: false; error: string };

function readServerProps(dir: string): Record<string, string> {
  const text = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  const props: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return props;
}

function packet(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8');
  const p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
}

// 执行一条 RCON 命令；任何失败都变成中文错误返回，不抛异常
export function rconCommand(command: string, { dir = serverDir(), timeoutMs = RCON_TIMEOUT_MS } = {}): Promise<RconResult> {
  let props: Record<string, string>;
  try {
    props = readServerProps(dir);
  } catch (e) {
    return Promise.resolve({ ok: false, error: `读不到服务器配置 ${path.join(dir, 'server.properties')}：${(e as Error).message}` });
  }
  if (props['enable-rcon'] !== 'true') {
    return Promise.resolve({ ok: false, error: '服务器没开 RCON（server.properties 里 enable-rcon 不是 true）' });
  }
  const port = Number(props['rcon.port'] || 25575);
  const password = props['rcon.password'] ?? '';
  if (!password) return Promise.resolve({ ok: false, error: 'server.properties 里没有设置 rcon.password' });
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve({ ok: false, error: `server.properties 里的 rcon.port 不对：${props['rcon.port']}` });
  }

  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    let settled = false;
    const socket = net.connect(port, RCON_HOST);
    const finish = (result: RconResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `RCON（${RCON_HOST}:${port}）${timeoutMs / 1000} 秒内没有回应` }), timeoutMs);
    socket.on('connect', () => socket.write(packet(AUTH_ID, TYPE_AUTH, password)));
    socket.on('data', (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const body = len >= 10 ? buf.toString('utf8', 12, 4 + len - 2) : '';
        buf = buf.subarray(4 + len);
        if (!authed) {
          if (id === -1) {
            finish({ ok: false, error: 'RCON 认证失败，密码不对（看 server.properties 的 rcon.password）' });
            return;
          }
          if (id !== AUTH_ID) continue;
          authed = true;
          socket.write(packet(COMMAND_ID, TYPE_COMMAND, command));
        } else if (id === COMMAND_ID) {
          // 回复很长时会分成多个包；这里只用到短命令，取第一个包就够了
          finish({ ok: true, reply: body });
          return;
        }
      }
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        error: e.code === 'ECONNREFUSED'
          ? `连不上 RCON（${RCON_HOST}:${port}），服务器可能没开`
          : `RCON 连接出错：${e.message}`
      });
    });
    socket.on('close', () => finish({ ok: false, error: 'RCON 连接被服务器关闭了' }));
  });
}

// 用一个连接依次执行多条命令（建筑预览要发几百条 summon）。返回成功执行的条数；中途出错就停下并带上原因
export function rconCommands(commands: string[], { dir = serverDir(), timeoutMs = 20000 } = {}): Promise<{ done: number; error: string | null }> {
  if (!commands.length) return Promise.resolve({ done: 0, error: null });
  let props: Record<string, string>;
  try {
    props = readServerProps(dir);
  } catch (e) {
    return Promise.resolve({ done: 0, error: `读不到服务器配置 ${path.join(dir, 'server.properties')}：${(e as Error).message}` });
  }
  if (props['enable-rcon'] !== 'true') return Promise.resolve({ done: 0, error: '服务器没开 RCON（server.properties 里 enable-rcon 不是 true）' });
  const port = Number(props['rcon.port'] || 25575);
  const password = props['rcon.password'] ?? '';
  if (!password) return Promise.resolve({ done: 0, error: 'server.properties 里没有设置 rcon.password' });

  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    let settled = false;
    let done = 0;
    const socket = net.connect(port, RCON_HOST);
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ done, error });
    };
    const timer = setTimeout(() => finish(`RCON ${timeoutMs / 1000} 秒内没有执行完（完成 ${done}/${commands.length} 条）`), timeoutMs);
    const sendNext = () => {
      if (done >= commands.length) {
        finish(null);
        return;
      }
      socket.write(packet(COMMAND_ID + done, TYPE_COMMAND, commands[done]));
    };
    socket.on('connect', () => socket.write(packet(AUTH_ID, TYPE_AUTH, password)));
    socket.on('data', (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        buf = buf.subarray(4 + len);
        if (!authed) {
          if (id === -1) {
            finish('RCON 认证失败，密码不对（看 server.properties 的 rcon.password）');
            return;
          }
          if (id !== AUTH_ID) continue;
          authed = true;
          sendNext();
        } else if (id === COMMAND_ID + done) {
          done += 1;
          sendNext();
        }
      }
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      finish(e.code === 'ECONNREFUSED' ? `连不上 RCON（${RCON_HOST}:${port}），服务器可能没开` : `RCON 连接出错：${e.message}`);
    });
    socket.on('close', () => finish(done >= commands.length ? null : 'RCON 连接被服务器关闭了'));
  });
}

export function isValidAnimationName(name: string): boolean {
  return ANIMATION_RE.test(name);
}

// 播放 YSM 动画。服务器对 ysm play 成功失败都不回任何文字，所以 ok 只代表命令发出去了，动画存不存在确认不了
export async function playYsmAnimation(username: string, animation: string, options: { dir?: string; timeoutMs?: number } = {}): Promise<RconResult> {
  if (!isValidAnimationName(animation)) {
    return { ok: false, error: `动画名 "${animation}" 不合法：只能用英文字母、数字和 _ . : -，最长 64 个字符` };
  }
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: `Bot 用户名 "${username}" 不能直接拼进命令` };
  }
  return rconCommand(`ysm play ${username} ${animation}`, options);
}

export interface YsmEmoteTable {
  current?: string;
  models: Record<string, Record<string, string>>;
  // 按动画名配的默认播放秒数（映射表的 _durations）；没配就不带这个字段
  durations?: Record<string, number>;
  error?: string;
}

// 读映射表 data/ysm-emotes.json：{"current": "<模型ID>", "<模型ID>": {"<表情名>": "<动画名>"}}；以 _ 开头的键是注释
export function loadYsmEmotes(file = path.join(ysmDataDir(), YSM_EMOTES_FILE)): YsmEmoteTable {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { models: {} };
    return { models: {}, error: `映射表 ${file} 读不了：${(e as Error).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { models: {}, error: `映射表 ${file} 应该是一个 JSON 对象` };
  }
  const table: YsmEmoteTable = { models: {} };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'current') {
      if (typeof value === 'string' && value) table.current = value;
    } else if (key === '_durations') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const durations: Record<string, number> = {};
      for (const [animation, seconds] of Object.entries(value as Record<string, unknown>)) {
        if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) durations[animation] = seconds;
      }
      table.durations = durations;
    } else if (!key.startsWith('_') && value && typeof value === 'object' && !Array.isArray(value)) {
      const map: Record<string, string> = {};
      for (const [emote, animation] of Object.entries(value as Record<string, unknown>)) {
        if (typeof animation === 'string' && animation) map[emote] = animation;
      }
      table.models[key] = map;
    }
  }
  return table;
}

// 查当前模型下某个表情对应的 YSM 动画；没配就返回 undefined
export function ysmAnimationFor(emote: string, table = loadYsmEmotes()): string | undefined {
  if (!table.current) return undefined;
  return table.models[table.current]?.[emote];
}

// ---- 动画自动收尾 ----
// YSM 的动画（比如跳舞）播出来会一直循环，要再播一次 idle 才停。
// 所以播了非 idle 的动画后安排一个计时器，到时间自动发 `ysm play <用户名> idle`。
// 同一时间只记一个：新动画顶掉旧计时；身体类工具开始时立刻收尾；Bot 断线时只清计时器不发命令

export const DEFAULT_YSM_SECONDS = 6;
export const YSM_IDLE = 'idle';

// 只用到 Bot 的这几样，测试里传个 EventEmitter 就行
interface BotLike {
  username: string;
  once(event: 'end', listener: () => void): unknown;
  removeListener(event: 'end', listener: () => void): unknown;
}

type RconOptions = { dir?: string; timeoutMs?: number };

interface AutoIdle {
  timer: NodeJS.Timeout;
  bot: BotLike;
  animation: string;
  deadline: number;
  options: RconOptions;
  onEnd: () => void;
}

let autoIdle: AutoIdle | null = null;

// 这个动画默认播几秒：映射表 _durations 里配了就用，否则 6 秒
export function ysmDurationFor(animation: string, table?: YsmEmoteTable): number {
  return table?.durations?.[animation] ?? DEFAULT_YSM_SECONDS;
}

function scheduleIdle(bot: BotLike, animation: string, ms: number, options: RconOptions): void {
  cancelYsmIdle();
  const onEnd = () => cancelYsmIdle();
  const timer = setTimeout(() => { void finishYsmAnimation('到时间'); }, ms);
  timer.unref?.();
  bot.once('end', onEnd);
  autoIdle = { timer, bot, animation, deadline: Date.now() + ms, options, onEnd };
}

// 取消收尾计时，不发命令；返回被取消的那条（没有就是 null）
export function cancelYsmIdle(): AutoIdle | null {
  const current = autoIdle;
  if (!current) return null;
  autoIdle = null;
  clearTimeout(current.timer);
  current.bot.removeListener('end', current.onEnd);
  return current;
}

// 正在等收尾的动画名（没有就是 undefined），给状态和测试用
export function pendingYsmAnimation(): string | undefined {
  return autoIdle?.animation;
}

// 立刻收尾：有动画在播就发 idle。失败只记日志
export async function finishYsmAnimation(reason = '收尾'): Promise<RconResult | null> {
  const current = cancelYsmIdle();
  if (!current) return null;
  const r = await playYsmAnimation(current.bot.username, YSM_IDLE, current.options);
  if (!r.ok) log('warn', `YSM 动画 ${current.animation}（${reason}）停不下来：${r.error}`);
  return r;
}

// 播一个动画并安排自动收尾。播 idle 本身就是停，不再安排；
// 没播成时，之前那个动画还在跳，把它的计时按剩余时间放回去
export async function playYsmWithAutoStop(
  bot: BotLike,
  animation: string,
  seconds: number,
  options: RconOptions = {}
): Promise<RconResult> {
  const previous = cancelYsmIdle();
  const r = await playYsmAnimation(bot.username, animation, options);
  if (r.ok) {
    if (animation !== YSM_IDLE) scheduleIdle(bot, animation, seconds * 1000, options);
  } else if (previous && previous.bot === bot && !autoIdle) {
    scheduleIdle(bot, previous.animation, Math.max(0, previous.deadline - Date.now()), previous.options);
  }
  return r;
}

// 身体类工具（走路、挖、放……）开始时，有动画在播就立刻收尾，免得边走路边跳舞。
// beginActivity 和 beginBody 都会通知，只有身体被占用时才算
onActivityStart(() => {
  if (autoIdle && bodyBusy()) void finishYsmAnimation('开始干活');
});
