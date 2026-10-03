import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder } = pathfinderPkg;
import { prepareBot, retireBot } from './action-policy.js';
import { runOutsideTask } from './task-control.js';
import { applyProtocolFixes } from './protocol-fixes.js';

const SUPPORTED_MINECRAFT_VERSION = '1.21.1';

type ConnectionState = 'connected' | 'connecting' | 'disconnected';

interface BotConfig {
  host: string;
  port: number;
  username: string;
  greeting?: string;
}

// 一次断线的信息，交给在线管理（presence.ts）判断停放原因
export interface DisconnectInfo {
  kicked: boolean;
  kickReason?: unknown;
  loggedIn?: boolean;
  errorCode?: string;
  endReason?: string;
  // 断线前是否已经进服（spawn 过）
  wasConnected: boolean;
}

interface ConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
  onBotCreated?: (bot: mineflayer.Bot) => void;
  onDisconnect?: (info: DisconnectInfo) => void;
}

export class BotConnection {
  private bot: mineflayer.Bot | null = null;
  private state: ConnectionState = 'disconnected';
  private config: BotConfig;
  private callbacks: ConnectionCallbacks;
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs: number;

  constructor(config: BotConfig, callbacks: ConnectionCallbacks, reconnectDelayMs = 2000) {
    this.config = config;
    this.callbacks = callbacks;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  getBot(): mineflayer.Bot | null {
    return this.bot;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    const botOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      plugins: { pathfinder },
    };

    applyProtocolFixes();
    // Bot 的定时器和网络回调会长期存在，不能继承某次工具调用的任务上下文
    this.bot = runOutsideTask(() => mineflayer.createBot(botOptions));
    this.state = 'connecting';
    this.isReconnecting = false;

    this.registerEventHandlers(this.bot);
    this.callbacks.onBotCreated?.(this.bot);
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    let spawned = false;
    let kick: { reason: unknown; loggedIn: boolean } | null = null;
    let errorCode: string | undefined;

    bot.once('spawn', async () => {
      spawned = true;
      // 先装动作守卫、换成只走路不挖不垫的寻路，再对外标记为已连接
      // （安全寻路里也关掉了疾跑：1.21.1 服务器经常拒绝 mineflayer 的疾跑起跳）
      prepareBot(bot);
      this.state = 'connected';
      this.callbacks.onLog('info', 'Bot spawned in world');

      if (this.config.greeting) {
        bot.chat(this.config.greeting);
      }
      this.callbacks.onLog('info', `Bot connected successfully. Username: ${this.config.username}, Server: ${this.config.host}:${this.config.port}`);
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.callbacks.onChatMessage(username, message);
    });

    bot.on('kicked', (reason, loggedIn) => {
      kick = { reason, loggedIn };
      this.callbacks.onLog('error', `Bot was kicked from server: ${this.formatError(reason)}`);
      this.state = 'disconnected';
      bot.quit();
    });

    bot.on('error', (err) => {
      const code = (err as { code?: string }).code || 'Unknown error';
      const errorMsg = err instanceof Error ? err.message : String(err);
      errorCode ??= code;

      this.callbacks.onLog('error', `Bot error [${code}]: ${errorMsg}`);

      if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
        this.state = 'disconnected';
      }
    });

    bot.on('login', () => {
      this.callbacks.onLog('info', 'Bot logged in successfully');
    });

    bot.on('end', (reason) => {
      this.callbacks.onLog('info', `Bot disconnected: ${this.formatError(reason)}`);

      retireBot(bot);
      if (this.state === 'connected') {
        this.state = 'disconnected';
      }

      if (this.bot === bot) {
        // 进服途中断开（登录被拒等）也要回到 disconnected，不能卡在 connecting
        this.state = 'disconnected';
        try {
          bot.removeAllListeners();
          this.bot = null;
          this.callbacks.onLog('info', 'Bot instance cleaned up after disconnect');
        } catch (err) {
          this.callbacks.onLog('warn', `Error cleaning up bot on end event: ${this.formatError(err)}`);
        }
        try {
          this.callbacks.onDisconnect?.({
            kicked: kick !== null,
            kickReason: kick?.reason,
            loggedIn: kick?.loggedIn,
            errorCode,
            endReason: typeof reason === 'string' ? reason : undefined,
            wasConnected: spawned
          });
        } catch (err) {
          this.callbacks.onLog('warn', `Error in disconnect handler: ${this.formatError(err)}`);
        }
      }
    });
  }

  attemptReconnect(): void {
    if (this.isReconnecting || this.state === 'connecting') {
      return;
    }

    this.isReconnecting = true;
    this.state = 'connecting';
    this.callbacks.onLog('info', `Attempting to reconnect to Minecraft server in ${this.reconnectDelayMs}ms...`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = runOutsideTask(() => setTimeout(() => {
      if (this.bot) {
        retireBot(this.bot);
        try {
          this.bot.removeAllListeners();
          this.bot.quit('Reconnecting...');
          this.callbacks.onLog('info', 'Old bot instance cleaned up');
        } catch (err) {
          this.callbacks.onLog('warn', `Error while cleaning up old bot: ${this.formatError(err)}`);
        }
      }

      this.callbacks.onLog('info', 'Creating new bot instance...');
      this.connect();
    }, this.reconnectDelayMs));
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    const currentState = this.state;

    if (currentState === 'disconnected') {
      this.attemptReconnect();

      const maxWaitTime = this.reconnectDelayMs + 5000;
      const pollInterval = 100;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        if (this.state === 'connected') {
          return { connected: true };
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      const errorMessage =
        `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}\n\n` +
        `Please ensure:\n` +
        `1. Minecraft server is running on ${this.config.host}:${this.config.port}\n` +
        `2. Server is accessible from this machine\n` +
        `3. Server version is compatible (this project uses ${SUPPORTED_MINECRAFT_VERSION})\n\n` +
        `For setup instructions, visit: https://github.com/yuniko-software/minecraft-mcp-server`;

      return { connected: false, message: errorMessage };
    }

    if (currentState === 'connecting') {
      return { connected: false, message: 'Bot is connecting to the Minecraft server. Please wait a moment and try again.' };
    }

    return { connected: true };
  }

  cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.bot) {
      try {
        this.bot.quit('Server shutting down');
      } catch (err) {
        this.callbacks.onLog('warn', `Error during cleanup: ${this.formatError(err)}`);
      }
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
