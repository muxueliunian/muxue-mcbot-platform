export const meta = {
  description: '挖一条向上的阶梯矿道（1 宽 2 高，每步上升 1 格），台阶悬空就用背包里的圆石/泥土垫一块，遇到岩浆/水就停，沙砾掉下来会多挖几遍；顺手挖掉旁边露出的矿',
  params: {
    dir: '前进方向 east/west/north/south，必填',
    toY: '挖到的站立高度，默认 16',
    maxSteps: '最多挖几级，默认 80',
    skip: '不挖的矿，名字里含这些词就跳过，如 ["redstone"]，可选',
  },
};

const DIRS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
const DANGER = new Set(['lava', 'water']);
const FILLERS = ['cobbled_deepslate', 'cobblestone', 'dirt', 'deepslate', 'stone', 'tuff', 'andesite', 'diorite', 'granite', 'netherrack'];
const N6 =[[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export default async function (ctx, params) {
  const { Vec3, bot } = ctx;
  const d = DIRS[params.dir];
  if (!d) throw new Error('需要 dir：east/west/north/south');
  const [dx, dz] = d;
  const toY = Number(params.toY ?? 16);
  const maxSteps = Number(params.maxSteps ?? 80);
  const skip = (params.skip ?? []).map(String);
  const isOre = (b) => b && b.name.endsWith('_ore') && !skip.some((k) => b.name.includes(k));
  const ores = new Map();
  let done = 0;
  const status = () => {
    const p = bot.entity.position;
    return `上了 ${done} 级，现在在 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})。挖到的矿：${fmt(ores)}`;
  };

  for (let i = 0; i < maxSteps; i++) {
    ctx.checkpoint();
    const cur = bot.entity.position.floored();
    if (cur.y >= toY) return `到了 y=${toY}。${status()}`;
    const head = new Vec3(cur.x, cur.y + 2, cur.z); // 跳起来要的头顶空间
    const next = [new Vec3(cur.x + dx, cur.y + 1, cur.z + dz), new Vec3(cur.x + dx, cur.y + 2, cur.z + dz)];
    const cells = [head, ...next];

    for (const c of cells) {
      for (const [ox, oy, oz] of [[0, 0, 0], ...N6]) {
        const b = bot.blockAt(c.offset(ox, oy, oz));
        if (b && DANGER.has(b.name)) return `(${b.position}) 有 ${b.name}，停下。${status()}`;
      }
    }
    const step = bot.blockAt(new Vec3(cur.x + dx, cur.y, cur.z + dz));
    if (step && step.boundingBox !== 'block') {
      // 台阶是空的（洞穴里常见），拿背包里的石头类方块垫一块
      const filler = bot.inventory.items().find((it) => FILLERS.includes(it.name));
      if (!filler || step.name !== 'air' && step.name !== 'cave_air') return `台阶 (${step.position}) 是 ${step.name}，踩不上去，停下。${status()}`;
      try {
        await ctx.tool('equip-item', { itemName: filler.name });
        await ctx.tool('place-block', { x: step.position.x, y: step.position.y, z: step.position.z, faceDirection: 'down' });
      } catch (e) {
        return `台阶 (${step.position}) 垫不上：${e.message}。${status()}`;
      }
      if (bot.blockAt(step.position)?.boundingBox !== 'block') return `台阶 (${step.position}) 垫了还是空的，停下。${status()}`;
    }

    // 沙砾、沙子会掉下来补位，多挖几遍
    for (let k = 0; k < 6; k++) {
      const left = cells.filter((c) => bot.blockAt(c)?.boundingBox === 'block');
      if (!left.length) break;
      await ctx.tool('mine-blocks', { positions: left.map((c) => ({ x: c.x, y: c.y, z: c.z })), timeoutSeconds: 30 });
      await ctx.sleep(500);
    }
    try {
      await ctx.tool('move-to-position', { x: next[0].x, y: next[0].y, z: next[0].z, range: 0, timeoutMs: 8000 });
    } catch (e) {
      return `走不上 (${next[0]})：${e.message}。${status()}`;
    }

    const found = [];
    for (const c of cells) {
      for (const [ox, oy, oz] of N6) {
        const b = bot.blockAt(c.offset(ox, oy, oz));
        if (isOre(b) && !found.some((f) => f.position.equals(b.position))) found.push(b);
      }
    }
    if (found.length) {
      for (const b of found) ores.set(b.name, (ores.get(b.name) ?? 0) + 1);
      await ctx.tool('mine-blocks', { positions: found.map((b) => ({ x: b.position.x, y: b.position.y, z: b.position.z })), timeoutSeconds: 40 });
    }
    done++;
  }
  return status();
}

function fmt(m) {
  return m.size ? [...m].map(([k, v]) => `${k} x${v}`).join('，') : '无';
}
