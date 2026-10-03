// 选址用：打印一片区域每一列的地表高度和地表方块
export const meta = {
  description: '扫描以 (x,z) 为中心的方形区域，列出每列地表高度、地表方块，用来选平地建房',
  params: {
    x: '中心 x，默认自己的位置',
    z: '中心 z，默认自己的位置',
    r: '半径，默认 6（最大 16）',
  },
};

export default async function (ctx, params) {
  const { bot, Vec3 } = ctx;
  const p = bot.entity.position;
  const cx = Math.floor(Number(params.x ?? p.x));
  const cz = Math.floor(Number(params.z ?? p.z));
  const r = Math.min(16, Number(params.r ?? 6));
  const top = Math.floor(p.y) + 12;
  const bottom = Math.floor(p.y) - 16;
  const soft = /(^air$|cave_air|short_grass|tall_grass|fern|flower|dandelion|poppy|tulip|daisy|bluet|orchid|allium|cornflower|lily|snow$|_leaves$|vine|bush|sugar_cane)/;

  const names = new Map();
  const rows = [];
  let min = Infinity, max = -Infinity;
  for (let z = cz - r; z <= cz + r; z++) {
    ctx.checkpoint();
    const cells = [];
    for (let x = cx - r; x <= cx + r; x++) {
      let y = top;
      let b = bot.blockAt(new Vec3(x, y, z));
      while (y > bottom && (!b || soft.test(b.name))) {
        y--;
        b = bot.blockAt(new Vec3(x, y, z));
      }
      const name = b ? b.name : '?';
      if (!names.has(name)) names.set(name, String.fromCharCode(97 + names.size));
      const tag = name === 'water' ? '~' : names.get(name);
      if (name !== 'water') { min = Math.min(min, y); max = Math.max(max, y); }
      cells.push(`${String(y).padStart(3)}${tag}`);
    }
    rows.push(`z=${z}: ${cells.join(' ')}`);
  }
  const legend = [...names].map(([n, t]) => `${n === 'water' ? '~' : t}=${n}`).join(', ');
  return [`x 从 ${cx - r} 到 ${cx + r}（每格：高度+方块代号）`, ...rows, `代号：${legend}`, `陆地高度 ${min}~${max}`].join('\n');
}
