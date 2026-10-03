export const meta = {
  description: '原地按住蹲（潜行）一段时间，时间到或被打断就松开',
  params: {
    seconds: '蹲多久，默认 30',
  },
};

export default async function (ctx, params) {
  const { bot } = ctx;
  const seconds = Number(params.seconds ?? 30);
  bot.setControlState('sneak', true);
  try {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      ctx.checkpoint();
      await ctx.sleep(500);
    }
  } finally {
    bot.setControlState('sneak', false);
  }
  return `蹲了 ${seconds} 秒，已经松开`;
}
