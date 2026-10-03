// 程序先反应和系统消息事件（不经过 LLM）：
// 1. 真人玩家叫小克的名字或私聊时立刻转头看对方；被打时看向攻击者
// 2. 解析系统消息：死亡消息（death.*）→ player_death / 补进自己的 death 事件；进度（chat.type.advancement.*）→ advancement
// 3. 真人玩家躺上床 → player_sleep（同一玩家短时间内只报一次；跟不跟着睡由 AI 决定）
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { EventStore } from './event-store.js';
import { glanceAt, playerEntity } from './social.js';
import { taskNames } from './task-control.js';
import { isHostile, reflexSettings } from './reflexes.js';

export const MENTION_HOLD_MS = 2500;
export const HURT_LOOK_RANGE = 24;
export const SLEEP_DEDUP_MS = 60000;
// 自己死亡：死亡消息一般比血量归零先到；没先到就最多等这么久再发 death 事件
export const DEATH_CAUSE_WAIT_MS = 1500;
const DEATH_CAUSE_FRESH_MS = 5000;
const DEATH_SUPPLEMENT_MS = 10000;

// 其他 Bot 的游戏名（小写），它们不算真人玩家
let botPlayers = ['claude', 'gemini'];

export function configureReactions({ botPlayers: list }: { botPlayers?: string[] } = {}): void {
  if (list) botPlayers = list.filter(Boolean).map((n) => n.toLowerCase());
}

export function isRealPlayer(bot: Bot, name: string | undefined | null): boolean {
  if (!name || name === bot.username) return false;
  return !botPlayers.includes(name.toLowerCase());
}

// 聊天内容里有没有小克的游戏名或昵称（不分大小写）
export function mentionsMe(bot: Bot, message: string): boolean {
  const names = taskNames().length ? taskNames() : [bot.username.toLowerCase()];
  const text = message.toLowerCase();
  return names.some((n) => n && text.includes(n));
}

// 聊天/私聊：真人玩家叫名字（私聊总是算）就转头看说话的人
export function reactToSpeaker(bot: Bot, username: string, message: string, whisper = false): boolean {
  if (!isRealPlayer(bot, username)) return false;
  if (!whisper && !mentionsMe(bot, message)) return false;
  return glanceAt(bot, playerEntity(bot, username), 'chat', { holdMs: MENTION_HOLD_MS });
}

function describeAttacker(source: Entity): string {
  if (source.type === 'player') return source.username ?? '玩家';
  return source.name ?? source.displayName ?? '未知生物';
}

// 被打：看向攻击者，返回"被 xxx 打了"（不知道是谁打的就返回空串）。
// 自动反击范围内的敌对生物交给反击逻辑转头，这里不抢
export function reactToHurt(bot: Bot, source: Entity | undefined | null): string {
  if (!source || source === bot.entity || !source.position) return '';
  const who = describeAttacker(source);
  const defending = isHostile(source) && reflexSettings.autoDefend
    && source.position.distanceTo(bot.entity.position) <= reflexSettings.defendRange;
  if (!defending) glanceAt(bot, source, 'observe', { maxDistance: HURT_LOOK_RANGE, holdMs: 2000, needSight: false });
  return `被 ${who} 打了`;
}

// ---- 系统消息 ----

// prismarine-chat 的 ChatMessage 里用到的部分
export interface ChatLike {
  translate?: string;
  with?: ChatLike[];
  json?: { insertion?: unknown };
  toString(): string;
}

export type SystemEvent =
  | { kind: 'death'; player: string; self: boolean; text: string }
  | { kind: 'advancement'; player: string; self: boolean; level: 'task' | 'goal' | 'challenge'; title: string; text: string };

// 消息组件里的玩家名：优先用 insertion（原版玩家显示名都带），否则按文字去匹配在线玩家（队伍前缀会带在文字里）
function playerName(bot: Bot, part: ChatLike | undefined): string | null {
  if (!part) return null;
  const known = [bot.username, ...Object.keys(bot.players ?? {})];
  const insertion = part.json?.insertion;
  if (typeof insertion === 'string') {
    return known.find((n) => n.toLowerCase() === insertion.toLowerCase()) ?? insertion;
  }
  const text = part.toString().trim();
  const exact = known.find((n) => n === text);
  if (exact) return exact;
  const last = text.split(/\s+/).pop() ?? '';
  return known.find((n) => n === last) ?? null;
}

export function parseSystemMessage(bot: Bot, msg: ChatLike): SystemEvent | null {
  const key = msg.translate;
  if (!key) return null;
  // message_too_long 里只有截断后的纯文字，认不出是谁，跳过
  if (key.startsWith('death.') && key !== 'death.attack.message_too_long') {
    const player = playerName(bot, msg.with?.[0]);
    if (!player) return null;
    return { kind: 'death', player, self: player === bot.username, text: msg.toString() };
  }
  const adv = /^chat\.type\.advancement\.(task|goal|challenge)$/.exec(key);
  if (adv) {
    const player = playerName(bot, msg.with?.[0]);
    if (!player) return null;
    const title = (msg.with?.[1]?.toString() ?? '').trim().replace(/^\[(.*)\]$/, '$1');
    return { kind: 'advancement', player, self: player === bot.username, level: adv[1] as 'task' | 'goal' | 'challenge', title, text: msg.toString() };
  }
  return null;
}

const ADV_WORD = { task: '进度', goal: '目标', challenge: '挑战' } as const;

// 自己的死亡：把死因原文合并进 death 事件。
// 死亡消息先到就直接合并；血量先归零就等一小会儿；等不到先发不带死因的，死因晚到再补一条
export function createDeathReporter(events: EventStore) {
  let cause: { text: string; at: number } | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let bareAt = 0;
  const BASE = '死亡了，已在重生点复活';

  return {
    onDeath(): void {
      if (pending) return;
      if (cause && Date.now() - cause.at < DEATH_CAUSE_FRESH_MS) {
        events.add('death', `${BASE}。死因：${cause.text}`);
        cause = null;
        return;
      }
      cause = null;
      pending = setTimeout(() => {
        pending = null;
        bareAt = Date.now();
        events.add('death', BASE);
      }, DEATH_CAUSE_WAIT_MS);
    },
    onCause(text: string): void {
      if (pending) {
        clearTimeout(pending);
        pending = null;
        events.add('death', `${BASE}。死因：${text}`);
        return;
      }
      if (bareAt && Date.now() - bareAt < DEATH_SUPPLEMENT_MS) {
        bareAt = 0;
        events.add('death', `补充刚才的死因：${text}`);
        return;
      }
      cause = { text, at: Date.now() };
    },
    dispose(): void {
      if (pending) clearTimeout(pending);
      pending = null;
    }
  };
}

// 监听系统消息和躺床，返回自己的死亡处理器（game-events 的 death 事件要用）
export function attachReactions(bot: Bot, events: EventStore) {
  const deaths = createDeathReporter(events);
  const slept = new Map<string, number>();

  bot.on('message', (jsonMsg: unknown) => {
    let parsed: SystemEvent | null = null;
    try {
      parsed = parseSystemMessage(bot, jsonMsg as ChatLike);
    } catch {
      return;
    }
    if (!parsed) return;
    if (parsed.kind === 'death') {
      if (parsed.self) deaths.onCause(parsed.text);
      else events.add('player_death', `${parsed.player} 死了：${parsed.text}`);
    } else {
      const who = parsed.self ? '你自己' : parsed.player;
      events.add('advancement', `${who} 完成了${ADV_WORD[parsed.level]}「${parsed.title}」：${parsed.text}`);
    }
  });

  bot.on('entitySleep', (entity: Entity) => {
    if (entity?.type !== 'player' || !isRealPlayer(bot, entity.username)) return;
    const name = entity.username!;
    const now = Date.now();
    if (now - (slept.get(name) ?? 0) < SLEEP_DEDUP_MS) return;
    slept.set(name, now);
    events.add('player_sleep', `${name} 躺到床上了。想一起睡可以用 sleep-in-bed（床在屋里要先 use-entrance 进门）`);
  });

  bot.once('end', () => deaths.dispose());
  return deaths;
}
