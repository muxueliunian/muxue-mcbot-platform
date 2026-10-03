// mcbot 新增动作：进食、战斗、跟随、睡觉、给物品、捡物品、箱子、使用物品/方块、状态查询、本能开关
import { z } from "zod";
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { eatBestFood, isHostile, reflexSettings } from '../reflexes.js';
import { cancelTasks, useGrant, posKey } from '../task-control.js';
import { EMOTES, emote, socialSettings } from '../social.js';
import { loadYsmEmotes, playYsmWithAutoStop, ysmAnimationFor, ysmDurationFor } from '../ysm.js';
import { startFollow, stopFollow, followStatus } from '../follow.js';
import type { EventStore } from '../event-store.js';
import { safeGoto } from '../movement.js';
import { cancelFlight } from '../flight.js';
import { checkPlace, faceVector, isInteractable, isModifyingItem, isWorldUseItem } from '../action-policy.js';

const { goals } = pathfinderPkg;

let attackToken = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describePos(pos: Vec3): string {
  return `(${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`;
}

function entityName(entity: Entity): string {
  return entity.username || entity.displayName || entity.name || entity.type;
}

function findPlayerEntity(bot: Bot, username: string): Entity | undefined {
  const exact = bot.players[username]?.entity;
  if (exact) return exact;
  const key = Object.keys(bot.players).find((name) => name.toLowerCase() === username.toLowerCase());
  return key ? bot.players[key]?.entity : undefined;
}

function findInventoryItem(bot: Bot, itemName: string) {
  const name = itemName.toLowerCase();
  const items = bot.inventory.items();
  return items.find((i) => i.name === name) ?? items.find((i) => i.name.includes(name));
}

async function gotoNear(bot: Bot, pos: Vec3, range: number, timeoutMs = 30000): Promise<void> {
  await safeGoto(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), { timeoutMs });
}

export function registerActionTools(factory: ToolFactory, getBot: () => Bot, events?: EventStore): void {
  factory.registerTool(
    "get-status",
    "Get the bot's full status: health, food, time, weather, held item, everyone online (tab list), nearby players and hostile mobs",
    {},
    async () => {
      const bot = getBot();
      const pos = bot.entity.position;
      const time = bot.time.timeOfDay;
      const players = Object.values(bot.players)
        .filter((p) => p.username !== bot.username && p.entity)
        .map((p) => `${p.username} 距离 ${p.entity.position.distanceTo(pos).toFixed(1)} 格`);
      const hostiles = Object.values(bot.entities)
        .filter((e) => isHostile(e) && e.position.distanceTo(pos) <= 24)
        .map((e) => `${entityName(e)} 距离 ${e.position.distanceTo(pos).toFixed(1)} 格`);

      const lines = [
        `生命值：${bot.health.toFixed(1)}/20`,
        `饥饿值：${bot.food}/20（饱和度 ${bot.foodSaturation.toFixed(1)}）`,
        `经验等级：${bot.experience.level}`,
        `位置：${describePos(pos)}，维度：${bot.game.dimension}`,
        `游戏时间：${time}（${time < 12542 || time > 23460 ? '白天' : '夜晚'}），${bot.isRaining ? '下雨' : '晴天'}`,
        `游戏模式：${bot.game.gameMode}`,
        `手持：${bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : '空手'}`,
        `睡觉中：${bot.isSleeping ? '是' : '否'}`,
        `在线玩家（Tab 列表）：${Object.keys(bot.players).filter((n) => n !== bot.username).join('、') || '只有自己'}`,
        `附近玩家：${players.length ? players.join('；') : '无'}`,
        `24 格内敌对生物：${hostiles.length ? hostiles.join('；') : '无'}`,
        `本能：自动进食=${reflexSettings.autoEat}，自动反击=${reflexSettings.autoDefend}`,
        `跟随：${followStatus() ?? '没有在跟随'}`
      ];
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "eat",
    "Eat now: the biggest food that fits the missing hunger (no waste); if nothing fits, eats one anyway",
    {},
    async () => factory.createResponse(await eatBestFood(getBot()))
  );

  factory.registerTool(
    "follow-player",
    "Keep following a player (walks only: never digs a path or places blocks; escort mode also fights mobs and mines exposed ores, see below). Keeps some distance without pushing, doesn't park in registered doorways, pauses while you do other body actions, and stops with a `follow` event if the player disappears, teleports, gets too far, or there is no path. stop-action ends it",
    {
      username: z.string().describe("Player to follow"),
      distance: z.coerce.number().finite().min(1.5).max(10).optional().describe("Distance to keep (default: 3)"),
      maxDistance: z.coerce.number().finite().min(8).max(128).optional().describe("Give up beyond this distance (default: 48)"),
      escort: z.boolean().optional().describe("Mining companion mode (e.g. going down a mine together): before following, first fight visible hostile mobs within 8 blocks of you or the player (creepers only when within 4; gives up after 10 s without a hit or beyond 12 blocks from the player), then mine exposed ores within 6 blocks of you and 10 of the player (only ones touching air, not next to water/lava, not within 1.5 blocks of the player, only with a proper pickaxe, never in protected regions) and pick up the drops. Sends `follow` events only for diamond/emerald/ancient debris, a broken pickaxe, a full inventory or low health (default: false)"),
      mineOres: z.boolean().optional().describe("Escort mode: also mine ores (default: true; false = only fight)")
    },
    async ({ username, distance = 3, maxDistance = 48, escort = false, mineOres = true }) => {
      const bot = getBot();
      const text = startFollow(bot, username, { distance, maxDistance, escort: escort ? { fight: true, ores: mineOres } : undefined }, (type, msg) => events?.add(type, msg));
      return factory.createResponse(text);
    }
  );

  factory.registerTool(
    "go-to-player",
    "Walk to a player and stop next to them",
    {
      username: z.string().describe("Player to walk to")
    },
    async ({ username }) => {
      const bot = getBot();
      const target = findPlayerEntity(bot, username);
      if (!target) {
        return factory.createResponse(`看不到玩家 ${username}（不在线或太远）`);
      }
      await gotoNear(bot, target.position, 2, 60000);
      await bot.lookAt(target.position.offset(0, 1.6, 0));
      return factory.createResponse(`已走到 ${username} 身边 ${describePos(bot.entity.position)}`);
    }
  );

  factory.registerTool(
    "stop-action",
    "Stop following, walking, attacking and any running mine-blocks / build task",
    {},
    async () => {
      const bot = getBot();
      attackToken += 1;
      cancelTasks();
      stopFollow();
      // 兜底：不属于任何任务的挖掘也停下
      if (bot.targetDigBlock) bot.stopDigging();
      // setGoal(null) 已立即清空路径；之后再 stop() 会留下延迟停止标记，
      // 把玩家接下来发出的第一个新移动指令也取消掉。
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      cancelFlight(bot);
      return factory.createResponse('已停止所有移动和攻击');
    }
  );

  factory.registerTool(
    "attack-entity",
    "Chase and attack the nearest entity of a type (e.g. zombie, skeleton, cow) until it dies or timeout. Players are not attacked unless allowPlayer is true",
    {
      target: z.string().describe("Entity name (e.g. zombie) or 'hostile' for nearest hostile mob, or a player username"),
      maxDistance: z.coerce.number().finite().optional().describe("Search distance (default: 16)"),
      timeoutSeconds: z.coerce.number().finite().optional().describe("Give up after this many seconds (default: 30)"),
      allowPlayer: z.boolean().optional().describe("Allow attacking players (default: false)")
    },
    async ({ target, maxDistance = 16, timeoutSeconds = 30, allowPlayer = false }) => {
      const bot = getBot();
      const key = target.toLowerCase();
      const entity = bot.nearestEntity((e) => {
        if (e.position.distanceTo(bot.entity.position) > maxDistance) return false;
        if (e.type === 'player') {
          return allowPlayer && (e.username ?? '').toLowerCase() === key;
        }
        if (key === 'hostile') return isHostile(e);
        return (e.name ?? '').toLowerCase().includes(key);
      });
      if (!entity) {
        return factory.createResponse(`${maxDistance} 格内没有找到 ${target}`);
      }

      const token = ++attackToken;
      const name = entityName(entity);
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, 1.5), true);
      const deadline = Date.now() + timeoutSeconds * 1000;
      let hits = 0;
      try {
        while (Date.now() < deadline && token === attackToken) {
          if (!bot.entities[entity.id] || !entity.isValid) {
            return factory.createResponse(`${name} 已被消灭（攻击 ${hits} 次）`);
          }
          if (bot.health <= 4) {
            return factory.createResponse(`生命值只剩 ${bot.health.toFixed(1)}，停止攻击 ${name}`);
          }
          if (entity.position.distanceTo(bot.entity.position) <= 3.5) {
            await bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0), true);
            bot.attack(entity);
            hits += 1;
          }
          await sleep(650);
        }
        return factory.createResponse(
          token === attackToken ? `攻击 ${name} 超时（攻击 ${hits} 次）` : `攻击 ${name} 被中断`
        );
      } finally {
        if (token === attackToken) bot.pathfinder.setGoal(null);
      }
    }
  );

  factory.registerTool(
    "sleep-in-bed",
    "Find a nearby bed and sleep (only works at night or during thunderstorms)",
    {
      maxDistance: z.coerce.number().finite().optional().describe("Search distance for beds (default: 32)")
    },
    async ({ maxDistance = 32 }) => {
      const bot = getBot();
      const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance });
      if (!bed) {
        return factory.createResponse(`${maxDistance} 格内没有床`);
      }
      await gotoNear(bot, bed.position, 2);
      await bot.sleep(bed);
      return factory.createResponse(`已在 ${describePos(bed.position)} 的床上睡觉`);
    }
  );

  factory.registerTool(
    "wake-up",
    "Get out of bed",
    {},
    async () => {
      const bot = getBot();
      if (!bot.isSleeping) return factory.createResponse('现在没有在睡觉');
      await bot.wake();
      return factory.createResponse('已起床');
    }
  );

  factory.registerTool(
    "give-item",
    "Walk to a player and throw them an item",
    {
      username: z.string().describe("Player to give the item to"),
      itemName: z.string().describe("Item name"),
      count: z.coerce.number().int().positive().optional().describe("How many (default: 1)")
    },
    async ({ username, itemName, count = 1 }) => {
      const bot = getBot();
      const item = findInventoryItem(bot, itemName);
      if (!item) return factory.createResponse(`背包里没有 ${itemName}`);
      const target = findPlayerEntity(bot, username);
      if (!target) return factory.createResponse(`看不到玩家 ${username}`);

      await gotoNear(bot, target.position, 2, 60000);
      await bot.lookAt(target.position.offset(0, 1.2, 0), true);
      const amount = Math.min(count, bot.inventory.count(item.type, null));
      await bot.toss(item.type, null, amount);
      return factory.createResponse(`把 ${amount} 个 ${item.name} 扔给了 ${username}`);
    }
  );

  factory.registerTool(
    "drop-item",
    "Drop an item on the ground",
    {
      itemName: z.string().describe("Item name"),
      count: z.coerce.number().int().positive().optional().describe("How many (default: whole amount)")
    },
    async ({ itemName, count }) => {
      const bot = getBot();
      const item = findInventoryItem(bot, itemName);
      if (!item) return factory.createResponse(`背包里没有 ${itemName}`);
      const amount = Math.min(count ?? Infinity, bot.inventory.count(item.type, null));
      await bot.toss(item.type, null, amount);
      return factory.createResponse(`丢下了 ${amount} 个 ${item.name}`);
    }
  );

  factory.registerTool(
    "collect-items",
    "Walk over nearby dropped items to pick them up",
    {
      maxDistance: z.coerce.number().finite().optional().describe("Search distance (default: 16)"),
      maxItems: z.coerce.number().int().positive().optional().describe("Max item stacks to collect (default: 10)")
    },
    async ({ maxDistance = 16, maxItems = 10 }) => {
      const bot = getBot();
      const picked: string[] = [];
      for (let i = 0; i < maxItems; i++) {
        const drop = bot.nearestEntity(
          (e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= maxDistance
        );
        if (!drop) break;
        const dropped = drop.getDroppedItem();
        try {
          await gotoNear(bot, drop.position, 0.5, 15000);
          await sleep(300);
          if (dropped) picked.push(`${dropped.name} x${dropped.count}`);
        } catch {
          break;
        }
      }
      return factory.createResponse(picked.length ? `捡起了：${picked.join('，')}` : '附近没有能捡的掉落物');
    }
  );

  factory.registerTool(
    "use-held-item",
    "Use (right click) the held item, e.g. shield, bow, bucket, bone meal. Holds the button for durationMs",
    {
      durationMs: z.coerce.number().int().nonnegative().optional().describe("How long to hold right click (default: 0, instant)")
    },
    async ({ durationMs = 0 }) => {
      const bot = getBot();
      if (!bot.heldItem) return factory.createResponse('手上没有物品');
      if (isWorldUseItem(bot.heldItem.name)) {
        // 桶、打火石、刷怪蛋等会改动对准的位置：只授权准星对准的那一处，并先检查保护规则
        const target = bot.blockAtCursor(5) as (ReturnType<Bot['blockAtCursor']> & { face?: number }) | null;
        if (!target) return factory.createResponse(`没有对准方块，不使用 ${bot.heldItem.name}`);
        const dest = target.position.plus(faceVector(target.face));
        const grant = useGrant();
        grant.place.add(posKey(dest));
        grant.dig.add(posKey(target.position));
        const verdict = checkPlace(bot, dest, grant);
        if (!verdict.ok) return factory.createResponse(`不使用 ${bot.heldItem.name}：${verdict.reason}`);
      }
      bot.activateItem();
      if (durationMs > 0) await sleep(durationMs);
      bot.deactivateItem();
      return factory.createResponse(`使用了 ${bot.heldItem?.name ?? '物品'}`);
    }
  );

  factory.registerTool(
    "use-block",
    "Right click a block, e.g. door, button, lever, trapdoor, gate, chest. Uses an empty hand when the held item could change the block, so it only interacts",
    {
      x: z.coerce.number().finite(),
      y: z.coerce.number().finite(),
      z: z.coerce.number().finite()
    },
    async ({ x, y, z: zPos }) => {
      const bot = getBot();
      const pos = new Vec3(x, y, zPos);
      const block = bot.blockAt(pos);
      if (!block) return factory.createResponse(`${describePos(pos)} 的方块未加载`);
      if (bot.entity.position.distanceTo(pos) > 4) await gotoNear(bot, pos, 3);
      if (!isInteractable(block)) {
        return factory.createResponse(`${block.name} 不是能直接交互的方块（放方块用 place-block / build）`);
      }
      // 拿着方块或工具右键可能会放东西、剥树皮，先空手
      if (isModifyingItem(bot.heldItem?.name, bot)) await bot.unequip('hand');
      await bot.activateBlock(block);
      return factory.createResponse(`使用了 ${describePos(pos)} 的 ${block.name}`);
    }
  );

  factory.registerTool(
    "container-list",
    "Open a chest / barrel / shulker box at a position and list its contents",
    {
      x: z.coerce.number().finite(),
      y: z.coerce.number().finite(),
      z: z.coerce.number().finite()
    },
    async ({ x, y, z: zPos }) => {
      const bot = getBot();
      const pos = new Vec3(x, y, zPos);
      const block = bot.blockAt(pos);
      if (!block) return factory.createResponse(`${describePos(pos)} 的方块未加载`);
      await gotoNear(bot, pos, 3);
      const container = await bot.openContainer(block);
      try {
        const items = container.containerItems();
        if (!items.length) return factory.createResponse(`${block.name} 是空的`);
        const summary = new Map<string, number>();
        items.forEach((i) => summary.set(i.name, (summary.get(i.name) ?? 0) + i.count));
        return factory.createResponse(
          `${block.name} 里有：\n` + [...summary].map(([n, c]) => `- ${n} x${c}`).join('\n')
        );
      } finally {
        container.close();
      }
    }
  );

  factory.registerTool(
    "container-deposit",
    "Put items from the bot's inventory into a chest / barrel at a position",
    {
      x: z.coerce.number().finite(),
      y: z.coerce.number().finite(),
      z: z.coerce.number().finite(),
      itemName: z.string().describe("Item name, or 'all' to deposit everything except equipped/held items"),
      count: z.coerce.number().int().positive().optional().describe("How many (default: all of that item)")
    },
    async ({ x, y, z: zPos, itemName, count }) => {
      const bot = getBot();
      const pos = new Vec3(x, y, zPos);
      const block = bot.blockAt(pos);
      if (!block) return factory.createResponse(`${describePos(pos)} 的方块未加载`);
      await gotoNear(bot, pos, 3);
      const container = await bot.openContainer(block);
      try {
        const done: string[] = [];
        const held = bot.heldItem?.name;
        const targets = itemName === 'all'
          ? [...new Set(bot.inventory.items().filter((i) => i.name !== held).map((i) => i.type))]
          : [findInventoryItem(bot, itemName)?.type].filter((t): t is number => t !== undefined);
        if (!targets.length) return factory.createResponse(`背包里没有 ${itemName}`);
        for (const type of targets) {
          const have = bot.inventory.count(type, null);
          const amount = itemName === 'all' ? have : Math.min(count ?? have, have);
          try {
            await container.deposit(type, null, amount);
            done.push(`${bot.registry.items[type].name} x${amount}`);
          } catch (e) {
            done.push(`${bot.registry.items[type].name} 放入失败（${(e as Error).message}）`);
          }
        }
        return factory.createResponse(`已放入：${done.join('，')}`);
      } finally {
        container.close();
      }
    }
  );

  factory.registerTool(
    "container-withdraw",
    "Take items out of a chest / barrel at a position",
    {
      x: z.coerce.number().finite(),
      y: z.coerce.number().finite(),
      z: z.coerce.number().finite(),
      itemName: z.string().describe("Item name"),
      count: z.coerce.number().int().positive().optional().describe("How many (default: all of that item)")
    },
    async ({ x, y, z: zPos, itemName, count }) => {
      const bot = getBot();
      const pos = new Vec3(x, y, zPos);
      const block = bot.blockAt(pos);
      if (!block) return factory.createResponse(`${describePos(pos)} 的方块未加载`);
      await gotoNear(bot, pos, 3);
      const container = await bot.openContainer(block);
      try {
        const name = itemName.toLowerCase();
        const items = container.containerItems();
        const item = items.find((i) => i.name === name) ?? items.find((i) => i.name.includes(name));
        if (!item) return factory.createResponse(`${block.name} 里没有 ${itemName}`);
        const have = items.filter((i) => i.type === item.type).reduce((s, i) => s + i.count, 0);
        const amount = Math.min(count ?? have, have);
        await container.withdraw(item.type, null, amount);
        return factory.createResponse(`取出了 ${item.name} x${amount}`);
      } finally {
        container.close();
      }
    }
  );

  factory.registerTool(
    "set-reflexes",
    "Turn automatic behaviors on/off: autoEat (eat without wasting: waits until the missing hunger is at least one food's worth, then eats the biggest food that fits; eats anyway when food <= urgentFood or health <= hurtHealth with food below 18; not during a fight unless starving; while digging it eats in the gap before the next block; never golden apples), autoDefend (hit hostile mobs that come close), idleLook (look at nearby players when idle; also needed for looking around at the scenery), " +
    "idleActions (small idle habits while standing around doing nothing: slowly looking around or at the sky, briefly switching the hotbar slot and switching back, and by day with a real player within 16 blocks, stepping 1-2 blocks around the spot where you went idle (max 3 blocks, safe walking only, never inside registered regions); everything stops at once for any tool call, chat, damage or nearby hostile mob, then waits 20 s)",
    {
      autoEat: z.boolean().optional(),
      autoDefend: z.boolean().optional(),
      urgentFood: z.coerce.number().int().min(0).max(19).optional().describe("Eat whatever is there when food is at or below this (default: 6)"),
      hurtHealth: z.coerce.number().finite().min(0).max(20).optional().describe("Also eat without waiting when health is at or below this and food is below 18 (default: 19, i.e. lost at least 1 HP)"),
      defendRange: z.coerce.number().finite().optional().describe("Auto defend range in blocks (default: 4)"),
      idleLook: z.boolean().optional(),
      idleActions: z.boolean().optional()
    },
    async (args) => {
      for (const key of ['autoEat', 'autoDefend', 'urgentFood', 'hurtHealth', 'defendRange'] as const) {
        if (args[key] !== undefined) {
          (reflexSettings as unknown as Record<string, unknown>)[key] = args[key];
        }
      }
      if (args.idleLook !== undefined) socialSettings.idleLook = args.idleLook;
      if (args.idleActions !== undefined) socialSettings.idleActions = args.idleActions;
      return factory.createResponse(`本能设置：${JSON.stringify({ ...reflexSettings, ...socialSettings })}`);
    }
  );

  factory.registerTool(
    "emote",
    "Body language: nod, shake (head), wave (swing arm), jump (happy), crouch (friendly crouch-greeting), spin, look. Faces the player first (default: whoever spoke last). Use it with chat to feel more alive. " +
    "YSM model animations: if data/ysm-emotes.json maps this action to a YSM animation for the current model, it is also played via RCON (`ysm play`). " +
    "`animation` plays a YSM animation by name directly (e.g. extra0..extra7) without the body movement; given together with `action`, it replaces the mapped animation and the body movement is still done. " +
    "YSM animations are only visible to clients with Yes Steve Model installed, and the server never confirms whether the animation exists (ask the player). " +
    "YSM animations loop until stopped, so they stop automatically after `seconds` seconds (default from _durations in the mapping file, else 6); they also stop as soon as a body action (moving, digging, ...) starts. To stop early, call emote with animation: \"idle\". " +
    "Known animation names and mappings are in data/ysm-emotes.json. Give at least one of action / animation",
    {
      action: z.enum(EMOTES).optional(),
      animation: z.string().optional().describe("YSM animation name to play directly, e.g. extra3 (letters, digits, _ . : - only); \"idle\" stops the current animation"),
      seconds: z.coerce.number().min(1).max(60).optional().describe("How long the YSM animation plays before it automatically stops (1-60, default from the mapping file or 6)"),
      player: z.string().optional().describe("Player to face (default: last speaker)")
    },
    async ({ action, animation, seconds, player }) => {
      if (!action && !animation) return factory.createResponse('action 和 animation 至少要给一个');
      const bot = getBot();
      const notes: string[] = [];
      const table = loadYsmEmotes();
      if (table.error) notes.push(table.error);
      const ysmAnimation = animation || (action ? ysmAnimationFor(action, table) : undefined);
      if (ysmAnimation) {
        const duration = seconds ?? ysmDurationFor(ysmAnimation, table);
        const r = await playYsmWithAutoStop(bot, ysmAnimation, duration);
        notes.push(r.ok
          ? `播放了 YSM 动画 ${ysmAnimation}（只有装了 YSM 的客户端看得到，服务端不会确认这个动画存不存在）` +
            (ysmAnimation === 'idle' ? '，回到待机' : `，${duration} 秒后自动停`)
          : `YSM 动画 ${ysmAnimation} 没播成：${r.error}${action ? '，只做了原来的动作' : ''}`);
      }
      if (action) notes.unshift(await emote(bot, action, player));
      return factory.createResponse(notes.join('\n'));
    }
  );
}
