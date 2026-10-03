// 示例脚本：砍附近的原木，并全部做成木板
export const meta = {
  description: '砍附近的原木，再把原木全部合成木板',
  params: {
    logs: '要砍的原木数量，默认 8',
    planks: '是否合成木板，默认 true',
  },
};

export default async function (ctx, params) {
  const logs = Number(params.logs ?? 8);
  const makePlanks = params.planks !== false;

  const mined = await ctx.tool('mine-blocks', { blockTypes: ['*_log'], count: logs, maxDistance: 32 });
  ctx.log(mined);
  if (mined.includes('提前停止')) return mined;
  if (!makePlanks) return mined;

  // 按背包里的原木种类合成对应的木板
  const made = [];
  for (const item of ctx.bot.inventory.items()) {
    ctx.checkpoint();
    if (!item.name.endsWith('_log')) continue;
    const planks = item.name.replace(/_log$/, '_planks');
    if (!ctx.mcData.itemsByName[planks]) continue;
    // amount 是合成次数，一个原木合成一次得 4 块木板
    const result = await ctx.tool('craft-item', { outputItem: planks, amount: item.count });
    made.push(result.split('\n')[0]);
  }
  return `${mined.split('\n')[0]}；${made.join('；') || '没有可合成的原木'}`;
}
