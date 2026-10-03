export const meta = {
  description: '在水里按住跳往上游，头露出水面（能换气）或时间到就停',
  params: {
    seconds: '最多游多久，默认 8',
  },
};

export default async function (ctx, params) {
  const { bot } = ctx;
  const seconds = Number(params.seconds ?? 8);
  const end = Date.now() + seconds * 1000;
  bot.setControlState('jump', true);
  try {
    while (Date.now() < end) {
      const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
      if (head && head.name !== 'water') break;
      await ctx.sleep(200);
    }
    await ctx.sleep(1500); // 露头后多浮一会儿换气
  } finally {
    bot.setControlState('jump', false);
  }
  const p = bot.entity.position;
  return `现在在 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})，氧气 ${bot.oxygenLevel ?? '?'}/20`;
}
