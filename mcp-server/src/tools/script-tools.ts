// 小克自己写的行为脚本：放在 bot-scripts/*.mjs，改完立即生效（不用重新编译、不用重启）
// 脚本格式见 bot-scripts/README.md
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from "zod";
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { TaskHandle, startTask, runInTask, endTask, staleReason } from '../task-control.js';
import { speak } from '../social.js';
import { log } from '../logger.js';
import { createBotFacade } from '../script-facade.js';
import { safeGoto } from '../movement.js';

const { goals } = pathfinderPkg;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
// 防手滑的约束，不是安全沙箱：脚本只应通过 ctx 和游戏交互（ctx.bot 是受控接口，动作仍经过统一的保护检查）
const FORBIDDEN = [
  { re: /(^|[\n;])\s*import[\s{*]|\bimport\s*\(/, why: '不能 import，需要的东西都在 ctx 里' },
  { re: /\brequire\s*\(/, why: '不能 require' },
  { re: /\bprocess\s*\./, why: '不能访问 process' },
  { re: /\b(eval|Function)\s*\(/, why: '不能 eval' },
  { re: /\bfetch\s*\(/, why: '不能联网' },
];

class ScriptStopped extends Error {}

interface ScriptModule {
  meta?: { description?: string; params?: Record<string, string> };
  default?: (ctx: unknown, params: Record<string, unknown>) => Promise<unknown>;
}

function scriptPath(dir: string, name: string): string {
  return path.join(dir, `${name}.mjs`);
}

async function loadScript(file: string): Promise<ScriptModule> {
  const source = fs.readFileSync(file, 'utf8');
  for (const rule of FORBIDDEN) {
    if (rule.re.test(source)) throw new Error(`脚本不合规：${rule.why}`);
  }
  const mtime = fs.statSync(file).mtimeMs;
  return await import(`${pathToFileURL(file).href}?v=${mtime}`) as ScriptModule;
}

export function registerScriptTools(factory: ToolFactory, getBot: () => Bot, scriptsDir: string): void {
  fs.mkdirSync(scriptsDir, { recursive: true });

  factory.registerTool(
    "list-scripts",
    `List your own behavior scripts in ${scriptsDir} (name, description, params) and check that they load. Write new ones there with your file tools when you notice a repeated multi-step routine (format: README.md in that folder); they take effect immediately`,
    {},
    async () => {
      const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')).sort();
      if (!files.length) return factory.createResponse(`还没有脚本。目录：${scriptsDir}`);
      const lines: string[] = [];
      for (const f of files) {
        const name = f.replace(/\.mjs$/, '');
        try {
          const mod = await loadScript(path.join(scriptsDir, f));
          const params = Object.entries(mod.meta?.params ?? {}).map(([k, v]) => `${k}：${v}`).join('；');
          const ok = typeof mod.default === 'function' ? '' : '（缺少 default 导出函数）';
          lines.push(`- ${name}：${mod.meta?.description ?? '（无说明）'}${params ? `｜参数 ${params}` : ''}${ok}`);
        } catch (err) {
          lines.push(`- ${name}：加载失败 ${(err as Error).message}`);
        }
      }
      return factory.createResponse(`脚本目录 ${scriptsDir}\n${lines.join('\n')}`);
    }
  );

  factory.registerTool(
    "run-script",
    "Run one of your behavior scripts from bot-scripts. Returns its result text plus its log. Stops early (ctx.checkpoint throws) on stop-action, timeout, being hurt, or when a player calls you",
    {
      name: z.string().describe("Script name (file name without .mjs)"),
      params: z.record(z.unknown()).optional().describe("Parameters passed to the script"),
      timeoutSeconds: z.coerce.number().int().min(5).max(1800).optional().describe("Time limit (default: 300)"),
      interruptOnChat: z.boolean().optional().describe("Stop when someone mentions your name or says stop (default: true)")
    },
    async ({ name, params = {}, timeoutSeconds = 300, interruptOnChat = true }) => {
      if (!NAME_RE.test(name)) return factory.createResponse('脚本名只能用小写字母、数字和连字符');
      const file = scriptPath(scriptsDir, name);
      if (!fs.existsSync(file)) return factory.createResponse(`没有脚本 ${name}，先用 list-scripts 看看有哪些`);

      const mod = await loadScript(file);
      if (typeof mod.default !== 'function') return factory.createResponse(`${name} 没有 default 导出函数`);

      const bot = getBot();
      // 脚本有自己的任务上下文：结束（完成、出错、超时、被停）后，它残留的异步代码发出的动作都会被拒绝
      const scriptTask = startTask(`脚本 ${name}`, bot);
      const handle = runInTask(scriptTask, () => new TaskHandle({ timeoutMs: timeoutSeconds * 1000, interruptOnChat }));
      const logs: string[] = [];
      let stopReason: string | null = null;
      const checkpoint = () => {
        stopReason ??= staleReason(scriptTask, getBot()) ?? handle.check();
        if (stopReason) throw new ScriptStopped(stopReason);
      };
      const ctx = {
        bot: createBotFacade(bot, scriptTask),
        Vec3,
        goals,
        mcData: minecraftData(bot.version),
        params,
        // 调用已有的 MCP 工具，例如 await ctx.tool('mine-blocks', { blockTypes: ['*_log'], count: 4 })
        tool: async (toolName: string, args: Record<string, unknown> = {}) => {
          checkpoint();
          if (toolName === 'run-script') throw new Error('脚本里不能再调用 run-script');
          const text = await factory.invoke(toolName, args);
          logs.push(`[${toolName}] ${text.split('\n')[0]}`);
          return text;
        },
        say: async (text: string) => {
          checkpoint();
          if (/^\s*\//m.test(text)) throw new Error('ctx.say 不能发送 / 开头的命令');
          await speak(bot, text);
        },
        // 安全地走过去：不挖方块、不垫方块；到不了会抛出错误
        goto: async (goal: Parameters<typeof safeGoto>[1], options: { timeoutMs?: number } = {}) => {
          checkpoint();
          await safeGoto(bot, goal, { timeoutMs: options.timeoutMs ?? 60000, check: () => { try { checkpoint(); return null; } catch (e) { return (e as Error).message; } } });
          checkpoint();
        },
        sleep: async (ms: number) => {
          checkpoint();
          await new Promise((resolve) => setTimeout(resolve, ms));
          checkpoint();
        },
        log: (...items: unknown[]) => {
          if (logs.length < 200) logs.push(items.map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join(' '));
        },
        checkpoint,
      };

      const started = Date.now();
      let result: unknown;
      let failure: string | null = null;
      // 保底计时：脚本不调用 checkpoint 时也按时返回
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          runInTask(scriptTask, () => mod.default!(ctx, params)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new ScriptStopped(`达到时间上限 ${timeoutSeconds} 秒`)), timeoutSeconds * 1000 + 2000);
          })
        ]);
      } catch (err) {
        if (err instanceof ScriptStopped) {
          stopReason = err.message;
        } else {
          failure = (err as Error)?.stack?.split('\n').slice(0, 4).join('\n') ?? String(err);
          log('warn', `run-script ${name}: ${failure}`);
        }
      } finally {
        if (timer) clearTimeout(timer);
        // Promise.race 只是不再等脚本了，脚本本身可能还在跑：作废它的任务上下文，之后的动作一律拒绝
        endTask(scriptTask, stopReason ? `已停止（${stopReason}）` : failure ? '已出错结束' : '已结束');
        if (stopReason || failure) {
          // 停止时放下正在进行的移动，避免脚本残留动作
          bot.pathfinder.setGoal(null);
          bot.clearControlStates();
        }
      }

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const lines = [`脚本 ${name} 用时 ${secs} 秒`];
      if (result !== undefined && result !== null) lines.push(`结果：${typeof result === 'string' ? result : JSON.stringify(result)}`);
      if (stopReason) lines.push(`提前停止：${stopReason}`);
      if (failure) lines.push(`出错：${failure}\n（改好脚本文件后直接再运行即可）`);
      if (logs.length) lines.push('日志：', ...logs.slice(-30));
      return factory.createResponse(lines.join('\n'));
    }
  );
}
