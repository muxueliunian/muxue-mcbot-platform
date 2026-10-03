import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import type { Bot } from 'mineflayer';
import { BotConnection } from './bot-connection.js';
import { EventStore } from './event-store.js';
import {
  beginActivity, endActivity, beginBody, endBody, taskGeneration, startTask, runInTask, runOutsideTask, endTask, currentTask, staleReason,
  isDescendantOf, TaskCancelled, type TaskContext
} from './task-control.js';
import { log } from './logger.js';
import type { Presence } from './presence.js';

export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };
export type ToolContent = TextContent | ImageContent;

export type McpResponse = {
  content: ToolContent[];
  isError?: boolean;
  [key: string]: unknown;
};

// 单张图片的上限（原始字节）。Base64 后约 4.7MB，留在常见图片接口的 5MB 限制以内
export const MAX_IMAGE_BYTES = 3_500_000;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

// 只取文字部分；图片不会传给脚本或后台事件，只留一句说明
export function textOf(result: McpResponse): string {
  const texts = result.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text);
  const images = result.content.length - texts.length;
  if (images > 0) texts.push(`[结果里有 ${images} 张图片，这里只返回文字；要看图请直接调用这个工具]`);
  return texts.join('\n');
}

// 空闲判断时不算"在干活"的工具
const PASSIVE_TOOLS = new Set(['wait-for-events', 'read-chat', 'get-status', 'list-inventory', 'list-scripts', 'list-regions', 'list-farms', 'list-places', 'list-blueprints', 'survey-site', 'find-site', 'render-blueprint', 'import-schematic', 'observe', 'map-view', 'look', 'player-view', 'list-game-windows', 'memory-context', 'memory-note', 'memory-recall', 'memory-write']);
// 不需要 Bot 也能执行的工具：小克不在线时照常执行，也不会让她进服
const OFFLINE_TOOLS = new Set(['wait-for-events', 'read-chat', 'list-scripts', 'list-farms', 'list-game-windows', 'select-game-window', 'list-blueprints', 'delete-blueprint', 'clear-preview', 'import-schematic', 'edit-blueprint', 'memory-context', 'memory-note', 'memory-recall', 'memory-write']);
// 可以放到后台跑的长任务：后台跑的时候 agent 还能继续聊天
const BACKGROUND_TOOLS = new Set(['run-script', 'mine-blocks', 'build', 'tend-farm', 'prepare-materials']);
// 不占用身体的工具：后台任务运行中、或另一个前台动作进行中也可以调用
const SAFE_DURING_JOB = new Set([
  ...PASSIVE_TOOLS, 'send-chat', 'emote', 'stop-action', 'set-reflexes', 'get-position', 'find-blocks',
  'get-block-info', 'find-entity', 'find-item', 'detect-gamemode', 'can-craft', 'get-recipe', 'list-recipes',
  'check-action', 'register-region', 'remove-region', 'register-entrance', 'remove-entrance', 'set-focus', 'clear-focus',
  'register-farm', 'remove-farm', 'remember-place', 'forget-place', 'select-game-window',
  'save-blueprint', 'delete-blueprint', 'clear-preview', 'edit-blueprint',
  'memory-context', 'memory-note', 'memory-recall', 'memory-write'
]);

interface BackgroundJob {
  id: number;
  label: string;
  startedAt: number;
  generation: number;
  ctx: TaskContext;
  done: Promise<void>;
}

type Executor = (args: any) => Promise<McpResponse>;

export class ToolFactory {
  private executors = new Map<string, { schema: Record<string, unknown>; executor: Executor }>();
  private job: BackgroundJob | null = null;
  private jobCount = 0;
  // 正在执行的前台身体动作（同一时间只允许一个）
  private foreground: string | null = null;

  constructor(
    private server: McpServer,
    private connection: BotConnection,
    private events?: EventStore,
    // 在线管理；不传时（离线测试）行为和以前一样：每次调用都检查连接、断线就重连
    private presence?: Presence
  ) {
    presence?.setJobProbe(() => this.job !== null);
  }

  // 小克不在线时的说明（停放原因等），在线时返回 null
  offlineNote(): string | null {
    if (this.presence) return this.presence.offlineNote();
    return this.connection.isConnected() ? null : '还没有连上服务器';
  }

  private bot(): Bot | null {
    return this.connection.getBot();
  }

  // 正在后台运行的任务说明，没有时返回 null
  runningJob(): string | null {
    if (!this.job) return null;
    return `#${this.job.id} ${this.job.label}（已运行 ${Math.round((Date.now() - this.job.startedAt) / 1000)} 秒）`;
  }

  // 等后台任务完全结束（测试和收尾用）
  async settle(): Promise<void> {
    await this.job?.done;
  }

  private startBackground(name: string, args: Record<string, unknown>, executor: Executor): McpResponse {
    const id = ++this.jobCount;
    const label = name === 'run-script' ? `run-script ${String(args.name)}` : name;
    const ctx = startTask(`后台任务 #${id} ${label}`, this.bot(), null);
    beginActivity();
    beginBody();
    const done = runInTask(ctx, async () => {
      let text: string;
      try {
        const result = await executor(args);
        text = textOf(result);
        if (result.isError) text = `出错：${text}`;
      } catch (error) {
        text = `出错：${(error as Error).message}`;
      } finally {
        endTask(ctx);
        endActivity();
        endBody();
        if (this.job?.id === id) this.job = null;
      }
      const lines = text.split('\n');
      const summary = lines.slice(0, 12).join(' | ') + (lines.length > 12 ? ` | …（共 ${lines.length} 行）` : '');
      this.events?.add('task', `后台任务 #${id} ${label} 结束：${summary}`);
      log('info', `background job #${id} ${label} finished`);
    });
    this.job = { id, label, startedAt: Date.now(), generation: taskGeneration(), ctx, done };
    return this.createResponse(
      `已在后台开始任务 #${id}（${label}）。现在可以继续用 wait-for-events 听聊天、send-chat 说话；` +
      `结束时会收到 task 事件。要中途停下用 stop-action。任务期间不要调用移动/挖掘/放置类工具。`
    );
  }

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: Executor
  ): void {
    this.executors.set(name, { schema, executor });
    const canBackground = BACKGROUND_TOOLS.has(name);
    const publicSchema = canBackground
      ? {
          ...schema,
          background: z.boolean().optional().describe(
            "Run in the background and return immediately, so you can keep chatting (wait-for-events / send-chat) while it runs. A `task` event arrives when it ends. In background, chat does not interrupt it by default; use stop-action to stop"
          )
        }
      : schema;
    this.server.tool(name, description, publicSchema, async (args: unknown): Promise<McpResponse> => {
      // 外部调用不继承任何旧任务的上下文
      return await runOutsideTask(() => this.handleCall(name, schema, executor, args, canBackground));
    });
  }

  private async handleCall(name: string, schema: Record<string, unknown>, executor: Executor, args: unknown, canBackground: boolean): Promise<McpResponse> {
    // 所有工具调用（包括被动工具）都算“有人控制”
    this.presence?.toolStarted();
    try {
      return await this.runCall(name, schema, executor, args, canBackground);
    } finally {
      this.presence?.toolEnded();
    }
  }

  // 调用前的连接检查：被动工具不触发进服；非被动工具不在线时照常进服（停放中也一样）
  private async checkConnection(name: string): Promise<McpResponse | null> {
    const fail = (text: string): McpResponse => ({ content: [{ type: "text", text }], isError: true });
    if (!this.presence) {
      const connectionCheck = await this.connection.checkConnectionAndReconnect();
      return connectionCheck.connected ? null : fail(connectionCheck.message!);
    }
    if (this.connection.isConnected() || OFFLINE_TOOLS.has(name)) return null;
    // 没人控制而下线后，有会话来查状态就说明又有人控制了（交互式会话开局第一件事就是 get-status）
    const statusRejoin = name === 'get-status' && this.presence.parkReason() === 'uncontrolled';
    if (name === 'get-status' && !statusRejoin) {
      // 查状态不算出错：说清为什么不在线、怎么进服
      return this.createResponse(`${this.presence.offlineNote() ?? '不在线'}
（不在线时查不到位置、生命值等状态）`);
    }
    if (PASSIVE_TOOLS.has(name) && !statusRejoin) {
      return fail(`${this.presence.offlineNote() ?? '不在线'}
${name} 需要在线才能用；被动工具不会触发进服。`);
    }
    const result = await this.presence.ensureConnected();
    return result.connected ? null : fail(result.message ?? '没能进服');
  }

  private async runCall(name: string, schema: Record<string, unknown>, executor: Executor, args: unknown, canBackground: boolean): Promise<McpResponse> {
    const offline = await this.checkConnection(name);
    if (offline) return offline;

    const bodyTool = !SAFE_DURING_JOB.has(name);
    if (this.job && bodyTool) {
      // 刚调用过 stop-action 时任务正在收尾，稍等它结束
      if (this.job.generation !== taskGeneration()) {
        await Promise.race([this.job.done, new Promise((resolve) => setTimeout(resolve, 8000))]);
      }
      if (this.job) {
        return this.createErrorResponse(
          `后台任务 ${this.runningJob()} 还在运行。先等它结束（task 事件），或者用 stop-action 停下再做 ${name}`
        );
      }
    }
    if (bodyTool && this.foreground) {
      return this.createErrorResponse(`${this.foreground} 还在执行，等它结束或者先 stop-action 再做 ${name}`);
    }

    const ctx = startTask(name, this.bot(), null);
    const passive = PASSIVE_TOOLS.has(name);
    if (!passive) beginActivity();
    if (bodyTool) {
      this.foreground = name;
      beginBody();
    }
    let backgroundStarted = false;
    try {
      const parsedArgs = this.shouldValidateSchema(schema)
        ? this.parseArgs(schema as ZodRawShape, args)
        : args;
      if (canBackground && (parsedArgs as { background?: boolean }).background) {
        const bgArgs = { ...(parsedArgs as Record<string, unknown>) };
        delete bgArgs.background;
        // 后台时 agent 自己能听到聊天，默认不因聊天中断
        bgArgs.interruptOnChat ??= false;
        backgroundStarted = true;
        return this.startBackground(name, bgArgs, executor);
      }
      return await runInTask(ctx, () => executor(parsedArgs));
    } catch (error) {
      return this.createErrorResponse(error as Error);
    } finally {
      if (!backgroundStarted) endTask(ctx);
      if (bodyTool) {
        this.foreground = null;
        endBody();
      }
      if (!passive) endActivity();
    }
  }

  // 供脚本（任务内部）调用已有工具，返回文本结果。子调用属于当前任务，任务失效后一律拒绝
  async invoke(name: string, args: unknown = {}): Promise<string> {
    const parent = currentTask();
    if (!parent) throw new Error('只能在任务内部调用其他工具');
    const stale = staleReason(parent, this.bot());
    if (stale) throw new TaskCancelled(stale);
    if (name === 'run-script') throw new Error('脚本里不能再调用 run-script');
    const entry = this.executors.get(name);
    if (!entry) throw new Error(`没有这个工具：${name}`);
    if (this.job && !SAFE_DURING_JOB.has(name) && !isDescendantOf(parent, this.job.ctx)) {
      throw new Error(`后台任务 ${this.runningJob()} 还在运行，不能插入 ${name}`);
    }
    if (!this.connection.isConnected()) throw new Error('还没有连上服务器');
    const parsedArgs = this.shouldValidateSchema(entry.schema)
      ? this.parseArgs(entry.schema as ZodRawShape, args)
      : args;
    const child = startTask(name, this.bot(), parent);
    try {
      const result = await runInTask(child, () => entry.executor(parsedArgs));
      const text = textOf(result);
      if (result.isError) throw new Error(text);
      return text;
    } finally {
      endTask(child);
    }
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  // 返回图片（和一段说明文字）。data 是原始字节，不带 data: 前缀
  createImageResponse(image: Buffer, mimeType: ImageContent['mimeType'], caption: string): McpResponse {
    if (image.length === 0) return this.createErrorResponse('图片是空的');
    if (image.length > MAX_IMAGE_BYTES) {
      return this.createErrorResponse(`图片太大：${image.length} 字节，上限 ${MAX_IMAGE_BYTES}`);
    }
    const magic = mimeType === 'image/png' ? PNG_MAGIC : JPEG_MAGIC;
    if (!image.subarray(0, magic.length).equals(magic)) {
      return this.createErrorResponse(`图片内容和类型 ${mimeType} 不符`);
    }
    return {
      content: [
        { type: "text", text: caption },
        { type: "image", data: image.toString('base64'), mimeType }
      ]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = error instanceof Error ? error.message : error;
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true
    };
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}
