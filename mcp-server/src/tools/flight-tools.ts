import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { canFly, flyTo, isFlying, startFlying, stopFlying } from '../flight.js';

export function registerFlightTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "fly-to",
    "Creative mode only: fly to a position along a route through open air (goes around walls, ceilings, glass and closed doors; can't pass through them, so it can't leave a sealed room). " +
    "By default lands when it arrives; `stay: true` keeps hovering there, e.g. to place blocks within reach with build, which works while hovering. Walking tools land first automatically",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate (where your feet should be)"),
      z: z.coerce.number().describe("Z coordinate"),
      stay: z.boolean().optional().describe("Keep hovering after arriving (default: false = land)")
    },
    async ({ x, y, z, stay = false }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const r = await flyTo(bot, new Vec3(x, y, z), { stay });
      return r.ok ? factory.createResponse(r.message) : factory.createErrorResponse(r.message);
    }
  );

  factory.registerTool(
    "set-flying",
    "Creative mode only: start hovering in place (flying: true) or stop flying and drop to the ground (flying: false)",
    {
      flying: z.boolean().describe("true = hover here, false = land")
    },
    async ({ flying }) => {
      const bot = getBot();
      const where = () => {
        const p = bot.entity.position.floored();
        return `(${p.x}, ${p.y}, ${p.z})`;
      };
      if (flying) {
        if (!canFly(bot)) return factory.createErrorResponse('只有创造模式能飞');
        startFlying(bot);
        return factory.createResponse(`悬停在 ${where()}。用 fly-to 飞去别处；要落地用 set-flying {flying:false}`);
      }
      const was = isFlying(bot);
      const landed = await stopFlying(bot);
      if (landed) return factory.createResponse(`${was ? '已经落地' : '本来就没在飞，站在地上'}：${where()}`);
      return factory.createResponse(`${was ? '已经不飞了' : '本来就没在飞'}，但还没着地（现在 ${where()}），可能还在往下落或者卡在方块边上`);
    }
  );
}
