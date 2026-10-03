export const meta = {
  description: '挖一条向下的阶梯矿道（1 宽 3 高），每步下降 1 格；遇到岩浆/水就停，顺手挖掉旁边露出的矿',
  params: {
    start: '第一级台阶站立位置 {x,y,z}（脚所在的格子），必填',
    dir: '前进方向 east/west/north/south，默认 west',
    steps: '挖几级，默认 10',
    minY: '最低挖到的 y（站立高度），默认 12',
  },
};

const DIRS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
const DANGER = new Set(['lava', 'water']);

export default async function (ctx, params) {
  const s = params.start;
  if (!s) throw new Error('需要 start');
  const [dx, dz] = DIRS[params.dir ?? 'west'] ?? DIRS.west;
  const steps = Number(params.steps ?? 10);
  const minY = Number(params.minY ?? 12);
  const { Vec3, bot } = ctx;
  const ores = new Map();
  let done = 0;

  for (let i = 0; i < steps; i++) {
    ctx.checkpoint();
    const x = s.x + dx * i, y = s.y - i, z = s.z + dz * i;
    if (y < minY) { ctx.log(`到达最低高度 ${minY}`); break; }
    const cells = [0, 1, 2].map((h) => new Vec3(x, y + h, z));

    // 挖之前看一圈：要挖的格子及其周围有没有岩浆/水
    for (const c of cells) {
      for (const [ox, oy, oz] of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const b = bot.blockAt(c.offset(ox, oy, oz));
        if (b && DANGER.has(b.name)) {
          return `第 ${i + 1} 级附近有 ${b.name}（${b.position}），停下。已挖 ${done} 级。矿：${fmt(ores)}`;
        }
      }
    }
    const below = bot.blockAt(new Vec3(x, y - 1, z));
    if (below && below.boundingBox !== 'block') {
      return `第 ${i + 1} 级脚下是 ${below.name}，不稳，停下。已挖 ${done} 级。矿：${fmt(ores)}`;
    }

    await ctx.tool('mine-blocks', {
      positions: cells.map((c) => ({ x: c.x, y: c.y, z: c.z })),
      timeoutSeconds: 30,
    });

    // 露出来的矿记下并顺手挖
    const orePos = [];
    for (const c of cells) {
      for (const [ox, oz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const b = bot.blockAt(c.offset(ox, 0, oz));
        if (b && b.name.endsWith('_ore')) {
          orePos.push({ x: b.position.x, y: b.position.y, z: b.position.z });
          ores.set(b.name, (ores.get(b.name) ?? 0) + 1);
        }
      }
    }
    if (orePos.length) await ctx.tool('mine-blocks', { positions: orePos, timeoutSeconds: 40 });

    await ctx.tool('move-to-position', { x, y, z });
    done++;
  }
  const p = bot.entity.position;
  return `挖了 ${done} 级，现在在 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})。矿：${fmt(ores)}`;
}

function fmt(m) {
  return m.size ? [...m].map(([k, v]) => `${k} x${v}`).join('，') : '无';
}
