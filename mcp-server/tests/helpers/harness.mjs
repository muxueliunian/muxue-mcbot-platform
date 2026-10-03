// 用编译后的真实工具代码 + 假 Bot 搭一个离线 MCP 工具环境（不启动 MCP 传输，也不连服务器）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolFactory } from '../../dist/tool-factory.js';
import { EventStore } from '../../dist/event-store.js';
import { configureTasks } from '../../dist/task-control.js';
import { prepareBot, configurePolicy } from '../../dist/action-policy.js';
import { RegionStore } from '../../dist/regions.js';
import { registerPositionTools } from '../../dist/tools/position-tools.js';
import { registerBlockTools } from '../../dist/tools/block-tools.js';
import { registerActionTools } from '../../dist/tools/action-tools.js';
import { registerBuildTools } from '../../dist/tools/build-tools.js';
import { registerBlueprintTools } from '../../dist/tools/blueprint-tools.js';
import { registerSiteTools } from '../../dist/tools/site-tools.js';
import { registerFlightTools } from '../../dist/tools/flight-tools.js';
import { registerInventoryTools } from '../../dist/tools/inventory-tools.js';
import { registerScriptTools } from '../../dist/tools/script-tools.js';
import { registerRegionTools } from '../../dist/tools/region-tools.js';
import { registerCompanionTools } from '../../dist/tools/companion-tools.js';
import { EntranceStore, configureEntrances } from '../../dist/entrances.js';
import { registerFarmTools } from '../../dist/tools/farm-tools.js';
import { FarmStore, configureFarms } from '../../dist/farm.js';
import { registerOutdoorTools } from '../../dist/tools/outdoor-tools.js';
import { PlaceStore, configurePlaces } from '../../dist/places.js';
import { registerVisionTools } from '../../dist/tools/vision-tools.js';
import { registerChatTools } from '../../dist/tools/chat-tools.js';
import { MessageStore } from '../../dist/message-store.js';

// 测试用临时目录：进程退出时统一删除
const created = [];
process.once('exit', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'mcbot-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function createHarness(bot, { scriptsDir = tempDir('mcbot-scripts-'), regionFile = null, worldId = 'test-world' } = {}) {
  const handlers = new Map();
  const server = { tool: (name, _desc, _schema, handler) => handlers.set(name, handler) };
  let current = bot;
  const connection = {
    checkConnectionAndReconnect: async () => ({ connected: true }),
    isConnected: () => true,
    getBot: () => current,
  };
  const events = new EventStore();
  configureTasks(events, ['Claude', '小克']);
  const factory = new ToolFactory(server, connection, events);
  configurePolicy(new RegionStore(regionFile, regionFile ? worldId : '', 'Claude'));
  const entranceFile = regionFile ? path.join(path.dirname(regionFile), 'entrances.json') : null;
  configureEntrances(new EntranceStore(entranceFile, regionFile ? worldId : '', 'Claude'));
  configurePlaces(new PlaceStore(regionFile ? path.join(path.dirname(regionFile), 'places.json') : null, regionFile ? worldId : '', 'Claude'));
  configureFarms(new FarmStore(regionFile ? path.join(path.dirname(regionFile), 'farms.json') : null, regionFile ? worldId : ''));
  if (bot) prepareBot(bot);
  const getBot = () => current;
  registerPositionTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerActionTools(factory, getBot, events);
  registerBuildTools(factory, getBot);
  registerBlueprintTools(factory, getBot);
  registerSiteTools(factory, getBot);
  registerFlightTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerScriptTools(factory, getBot, scriptsDir);
  registerRegionTools(factory, getBot);
  registerCompanionTools(factory, getBot, regionFile ? worldId : '');
  registerFarmTools(factory, getBot);
  registerOutdoorTools(factory, getBot);
  registerVisionTools(factory, getBot, regionFile ? worldId : '');
  registerChatTools(factory, getBot, new MessageStore());

  return {
    factory,
    events,
    scriptsDir,
    setBot(next) {
      current = next;
      prepareBot(next);
    },
    async call(name, args = {}) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no tool ${name}`);
      return await handler(args);
    },
    writeScript(name, source) {
      fs.writeFileSync(path.join(scriptsDir, `${name}.mjs`), source);
    },
  };
}

export function text(result) {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export function callsOf(bot, type) {
  return bot.calls.filter((c) => c.type === type);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
