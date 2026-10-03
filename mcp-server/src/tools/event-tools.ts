// 事件等待工具：代替定时轮询，有新事件时立即返回
import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { EventStore } from '../event-store.js';
import { speak } from '../social.js';

let cursor = 0;

export function registerEventTools(factory: ToolFactory, events: EventStore, getBot: () => Bot): void {
  factory.registerTool(
    "wait-for-events",
    "Block until something happens in game (chat, being hurt, player join/leave, night/day, death, auto reflexes), then return all new events since the last call. Use this in a loop instead of polling on a timer. Pass `say` to send a chat message first (saves a separate send-chat call)",
    {
      timeoutSeconds: z.coerce.number().finite().min(0).max(300).optional().describe("Max seconds to wait (default: 60, 0 = just read what is already there)"),
      types: z.array(z.string()).optional().describe("Only return these event types: chat, whisper, hurt (says who hit you when known), low_health, death (includes the death message when known), player_joined, player_left, player_death (another player died, with the original death message), advancement (a player made an advancement/goal/challenge), player_sleep (a real player got into bed; you can join with sleep-in-bed, using use-entrance first if the bed is indoors), sleep (you yourself fell asleep in a bed), time, reflex, task, hostile (mobs came close, rate-limited), danger (creeper/TNT fuse sound or explosion nearby), follow (stopped following and why), presence (auto logged off when nobody was controlling or no players were online, rejoined automatically, or blocked because another session controls the bot)"),
      say: z.string().optional().describe("Chat message to send before waiting")
    },
    async ({ timeoutSeconds = 60, types, say }) => {
      // 不在线（停放）时照常等事件，只是说不了话
      let sayNote = '';
      if (say) {
        if (factory.offlineNote()) {
          sayNote = `没发出去（不在线）：${say}\n`;
        } else {
          await speak(getBot(), say);
          sayNote = `已发送：${say}\n`;
        }
      }
      cursor = Math.max(cursor, events.deliveredSeq());
      const found = await events.waitForNew(cursor, timeoutSeconds * 1000, types);
      const job = factory.runningJob();
      const offline = factory.offlineNote();
      const prefix = sayNote + (offline ? `${offline}\n` : '') + (job ? `后台任务进行中：${job}\n` : '');
      if (found.length === 0) {
        return factory.createResponse(`${prefix}${timeoutSeconds} 秒内没有新事件`);
      }
      cursor = found[found.length - 1].seq;
      events.markConsumed(cursor);
      const lines = found.map((e) => `[${new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}] ${e.type}: ${e.text}`);
      return factory.createResponse(`${prefix}${found.length} 个新事件：\n${lines.join('\n')}`);
    }
  );
}
