export const meta = {
  description: '挖一条水平矿道（1 宽 2 高），遇到岩浆/水/脚下悬空就停；顺手挖掉两边、头顶、脚下露出的矿（连着的矿脉一起挖）；背包里矿够数就提前停',
  params: {
    start: '第一格站立位置 {x,y,z}（脚所在的格子），默认自己前面一格',
    dir: '前进方向 east/west/north/south，必填',
    length: '挖多长，默认 32',
    targets: '够数就停，如 {"raw_iron":64,"diamond":10}（按背包里的数量算），可选',
    skip: '不挖的矿，名字里含这些词就跳过，如 ["redstone","coal"]，可选',
  },
};

const DIRS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
const DANGER = new Set(['lava', 'water']);
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export default async function (ctx, params) {
  const { Vec3, bot } = ctx;
  const d = DIRS[params.dir];
  if (!d) throw new Error('需要 dir：east/west/north/south');
  const [dx, dz] = d;
  const length = Number(params.length ?? 32);
  const targets = params.targets ?? null;
  const me = bot.entity.position.floored();
  const s = params.start ?? { x: me.x + dx, y: me.y, z: me.z + dz };
  const ores = new Map();
  let done = 0;

  const count = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
  const reached = () => targets && Object.entries(targets).every(([k, v]) => count(k) >= Number(v));
  const skip = (params.skip ?? []).map(String);
  const isOre = (b) => b && b.name.endsWith('_ore') && !skip.some((k) => b.name.includes(k));
  const status = () => {
    const p = bot.entity.position;
    const inv = targets ? Object.keys(targets).map((k) => `${k} ${count(k)}`).join('，') : '';
    return `挖了 ${done} 格，现在在 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})。挖到的矿：${fmt(ores)}${inv ? `。背包：${inv}` : ''}`;
  };

  for (let i = 0; i < length; i++) {
    ctx.checkpoint();
    if (reached()) return `够数了。${status()}`;
    const x = s.x + dx * i, y = s.y, z = s.z + dz * i;
    const cells = [new Vec3(x, y, z), new Vec3(x, y + 1, z)];

    for (const c of cells) {
      for (const [ox, oy, oz] of [[0, 0, 0], ...N6]) {
        const b = bot.blockAt(c.offset(ox, oy, oz));
        if (b && DANGER.has(b.name)) return `前面 (${b.position}) 有 ${b.name}，停下。${status()}`;
      }
    }
    const below = bot.blockAt(new Vec3(x, y - 1, z));
    if (below && below.boundingBox !== 'block') return `(${x}, ${y - 1}, ${z}) 是 ${below.name}，脚下不稳，停下。${status()}`;

    await ctx.tool('mine-blocks', { positions: cells.map((c) => ({ x: c.x, y: c.y, z: c.z })), timeoutSeconds: 30 });
    try {
      await ctx.tool('move-to-position', { x, y, z, range: 0, timeoutMs: 8000 });
    } catch (e) {
      return `走不到 (${x}, ${y}, ${z})：${e.message}。${status()}`;
    }

    // 露出来的矿（连着的矿脉最多往外找 3 层）
    let frontier = cells;
    const seen = new Set();
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const found = [];
      for (const c of frontier) {
        for (const [ox, oy, oz] of N6) {
          const b = bot.blockAt(c.offset(ox, oy, oz));
          const key = b && `${b.position}`;
          if (!isOre(b) || seen.has(key)) continue;
          if (b.position.distanceTo(bot.entity.position) > 4.5) continue;
          seen.add(key);
          found.push(b);
        }
      }
      if (!found.length) break;
      for (const b of found) ores.set(b.name, (ores.get(b.name) ?? 0) + 1);
      await ctx.tool('mine-blocks', { positions: found.map((b) => ({ x: b.position.x, y: b.position.y, z: b.position.z })), timeoutSeconds: 40 });
      frontier = found.map((b) => b.position);
    }
    done++;
  }
  return status();
}

function fmt(m) {
  return m.size ? [...m].map(([k, v]) => `${k} x${v}`).join('，') : '无';
}
