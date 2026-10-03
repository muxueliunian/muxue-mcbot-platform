// 周围环境事件：敌对生物靠近、苦力怕/TNT 点燃的声音、爆炸。
// 做了去重和冷却：不为每次实体移动或脚步唤醒模型。没听到声音不代表安全
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { EventStore } from './event-store.js';
import { isHostile, notePrimed } from './reflexes.js';
import { poseOf, relative } from './perception.js';

export const HOSTILE_RANGE = 10;
export const HOSTILE_COOLDOWN_MS = 15000;
const HOSTILE_FORGET_MS = 60000;
const SOUND_RANGE = 16;
const EXPLOSION_RANGE = 32;
const DANGER_DEDUP_MS = 3000;
const PRIMED_SOUNDS = new Set(['entity.creeper.primed', 'entity.tnt.primed']);

function normalizeSound(name: string): string {
  return name.replace(/^minecraft:/, '').replace(/_/g, '.');
}

export function attachWorldWatchers(bot: Bot, events: EventStore): () => void {
  const reported = new Map<number, number>();
  let lastHostileEvent = 0;
  let lastDanger = { text: '', at: 0 };

  const danger = (key: string, text: string) => {
    const now = Date.now();
    if (lastDanger.text === key && now - lastDanger.at < DANGER_DEDUP_MS) return;
    lastDanger = { text: key, at: now };
    events.add('danger', text);
  };

  const timer = setInterval(() => {
    if (!bot.entity) return;
    const now = Date.now();
    for (const [id, at] of reported) if (now - at > HOSTILE_FORGET_MS || !bot.entities[id]) reported.delete(id);
    if (now - lastHostileEvent < HOSTILE_COOLDOWN_MS) return;
    const pose = poseOf(bot);
    const fresh = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position && isHostile(e) && !reported.has(e.id) && e.position.distanceTo(pose.pos) <= HOSTILE_RANGE)
      .sort((a, b) => a.position.distanceTo(pose.pos) - b.position.distanceTo(pose.pos));
    if (!fresh.length) return;
    lastHostileEvent = now;
    for (const e of fresh) reported.set(e.id, now);
    const parts = fresh.slice(0, 4).map((e) => `${e.name ?? e.displayName}（${relative(pose, e.position).text}）`);
    events.add('hostile', `敌对生物靠近：${parts.join('，')}${fresh.length > 4 ? ` 等 ${fresh.length} 个` : ''}`);
  }, 1000);

  const onSound = (name: string, pos: Vec3) => {
    if (!bot.entity || !pos) return;
    const sound = normalizeSound(name);
    if (!PRIMED_SOUNDS.has(sound)) return;
    const d = pos.distanceTo(bot.entity.position);
    if (d > SOUND_RANGE) return;
    notePrimed(pos);
    const what = sound.includes('creeper') ? '苦力怕' : 'TNT';
    danger(`primed:${what}`, `听到${what}点燃的声音，在我${relative(poseOf(bot), pos).text}，快要爆炸了 [声音]`);
  };
  bot.on('soundEffectHeard', onSound);

  const client = (bot as unknown as { _client?: { on: (e: string, f: (p: unknown) => void) => void; removeListener: (e: string, f: (p: unknown) => void) => void } })._client;
  const onExplosion = (packet: unknown) => {
    const p = packet as { x?: number; y?: number; z?: number };
    if (!bot.entity || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return;
    const pos = new Vec3(p.x, p.y, p.z);
    const d = pos.distanceTo(bot.entity.position);
    if (d > EXPLOSION_RANGE) return;
    danger(`explosion:${Math.floor(p.x / 4)},${Math.floor(p.z / 4)}`, `${relative(poseOf(bot), pos).text}发生了爆炸`);
  };
  client?.on('explosion', onExplosion);

  const detach = () => {
    clearInterval(timer);
    bot.removeListener('soundEffectHeard', onSound);
    client?.removeListener('explosion', onExplosion);
  };
  bot.once('end', detach);
  return detach;
}
