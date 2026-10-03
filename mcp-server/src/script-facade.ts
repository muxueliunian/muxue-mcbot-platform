// 脚本看到的 ctx.bot：保留查询能力和常用动作，但
// - 动作都经过 action-policy 的守卫（和工具走同一套检查）
// - 不暴露底层连接、寻路配置、退出等能力
// - 脚本注册的事件监听器绑定到脚本任务上，任务结束后自动移除，之后不能再借监听器发动作
// 这不是安全沙箱：它约束的是正常写法，不能防住刻意绕过的 JavaScript
import { AsyncResource } from 'node:async_hooks';
import type { Bot } from 'mineflayer';
import type { TaskContext } from './task-control.js';

const DENIED = new Set([
  '_client', 'quit', 'end', 'connect', 'loadPlugin', 'loadPlugins', 'hasPlugin', 'chat', 'whisper', 'setSettings',
  'setCommandBlock', 'creative', 'physics', 'removeAllListeners', 'emit', 'tabComplete', 'respawn', 'acceptResourcePack',
  'denyResourcePack', 'setMaxListeners'
]);
const LISTEN = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
const UNLISTEN = new Set(['off', 'removeListener']);

type Listener = (...args: unknown[]) => unknown;

export function createBotFacade(bot: Bot, ctx: TaskContext): Bot {
  const wrapped = new Map<Listener, Listener>();

  const pathfinder = {
    goto: (goal: unknown) => bot.pathfinder.goto(goal as never),
    setGoal: (goal: unknown, dynamic?: boolean) => bot.pathfinder.setGoal(goal as never, dynamic),
    stop: () => bot.pathfinder.stop(),
    isMoving: () => bot.pathfinder.isMoving(),
    isMining: () => bot.pathfinder.isMining(),
    isBuilding: () => bot.pathfinder.isBuilding(),
    bestHarvestTool: (block: unknown) => bot.pathfinder.bestHarvestTool(block as never),
    get goal() {
      return bot.pathfinder.goal;
    }
  };

  const handler: ProxyHandler<Bot> = {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        if (DENIED.has(prop)) {
          throw new Error(`脚本里不能使用 bot.${prop}（说话用 ctx.say，走路用 ctx.goto，改方块用 ctx.tool）`);
        }
        if (prop === 'pathfinder') return pathfinder;
        if (LISTEN.has(prop)) {
          return (event: string, listener: Listener) => {
            // 监听器在脚本任务的上下文里执行：任务结束后它发出的动作会被拒绝
            const bound = AsyncResource.bind(listener) as Listener;
            wrapped.set(listener, bound);
            (target as unknown as Record<string, Listener>)[prop].call(target, event, bound);
            ctx.cleanups.push(() => target.removeListener(event as never, bound as never));
            return receiver;
          };
        }
        if (UNLISTEN.has(prop)) {
          return (event: string, listener: Listener) => {
            target.removeListener(event as never, (wrapped.get(listener) ?? listener) as never);
            return receiver;
          };
        }
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
    set(_target, prop) {
      throw new Error(`脚本里不能修改 bot.${String(prop)}`);
    },
    defineProperty(_target, prop) {
      throw new Error(`脚本里不能修改 bot.${String(prop)}`);
    },
    deleteProperty(_target, prop) {
      throw new Error(`脚本里不能删除 bot.${String(prop)}`);
    }
  };
  return new Proxy(bot, handler);
}
