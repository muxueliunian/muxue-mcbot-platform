// 把 mineflayer 的游戏事件转成 EventStore 里的事件，并启动本能反应
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { EventStore } from './event-store.js';
import { startReflexes } from './reflexes.js';
import { startSwimReflex } from './swim.js';
import { noteSpeaker } from './social.js';
import { attachWorldWatchers } from './world-events.js';
import { startIdleActions } from './idle.js';
import { attachReactions, reactToHurt, reactToSpeaker } from './reactions.js';

export function attachGameEvents(bot: Bot, events: EventStore): void {
  let wasNight: boolean | null = null;
  let lowHealthWarned = false;
  let spawned = false;
  const deaths = attachReactions(bot, events);

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    noteSpeaker(username);
    reactToSpeaker(bot, username, message);
    events.add('chat', `${username}: ${message}`);
  });

  bot.on('whisper', (username, message) => {
    if (username === bot.username) return;
    noteSpeaker(username);
    reactToSpeaker(bot, username, message, true);
    events.add('whisper', `${username} 悄悄对你说: ${message}`);
  });

  bot.on('playerJoined', (player) => {
    // 刚登录时服务器会发送已在线玩家列表，不算新进入
    if (!spawned || player.username === bot.username) return;
    events.add('player_joined', `${player.username} 进入了游戏`);
  });

  bot.on('playerLeft', (player) => {
    if (player.username === bot.username) return;
    events.add('player_left', `${player.username} 离开了游戏`);
  });

  bot.on('entityHurt', (entity, source?: Entity) => {
    if (entity !== bot.entity) return;
    const by = reactToHurt(bot, source);
    events.add('hurt', `受到伤害${by ? `，${by}` : ''}，生命值 ${bot.health.toFixed(1)}/20`);
  });

  bot.on('health', () => {
    if (bot.health <= 6 && !lowHealthWarned) {
      lowHealthWarned = true;
      events.add('low_health', `生命值很低：${bot.health.toFixed(1)}/20，饥饿值 ${bot.food}/20`);
    } else if (bot.health > 10) {
      lowHealthWarned = false;
    }
  });

  // 自己躺上床（sleep-in-bed 成功）：托管驱动器据此整理记忆，不叫醒 agent
  bot.on('sleep', () => {
    events.add('sleep', '你躺上床睡着了');
  });

  bot.on('death', () => {
    // 死因原文从系统消息里来，由 reactions 合并后再发 death 事件
    deaths.onDeath();
  });

  bot.on('time', () => {
    const t = bot.time.timeOfDay;
    const isNight = t >= 12542 && t <= 23460;
    if (wasNight !== null && isNight !== wasNight) {
      events.add('time', isNight ? '天黑了，怪物开始出现' : '天亮了');
    }
    wasNight = isNight;
  });

  bot.once('spawn', () => {
    spawned = true;
    events.add('spawn', `已进入服务器，位置 (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)})`);
    startReflexes(bot, (type, text) => events.add(type, text));
    startSwimReflex(bot, (type, text) => events.add(type, text));
    startIdleActions(bot);
    attachWorldWatchers(bot, events);
    // 被传送（/tp、末影珍珠等）：服务器改了位置且跳得远，托管时要叫醒 agent，不然它还以为自己在原地
    let last = bot.entity.position.clone();
    bot.on('move', () => {
      last = bot.entity.position.clone();
    });
    bot.on('forcedMove', () => {
      const p = bot.entity.position;
      if (p.distanceTo(last) > 8) {
        const f = (v: typeof p) => `(${Math.floor(v.x)}, ${Math.floor(v.y)}, ${Math.floor(v.z)})`;
        events.add('teleport', `被传送到 ${f(p)}（原来在 ${f(last)}）`);
      }
      last = p.clone();
    });
  });
}
