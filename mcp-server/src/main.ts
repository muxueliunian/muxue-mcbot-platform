#!/usr/bin/env node
// 必须是第一个 import：先接管 stdout，再加载其他模块
import { protocolStdout } from './stdio-guard.js';
import path from 'node:path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { registerActionTools } from './tools/action-tools.js';
import { registerEventTools } from './tools/event-tools.js';
import { EventStore } from './event-store.js';
import { attachGameEvents } from './game-events.js';
import { registerBuildTools } from './tools/build-tools.js';
import { registerBlueprintTools } from './tools/blueprint-tools.js';
import { registerSiteTools } from './tools/site-tools.js';
import { configureTasks } from './task-control.js';
import { configureSocial } from './social.js';
import { registerScriptTools } from './tools/script-tools.js';
import { registerRegionTools } from './tools/region-tools.js';
import { registerCompanionTools } from './tools/companion-tools.js';
import { EntranceStore, configureEntrances } from './entrances.js';
import { registerFarmTools } from './tools/farm-tools.js';
import { FarmStore, configureFarms } from './farm.js';
import { registerOutdoorTools } from './tools/outdoor-tools.js';
import { PlaceStore, configurePlaces } from './places.js';
import { registerVisionTools } from './tools/vision-tools.js';
import { shutdownLook } from './vision/look.js';
import { RegionStore } from './regions.js';
import { configurePolicy } from './action-policy.js';
import { Presence } from './presence.js';
import { configureReactions } from './reactions.js';
import { MemoryStore, journalLineFor } from './memory.js';
import { registerMemoryTools } from './tools/memory-tools.js';
import { onSpoken } from './social.js';

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  const config = parseConfig();
  // ysm.ts 按这个环境变量找 ysm-emotes.json，跟着 --data-dir 走
  process.env.MCBOT_DATA_DIR ??= config.dataDir;
  const messageStore = new MessageStore();
  // 只有托管（--hosted）时才写 runtime/events-/cursor-/consumed-<名字> 文件给驱动器读；
  // 交互式会话只在内存里记事件，免得和托管的 MCP 服务端互相清空同一个文件
  const eventStore = config.hosted ? new EventStore(config.runtimeDir, config.username) : new EventStore();
  configureReactions({ botPlayers: config.botPlayers });
  // 记忆：客观事件和自己说的话自动写进今天的日志（docs/memory_plan.md）
  const memory = new MemoryStore(config.memoryDir, config.memoryAgent, path.join(config.runtimeDir, 'memory-backup'));
  const journal = (text: string) => {
    try {
      memory.append(text);
    } catch (err) {
      log('warn', `写记忆日志失败：${err}`);
    }
  };
  eventStore.onAdd((e) => {
    const line = journalLineFor(e.type, e.text, config.worldId);
    if (line) journal(line);
  });
  onSpoken((text) => journal(`我: ${text}`));
  configureTasks(eventStore, [config.username, config.nickname]);
  configureSocial(config.runtimeDir, config.username);
  const regionFile = path.join(config.dataDir, 'regions.json');
  configurePolicy(new RegionStore(regionFile, config.worldId, config.username));
  configureEntrances(new EntranceStore(path.join(config.dataDir, 'entrances.json'), config.worldId, config.username));
  configureFarms(new FarmStore(path.join(config.dataDir, 'farms.json'), config.worldId));
  configurePlaces(new PlaceStore(path.join(config.dataDir, 'places.json'), config.worldId, config.username));
  if (!config.worldId) {
    log('warn', '没有配置 --world-id：区域登记不可用，方块材质保护和寻路限制仍然有效');
  }

  // 在线管理和连接互相引用：连接的回调里用 presence，presence 通过 connection 进服/下线
  let presence: Presence | null = null;
  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => messageStore.addMessage(username, message),
      onBotCreated: (bot) => {
        presence?.attach(bot);
        attachGameEvents(bot, presence ? presence.eventsFor(eventStore) : eventStore);
      },
      onDisconnect: (info) => presence?.onDisconnect(info)
    }
  );
  presence = new Presence({
    connection,
    events: eventStore,
    username: config.username,
    displayName: config.nickname,
    botPlayers: config.botPlayers,
    ownerPlayers: config.ownerPlayers,
    runtimeDir: config.runtimeDir,
    hosted: config.hosted,
    host: config.host,
    port: config.port,
    settings: {
      idleQuitMs: config.idleQuitMinutes * 60_000,
      nightQuitMs: config.nightQuitMinutes * 60_000,
      emptyQuitMs: config.emptyQuitMinutes * 60_000
    }
  });
  const activePresence = presence;
  // 进程退出时放开 Bot 锁（被强杀时留下的锁，下一个进程会按死锁接管）
  process.on('exit', () => activePresence.stop());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(0));

  const server = new McpServer({
    name: "mcbot-mcp-server",
    version: "2.0.4-mcbot.1"
  });

  const factory = new ToolFactory(server, connection, eventStore, presence);
  const getBot = () => connection.getBot()!;

  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerActionTools(factory, getBot, eventStore);
  registerBuildTools(factory, getBot);
  registerBlueprintTools(factory, getBot);
  registerSiteTools(factory, getBot);
  registerScriptTools(factory, getBot, config.scriptsDir);
  registerRegionTools(factory, getBot);
  registerCompanionTools(factory, getBot, config.worldId);
  registerFarmTools(factory, getBot);
  registerOutdoorTools(factory, getBot);
  registerVisionTools(factory, getBot, config.worldId);
  registerEventTools(factory, eventStore, getBot);
  registerMemoryTools(factory, memory, config.ownerPlayers);

  let shuttingDown = false;
  process.stdin.on('end', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    activePresence.stop();
    connection.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    // 等浏览器和 viewer 关掉再退出，最多等 5 秒
    const timeout = new Promise((resolve) => setTimeout(resolve, 5000).unref());
    Promise.race([shutdownLook(), timeout])
      .catch((err) => log('warn', `关闭视觉组件失败：${err}`))
      .finally(() => process.exit(0));
  });

  const transport = new StdioServerTransport(process.stdin, protocolStdout);
  await server.connect(transport);

  // 先 ping 服务器：没开或没有真人玩家就停放，不进服
  void activePresence.start();
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
