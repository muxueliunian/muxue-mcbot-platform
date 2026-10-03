import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { useGrant, posKey } from '../task-control.js';
import { checkDig, checkPlace } from '../action-policy.js';
import { safeGoto } from '../movement.js';

const unlockSchema = z.array(z.string()).max(8).optional().describe(
  "Registered protected regions (see list-regions) this call may change at this one position. Use only when the player explicitly asked"
);

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
const MAX_FIND_BLOCKS_COUNT = 256;

interface FaceOption {
  direction: string;
  vector: Vec3;
}

export function registerBlockTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "place-block",
    "Place the held block at the specified position (only that position is changed; walking there never digs or places scaffolding)",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Which neighbour of (x,y,z) to attach to, tried first: 'down' (default) = stand it on the block below, 'up' = hang it under the block above, north/south/east/west = stick it to that side. To put something on top of a block, give the position above that block with 'down'"),
      unlockRegions: unlockSchema
    },
    async ({ x, y, z, faceDirection = 'down', unlockRegions }: { x: number, y: number, z: number, faceDirection?: FaceDirection, unlockRegions?: string[] }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const placePos = new Vec3(x, y, z).floored();
      ({ x, y, z } = placePos);
      const grant = useGrant({ unlockRegions });
      grant.place.add(posKey(placePos));
      const verdict = checkPlace(bot, placePos, grant);
      if (!verdict.ok) return factory.createResponse(`不放：${verdict.reason}`);

      const botPos = bot.entity.position.floored();
      if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
        return factory.createResponse(`You can't place a block where you're standing or one block above`);
      }

      const blockAtPos = bot.blockAt(placePos);

      if (blockAtPos && blockAtPos.name !== 'air') {
        return factory.createResponse(`There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`);
      }

      const possibleFaces: FaceOption[] = [
        { direction: 'down', vector: new Vec3(0, -1, 0) },
        { direction: 'north', vector: new Vec3(0, 0, -1) },
        { direction: 'south', vector: new Vec3(0, 0, 1) },
        { direction: 'east', vector: new Vec3(1, 0, 0) },
        { direction: 'west', vector: new Vec3(-1, 0, 0) },
        { direction: 'up', vector: new Vec3(0, 1, 0) }
      ];

      if (faceDirection !== 'down') {
        const specificFace = possibleFaces.find(face => face.direction === faceDirection);
        if (specificFace) {
          possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
        }
      }

      const held = bot.heldItem?.name ?? '空手';
      let lastError = '';
      for (const face of possibleFaces) {
        const referencePos = placePos.plus(face.vector);
        const referenceBlock = bot.blockAt(referencePos);

        if (referenceBlock && referenceBlock.name !== 'air') {
          if (!bot.canSeeBlock(referenceBlock)) {
            const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
            await safeGoto(bot, goal);
          }

          await bot.lookAt(placePos, true);

          try {
            await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
            return factory.createResponse(`Placed ${held} at (${x}, ${y}, ${z}), attached to the block ${face.direction} of it (${referenceBlock.name})`);
          } catch (placeError) {
            log('warn', `Failed to place using ${face.direction} face: ${placeError}`);
            lastError = `${face.direction}（${referenceBlock.name}）：${(placeError as Error).message ?? placeError}`;
            continue;
          }
        }
      }

      return factory.createResponse(lastError
        ? `Failed to place ${held} at (${x}, ${y}, ${z}); last try ${lastError}`
        : `Failed to place ${held} at (${x}, ${y}, ${z}): nothing next to it to attach to`);
    }
  );

  factory.registerTool(
    "dig-block",
    "Dig one block at the specified position. Same protection as mine-blocks: chests/beds/doors, farmland/crops and registered protected regions are refused unless allowed; walking there never digs other blocks",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      allowProtected: z.boolean().optional().describe("Allow digging a chest/bed/door/torch/glass... (default: false)"),
      unlockRegions: unlockSchema
    },
    async ({ x, y, z, allowProtected = false, unlockRegions }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z).floored();
      ({ x, y, z } = blockPos);
      const block = bot.blockAt(blockPos);

      if (!block || block.name === 'air') {
        return factory.createResponse(`No block found at position (${x}, ${y}, ${z})`);
      }

      const grant = useGrant({ allowProtected, unlockRegions });
      grant.dig.add(posKey(blockPos));
      const verdict = checkDig(bot, blockPos, grant);
      if (!verdict.ok) return factory.createResponse(`不挖：${verdict.reason}`);

      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalLookAtBlock(blockPos, bot.world, { reach: 4.5 });
        await safeGoto(bot, goal);
      }

      const current = bot.blockAt(blockPos);
      if (!current || current.name !== block.name) {
        return factory.createResponse(`(${x}, ${y}, ${z}) 已经变成 ${current?.name ?? '未知'}，没有挖`);
      }
      await bot.dig(current);
      return factory.createResponse(`Dug ${block.name} at (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block) {
        return factory.createResponse(`No block information found at position (${x}, ${y}, ${z})`);
      }

      return factory.createResponse(`Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
    }
  );

  factory.registerTool(
    "find-blocks",
    "Find one or more nearby blocks of a specific type",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)"),
      count: z.coerce.number().int().positive().optional().describe("Maximum number of blocks to return (default: 1; values above 256 are clamped)")
    },
    async ({ blockType, maxDistance = 16, count = 1 }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blocksByName = mcData.blocksByName;
      const normalizedCount = Math.min(count, MAX_FIND_BLOCKS_COUNT);

      if (!blocksByName[blockType]) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      const blockId = blocksByName[blockType].id;

      if (normalizedCount === 1) {
        const block = bot.findBlock({
          matching: blockId,
          maxDistance: maxDistance
        });

        if (!block) {
          return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
        }

        return factory.createResponse(`Found ${blockType} at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
      }

      const blocks = bot.findBlocks({
        point: bot.entity.position,
        matching: blockId,
        maxDistance: maxDistance,
        count: normalizedCount
      });

      if (blocks.length === 0) {
        return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      }

      const blocksList = blocks
        .map((block, i) => `${i + 1}. (${block.x}, ${block.y}, ${block.z})`)
        .join('\n');

      return factory.createResponse(`Found ${blocks.length} ${blockType} block(s) within ${maxDistance} blocks:\n${blocksList}`);
    }
  );
}