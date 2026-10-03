// 长途赶路：按 x/z 分段走过去，不用知道目标的高度
export const meta = {
  description: '长途走到指定的 x/z 附近（分段寻路，每段约 64 格；只走路，不挖不垫，过不去就停下），路上随时可被打断',
  params: {
    x: '目标 x，必填',
    z: '目标 z，必填',
    leg: '每段距离，默认 64',
    player: '可选：走到附近后如果看得到这个玩家，就直接走到对方身边',
  },
};

export default async function (ctx, params) {
  const { bot, goals } = ctx;
  const tx = Number(params.x);
  const tz = Number(params.z);
  if (!Number.isFinite(tx) || !Number.isFinite(tz)) throw new Error('需要 x 和 z');
  const leg = Number(params.leg ?? 64);

  let stuck = 0;
  for (let i = 0; i < 100; i++) {
    ctx.checkpoint();
    const p = bot.entity.position;
    const dx = tx - p.x;
    const dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    const target = params.player && bot.players[params.player]?.entity;
    if (target) {
      await goTo(ctx, new goals.GoalFollow(target, 2), 60000);
      return `到 ${params.player} 身边了`;
    }
    if (dist < 4) return `到了 (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;

    const step = Math.min(leg, dist);
    const gx = Math.round(p.x + (dx / dist) * step);
    const gz = Math.round(p.z + (dz / dist) * step);
    const before = p.clone();
    try {
      await goTo(ctx, new goals.GoalNearXZ(gx, gz, 3), 90000);
    } catch (err) {
      if (err instanceof TeleportError) {
        return `途中被传送到 (${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)})，先停下`;
      }
      ctx.log(`第 ${i + 1} 段失败：${err.message}`);
    }
    if (bot.entity.position.distanceTo(before) < 8) {
      stuck++;
      if (stuck >= 3) throw new Error(`走不动了，停在 (${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)})`);
    } else {
      stuck = 0;
    }
  }
  return '走了很多段还没到，先停下';
}

// 用 ctx.goto 走一段（只走路：不挖方块、不垫方块）；被传送或已经看到要找的玩家时提前结束这一段
async function goTo(ctx, goal, timeoutMs) {
  const { bot } = ctx;
  let last = bot.entity.position.clone();
  let reason = null;
  const tick = setInterval(() => {
    const now = bot.entity.position;
    if (now.distanceTo(last) > 16) reason = '被传送了，停下';
    last = now.clone();
    const target = ctx.params.player && bot.players[ctx.params.player]?.entity;
    if (target && !(goal instanceof ctx.goals.GoalFollow) && target.position.distanceTo(now) < 48) reason = reason ?? 'NEAR_PLAYER';
    if (reason) bot.pathfinder.setGoal(null);
  }, 500);
  try {
    await ctx.goto(goal, { timeoutMs });
  } catch (err) {
    if (reason === '被传送了，停下') throw new TeleportError();
    if (reason !== 'NEAR_PLAYER') throw err;
  } finally {
    clearInterval(tick);
  }
  ctx.checkpoint();
}

class TeleportError extends Error {
  constructor() {
    super('被传送了，停下');
    this.name = 'TeleportError';
  }
}
