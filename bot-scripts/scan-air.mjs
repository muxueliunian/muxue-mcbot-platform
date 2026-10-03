export const meta = {
  description: '列出一个方块体范围内所有空气/非实心方块的位置（查墙洞、找入口用）',
  params: {
    from: '角1 {x,y,z}，必填',
    to: '角2 {x,y,z}，必填',
    shell: 'true 时只查外壳（默认 true）',
  },
};

export default async function (ctx, params) {
  const { from, to } = params;
  if (!from || !to) throw new Error('需要 from 和 to');
  const shell = params.shell !== false && params.shell !== 'false';
  const [x0, x1] = [Math.min(from.x, to.x), Math.max(from.x, to.x)];
  const [y0, y1] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
  const [z0, z1] = [Math.min(from.z, to.z), Math.max(from.z, to.z)];
  const found = [];
  for (let x = x0; x <= x1; x++) {
    ctx.checkpoint();
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const onShell = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
        if (shell && !onShell) continue;
        const b = ctx.bot.blockAt(new ctx.Vec3(x, y, z));
        if (!b) continue;
        if (b.boundingBox !== 'block') found.push(`${b.name}(${x},${y},${z})`);
      }
    }
  }
  return found.length ? `非实心 ${found.length} 处：${found.join(' ')}` : '外壳全是实心方块';
}
