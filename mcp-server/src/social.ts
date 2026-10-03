// 拟人行为：说话时看着对方、表情动作（空闲视线在 idle.ts）；说出的话同时写进 runtime/speech-<名字>.jsonl 供 TTS 朗读
import fs from 'node:fs';
import path from 'node:path';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { bodyBusy } from './task-control.js';
import { mayLook, claimGaze, type GazePriority } from './gaze.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_CHAT_LENGTH = 240;

let lastSpeaker = '';
let speechFile: string | null = null;

export const socialSettings = {
  idleLook: true,
  // 空闲小动作（看风景、换手、原地附近走几步），见 idle.ts
  idleActions: true
};

export function configureSocial(runtimeDir: string, username: string): void {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    speechFile = path.join(runtimeDir, `speech-${username}.jsonl`);
  } catch {
    speechFile = null;
  }
}

export function noteSpeaker(username: string): void {
  lastSpeaker = username;
}

// 小克开口说话时通知空闲视线（idle.ts）：对着谁说，接下来几秒就看着谁
const speakListeners = new Set<(to: string) => void>();

export function onSpeak(fn: (to: string) => void): () => void {
  speakListeners.add(fn);
  return () => speakListeners.delete(fn);
}

// 小克说出去的每一句（记忆日志用）
const spokenListeners = new Set<(text: string) => void>();

export function onSpoken(fn: (text: string) => void): () => void {
  spokenListeners.add(fn);
  return () => spokenListeners.delete(fn);
}

export function playerEntity(bot: Bot, username?: string): Entity | undefined {
  const name = username || lastSpeaker;
  if (!name) return undefined;
  const key = Object.keys(bot.players).find((n) => n.toLowerCase() === name.toLowerCase());
  return key ? bot.players[key]?.entity : undefined;
}

// 说话/表情时看向对方：正在干活、战斗时不抢视线
async function lookAtPlayer(bot: Bot, target: Entity | undefined, force = false, priority: GazePriority = 'chat'): Promise<boolean> {
  if (!target || target.position.distanceTo(bot.entity.position) > 16) return false;
  if (bot.pathfinder?.isMoving() || bot.targetDigBlock) return false;
  if (!mayLook(priority)) return false;
  await bot.lookAt(target.position.offset(0, target.height * 0.9, 0), force).catch(() => undefined);
  return true;
}

// 视线有没有被实心不透明方块挡住（从眼睛到对方头部逐段检查，未加载的区块当作看得见）
export function canSee(bot: Bot, target: Entity): boolean {
  const from = bot.entity.position.offset(0, (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
  const to = target.position.offset(0, (target.height ?? 1.8) * 0.9, 0);
  const d = to.minus(from);
  const steps = Math.ceil(d.norm() / 0.25);
  let last = '';
  for (let i = 1; i < steps; i++) {
    const p = from.plus(d.scaled(i / steps)).floored();
    const key = `${p.x},${p.y},${p.z}`;
    if (key === last) continue;
    last = key;
    const b = bot.blockAt(p);
    if (b && b.boundingBox === 'block' && !b.transparent) return false;
  }
  return true;
}

// 程序先反应（听到名字、被打）：立刻转头看向对方，并占住视线一会儿，免得空闲张望马上转走。
// 太远、看不见、正在走路挖掘、或视线被更高优先级占着时不转
export function glanceAt(
  bot: Bot,
  target: Entity | undefined,
  priority: GazePriority,
  { maxDistance = 16, holdMs = 2500, needSight = true } = {}
): boolean {
  if (!bot.entity || !target?.position) return false;
  if (target.position.distanceTo(bot.entity.position) > maxDistance) return false;
  if (bot.pathfinder?.isMoving() || bot.targetDigBlock) return false;
  if (!mayLook(priority)) return false;
  if (needSight && !canSee(bot, target)) return false;
  claimGaze(priority, holdMs);
  bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.9, 0), false).catch(() => undefined);
  return true;
}

// 说话：先看向对方，长消息按句子拆开，模仿打字间隔
export async function speak(bot: Bot, text: string, to?: string): Promise<void> {
  const listener = to || lastSpeaker;
  if (listener) {
    for (const fn of [...speakListeners]) {
      try {
        fn(listener);
      } catch {
        // 视线出错不影响说话
      }
    }
  }
  await lookAtPlayer(bot, playerEntity(bot, to));
  const parts: string[] = [];
  for (const line of text.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    let rest = line;
    while (rest.length > MAX_CHAT_LENGTH) {
      const cut = Math.max(rest.lastIndexOf('。', MAX_CHAT_LENGTH), rest.lastIndexOf('，', MAX_CHAT_LENGTH), 60);
      parts.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest) parts.push(rest);
  }
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(Math.min(2500, 400 + parts[i].length * 60));
    bot.chat(parts[i]);
    for (const fn of [...spokenListeners]) {
      try {
        fn(parts[i]);
      } catch {
        // 记日志出错不影响说话
      }
    }
    if (speechFile) {
      try {
        fs.appendFileSync(speechFile, JSON.stringify({ timestamp: Date.now(), text: parts[i] }) + '\n');
      } catch {
        // TTS 不是必须的
      }
    }
  }
}

export const EMOTES = ['nod', 'shake', 'wave', 'jump', 'crouch', 'spin', 'look'] as const;
export type Emote = typeof EMOTES[number];

// 会转头或移动的表情：干活、战斗时不做，免得打乱正在进行的动作
const BODY_EMOTES = new Set<Emote>(['nod', 'shake', 'jump', 'crouch', 'spin', 'look']);

export async function emote(bot: Bot, action: Emote, to?: string): Promise<string> {
  if (BODY_EMOTES.has(action) && (bodyBusy() || !mayLook('chat'))) {
    return `正在忙（${bodyBusy() ? '手上有活' : '在应付危险'}），先不做 ${action} 这个动作`;
  }
  const target = playerEntity(bot, to);
  if (target) await lookAtPlayer(bot, target, true);
  if (BODY_EMOTES.has(action)) claimGaze('chat', 1500);
  const { yaw, pitch } = bot.entity;
  switch (action) {
    case 'nod':
      for (let i = 0; i < 2; i++) {
        await bot.look(yaw, pitch - 0.5, true);
        await sleep(180);
        await bot.look(yaw, pitch + 0.2, true);
        await sleep(180);
      }
      await bot.look(yaw, pitch, true);
      return '点了点头';
    case 'shake':
      for (let i = 0; i < 2; i++) {
        await bot.look(yaw - 0.5, pitch, true);
        await sleep(160);
        await bot.look(yaw + 0.5, pitch, true);
        await sleep(160);
      }
      await bot.look(yaw, pitch, true);
      return '摇了摇头';
    case 'wave':
      for (let i = 0; i < 3; i++) {
        bot.swingArm('right');
        await sleep(250);
      }
      return '挥了挥手';
    case 'jump':
      for (let i = 0; i < 2; i++) {
        bot.setControlState('jump', true);
        await sleep(300);
        bot.setControlState('jump', false);
        await sleep(350);
      }
      return '开心地跳了两下';
    case 'crouch':
      for (let i = 0; i < 3; i++) {
        bot.setControlState('sneak', true);
        await sleep(200);
        bot.setControlState('sneak', false);
        await sleep(200);
      }
      return '蹲了几下打招呼';
    case 'spin':
      for (let i = 1; i <= 8; i++) {
        await bot.look(yaw + (Math.PI / 4) * i, pitch, true);
        await sleep(80);
      }
      return '转了一圈';
    case 'look':
      return target ? `看向 ${target.username}` : '附近没看到这个玩家';
  }
}
