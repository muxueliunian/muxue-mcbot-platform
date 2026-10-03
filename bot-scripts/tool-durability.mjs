export const meta = {
  description: '列出背包里有耐久的工具、武器、盔甲还剩多少耐久',
  params: {},
};

export default async function (ctx) {
  const items = ctx.bot.inventory.items().filter((i) => i.maxDurability);
  if (!items.length) return '背包里没有带耐久的东西';
  return items
    .map((i) => {
      const left = i.maxDurability - (i.durabilityUsed ?? 0);
      return `${i.name}：${left}/${i.maxDurability}（${Math.round((left / i.maxDurability) * 100)}%）`;
    })
    .join('\n');
}
