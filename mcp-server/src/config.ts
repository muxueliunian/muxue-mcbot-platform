import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  greeting: string;
  nickname: string;
  runtimeDir: string;
  scriptsDir: string;
  dataDir: string;
  worldId: string;
  // 在线管理：其他 Bot 的游戏名（不算真人玩家），以及自动下线的等待分钟数（0 = 关闭该项）
  botPlayers: string[];
  // 只陪这些玩家：自动进服/下线只看他们在不在（空 = 所有真人）
  ownerPlayers: string[];
  idleQuitMinutes: number;
  nightQuitMinutes: number;
  emptyQuitMinutes: number;
  // 由托管驱动器（scripts/companion.mjs）启动：写事件文件、认托管心跳
  hosted: boolean;
  // 记忆（docs/memory_plan.md）：根目录和自己的子目录名
  memoryDir: string;
  memoryAgent: string;
}

export function parseConfig(): ServerConfig {
  const argv = yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('greeting', {
      type: 'string',
      description: 'Chat message sent after spawning (empty to stay silent)',
      default: ''
    })
    .option('nickname', {
      type: 'string',
      description: 'Nickname players use to call the bot (e.g. 小克), used to interrupt long tasks',
      default: ''
    })
    .option('runtime-dir', {
      type: 'string',
      description: 'Directory for the event log and cursor files shared with the companion driver',
      default: fileURLToPath(new URL('../../runtime', import.meta.url))
    })
    .option('data-dir', {
      type: 'string',
      description: 'Directory for persistent shared data such as protected regions',
      default: fileURLToPath(new URL('../../data', import.meta.url))
    })
    .option('world-id', {
      type: 'string',
      description: 'Stable name of this Minecraft world/save (regions are keyed by it; the server address is not enough)',
      default: ''
    })
    .option('scripts-dir', {
      type: 'string',
      description: 'Directory of behavior scripts the agent writes itself',
      default: fileURLToPath(new URL('../../bot-scripts', import.meta.url))
    })
    .option('bot-players', {
      type: 'string',
      description: 'Comma-separated usernames of bots (not counted as real players when deciding to stay online)',
      default: 'Claude,Gemini'
    })
    .option('owner-players', {
      type: 'string',
      description: 'Comma-separated usernames the bot plays with; auto join/quit only looks at them (empty = any real player)',
      default: ''
    })
    .option('idle-quit-minutes', {
      type: 'number',
      description: 'Log off after nobody has controlled the bot for this many minutes (0 = never)',
      default: 5
    })
    .option('night-quit-minutes', {
      type: 'number',
      description: 'At night, log off after nobody has controlled the bot for this many minutes (0 = off)',
      default: 1
    })
    .option('empty-quit-minutes', {
      type: 'number',
      description: 'Log off after no real player has been online for this many minutes (0 = never)',
      default: 2
    })
    .option('memory-dir', {
      type: 'string',
      description: 'Root directory of the layered memory files (persona, journal, digest, shared world and player profiles)',
      default: fileURLToPath(new URL('../../memory', import.meta.url))
    })
    .option('memory-agent', {
      type: 'string',
      description: 'Sub-directory of --memory-dir that belongs to this bot (default: lower-case username)',
      default: ''
    })
    .option('hosted', {
      type: 'boolean',
      description: 'Started by the companion driver: write runtime event files and honor the companion heartbeat',
      default: false
    })
    .help()
    .alias('help', 'h')
    .parseSync();
  const minutes = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  return {
    host: argv.host,
    port: argv.port,
    username: argv.username,
    greeting: argv.greeting,
    nickname: argv.nickname,
    runtimeDir: argv.runtimeDir,
    scriptsDir: argv.scriptsDir,
    dataDir: argv.dataDir,
    worldId: argv.worldId,
    botPlayers: String(argv.botPlayers).split(',').map((n) => n.trim()).filter(Boolean),
    ownerPlayers: String(argv.ownerPlayers).split(',').map((n) => n.trim()).filter(Boolean),
    idleQuitMinutes: minutes(argv.idleQuitMinutes),
    nightQuitMinutes: minutes(argv.nightQuitMinutes),
    emptyQuitMinutes: minutes(argv.emptyQuitMinutes),
    hosted: argv.hosted,
    memoryDir: argv.memoryDir,
    memoryAgent: argv.memoryAgent || argv.username.toLowerCase()
  };
}
