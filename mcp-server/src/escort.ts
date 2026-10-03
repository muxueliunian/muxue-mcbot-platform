// 陪挖：跟随时顺手打怪、挖露在外面的矿（程序层，不经过 LLM）。
// 每次跟随 tick 按「打怪 > 挖矿 > 跟着走」挑一件事做；做事期间跟随不碰寻路目标，做完再接着跟。
// 只走安全寻路（不挖路、不垫方块），只挖看得见的矿，不往墙里掏；挖矿照样受保护方块和登记区域约束。
// 只在挖到稀有矿、镐子坏了、背包满了、血太少时发事件，普通的煤和铁只记个数
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { TaskHandle, bodyBusy, currentGrant, emptyGrant, endTask, posKey, runInTask, startTask, taskGeneration } from './task-control.js';
import { checkDig } from './action-policy.js';
import { canSee } from './social.js';
import { claimGaze } from './gaze.js';
import { creeperPrimedRecently, isHostile } from './reflexes.js';
import { digAt, isEmpty, sleep } from './tools/block-ops.js';
import { collectDropsAround } from './pickup.js';

const { goals } = pathfinderPkg;

export const ESCORT = {
  // 怪离小克或玩家这么近、看得见才去打
  fightRange: 8,
  // 苦力怕不主动冲，走到这么近才打
  creeperRange: 4,
  // 追怪时离玩家超过这么远、或追了这么久一下都没打到就放弃
  leash: 12,
  chaseMs: 10000,
  // 血不多于这个就不去打（本能反击照旧）
  minHealth: 8,
  // 矿离小克、离玩家都要在这个范围内
  oreBotRange: 6,
  orePlayerRange: 10,
  // 离玩家这么近（含脚下）的矿不挖，可能是她正要挖的
  orePlayerClear: 1.5,
  // 挖不了的矿、打不到的怪，这么久内不再试
  skipMs: 60000
};

export const ORE = /(_ore|^ancient_debris)$/;
const RARE = /(diamond_ore|emerald_ore|^ancient_debris)$/;
const LIQUID = /^(water|lava|flowing_water|flowing_lava|bubble_column)$/;
const AIRY = /^(air|cave_air|void_air)$/;
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const WEAPON_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

export interface EscortOptions {
  fight: boolean;
  ores: boolean;
}

type Emit = (type: string, text: string) => void;

// 一个陪挖会话：跟随开始时建，跟随结束时 stop
export class Escort {
  private chore: { kind: 'fight' | 'ore'; label: string; abort: () => void } | null = null;
  private stopped = false;
  private readonly skip = new Map<string, number>();
  private readonly mined = new Map<string, number>();
  private readonly told = new Set<string>();
  private hadPickaxe: boolean;

  constructor(private readonly bot: Bot, private readonly username: string, readonly options: EscortOptions, private readonly emit: Emit) {
    this.hadPickaxe = hasPickaxe(bot);
  }

  busy(): boolean {
    return this.chore !== null;
  }

  status(): string {
    const parts: string[] = [];
    if (this.options.fight) parts.push('打怪');
    if (this.options.ores) parts.push('挖矿');
    const mined = [...this.mined].map(([n, c]) => `${n}×${c}`).join('、');
    const doing = this.chore ? `，正在${this.chore.label}` : '';
    return `陪挖（${parts.join('、')}${doing}${mined ? `；挖到 ${mined}` : ''}）`;
  }

  stop(): void {
    this.stopped = true;
    this.chore?.abort();
  }

  // 跟随 tick 调用：有事就开始做（异步），返回 true 表示这一 tick 跟随不用动
  tick(player: Entity): boolean {
    if (this.chore) return true;
    if (this.stopped || bodyBusy()) return false;
    const now = Date.now();
    for (const [k, until] of this.skip) if (until <= now) this.skip.delete(k);

    if (this.options.fight && this.bot.health > ESCORT.minHealth) {
      const mob = pickHostile(this.bot, player, this.skip);
      if (mob) {
        this.run('fight', `打 ${mob.name}`, (h) => this.fight(mob, h));
        return true;
      }
    }
    if (this.options.ores && this.oresAllowed()) {
      const ore = pickOre(this.bot, player, this.skip);
      if (ore) {
        this.run('ore', `挖 ${ore.name}`, (h) => this.mine(ore, h));
        return true;
      }
      this.noteUnharvestable(player);
    }
    return false;
  }

  private tellOnce(key: string, text: string): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.emit('follow', text);
  }

  private oresAllowed(): boolean {
    const has = hasPickaxe(this.bot);
    if (this.hadPickaxe && !has) this.tellOnce('pickaxe', '镐子用坏了，背包里没有镐子了，矿先不挖');
    this.hadPickaxe = has;
    if (this.bot.inventory.emptySlotCount() === 0) {
      this.tellOnce('full', '背包满了，矿先不挖');
      return false;
    }
    this.told.delete('full');
    return true;
  }

  // 附近有矿但工具不够（比如石镐挖钻石），每种矿说一次
  private noteUnharvestable(player: Entity): void {
    for (const pos of oreCandidates(this.bot, player)) {
      const block = this.bot.blockAt(pos);
      if (!block || !RARE.test(block.name) || canHarvestWithInventory(this.bot, block)) continue;
      this.tellOnce(`tool:${block.name}`, `看到 ${block.name}（${pos.x}, ${pos.y}, ${pos.z}），但没有能挖它的镐子`);
    }
  }

  // 每件事在自己的任务里跑：挖矿的授权只给这一格，stop-action 能让它失效
  private run(kind: 'fight' | 'ore', label: string, work: (handle: TaskHandle) => Promise<void>): void {
    const ctx = startTask(`陪挖：${label}`, this.bot, null);
    ctx.grant = emptyGrant();
    let aborted: string | null = null;
    const chore = {
      kind,
      label,
      abort: () => {
        aborted = '陪挖结束';
        endTask(ctx, '陪挖结束');
        if (this.bot.targetDigBlock) this.bot.stopDigging();
        this.bot.pathfinder?.setGoal(null);
      }
    };
    this.chore = chore;
    runInTask(ctx, () => {
      const handle = new TaskHandle({ timeoutMs: kind === 'fight' ? 60000 : 20000, interruptOnChat: false });
      const base = handle.check.bind(handle);
      const gen = taskGeneration();
      const deadline = Date.now() + 60000;
      // 挖矿沿用任务的中断（被打、悄悄话、危险时先停下，下一 tick 再决定）；打架时被打是常事，不因为事件中断
      const own = () => aborted ?? (this.stopped ? '陪挖结束' : null) ?? (bodyBusy() ? '有别的动作要做' : null);
      const raw = kind === 'fight'
        ? () => own() ?? (taskGeneration() !== gen ? '被 stop-action 停止' : null) ?? (Date.now() > deadline ? '打太久了' : null)
        : () => own() ?? base();
      // 一旦中断就一直是中断（base 读过的事件不会再读到）
      let stopReason: string | null = null;
      handle.check = () => (stopReason ??= raw());
      return work(handle);
    })
      .catch(() => undefined)
      .finally(() => {
        endTask(ctx);
        if (this.chore !== chore) return;
        this.chore = null;
        if (!aborted && !bodyBusy()) this.bot.pathfinder?.setGoal(null);
      });
  }

  private async fight(mob: Entity, handle: TaskHandle): Promise<void> {
    const bot = this.bot;
    await equipWeapon(bot);
    bot.pathfinder.setGoal(new goals.GoalFollow(mob as never, 1.5), true);
    let lastHit = 0;
    let progressAt = Date.now();
    try {
      while (!handle.check()) {
        // 追了 chaseMs 还没打到就放弃
        if (Date.now() - progressAt > ESCORT.chaseMs) break;
        if (!bot.entities[mob.id] || mob.isValid === false) return;
        const player = playerEntity(bot, this.username);
        if (!player || player.position.distanceTo(bot.entity.position) > ESCORT.leash || player.position.distanceTo(mob.position) > ESCORT.leash) break;
        if (bot.health <= ESCORT.minHealth) {
          this.emit('follow', `血只剩 ${Math.round(bot.health)}，不追 ${mob.name} 了`);
          break;
        }
        if (mob.name === 'creeper' && creeperPrimedRecently()) break;
        if (mob.position.distanceTo(bot.entity.position) <= 3.5 && Date.now() - lastHit >= 650) {
          lastHit = Date.now();
          progressAt = lastHit;
          claimGaze('combat', 1500);
          await bot.lookAt(mob.position.offset(0, (mob.height ?? 1.8) * 0.8, 0), true).catch(() => undefined);
          bot.attack(mob);
        }
        await sleep(150);
      }
      // 没打死就放弃：一会儿内不再追这只
      if (bot.entities[mob.id] && mob.isValid !== false) this.skip.set(`mob:${mob.id}`, Date.now() + ESCORT.skipMs);
    } finally {
      bot.pathfinder.setGoal(null);
    }
  }

  private async mine(block: Block, handle: TaskHandle): Promise<void> {
    const bot = this.bot;
    const pos = block.position.clone();
    const name = block.name;
    const grant = currentGrant() ?? emptyGrant();
    const result = await digAt(bot, pos, grant, { requireDrops: true, clearFalling: false, handle }).catch((err) => (err as Error).message);
    const now = bot.blockAt(pos);
    if (result !== 'dug' || !now || !isEmpty(now)) {
      // 被打断的下次还能挖；挖不了的一会儿内不再试
      if (!handle.check()) this.skip.set(`ore:${posKey(pos)}`, Date.now() + ESCORT.skipMs);
      return;
    }
    this.mined.set(name, (this.mined.get(name) ?? 0) + 1);
    if (RARE.test(name)) this.emit('follow', `挖到了 ${name}（${pos.x}, ${pos.y}, ${pos.z}）`);
    // 捡干净：走不过去就挖开几格石头过去
    await collectDropsAround(bot, [pos], handle, { radius: 3, digToReach: true, maxItems: 6 });
  }
}

function playerEntity(bot: Bot, username: string): Entity | undefined {
  const key = Object.keys(bot.players ?? {}).find((n) => n.toLowerCase() === username.toLowerCase());
  return key ? bot.players[key]?.entity : undefined;
}

export function hasPickaxe(bot: Bot): boolean {
  return bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'));
}

function canHarvestWithInventory(bot: Bot, block: Block): boolean {
  return block.canHarvest(null) || bot.inventory.items().some((i) => block.canHarvest(i.type));
}

async function equipWeapon(bot: Bot): Promise<void> {
  const rank = (name: string) => {
    const tier = WEAPON_TIERS.findIndex((t) => name.startsWith(`${t}_`));
    const kind = name.endsWith('_sword') ? 0 : name.endsWith('_axe') ? 1 : 2;
    return kind * 10 + (tier < 0 ? 9 : tier);
  };
  const weapon = bot.inventory.items().filter((i) => /_(sword|axe)$/.test(i.name)).sort((a, b) => rank(a.name) - rank(b.name))[0];
  if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand').catch(() => undefined);
}

// 要打的怪：离小克或玩家 fightRange 内、看得见；苦力怕要走到 creeperRange 内、没在点燃
export function pickHostile(bot: Bot, player: Entity, skip: Map<string, number> = new Map()): Entity | null {
  const me = bot.entity.position;
  const candidates = Object.values(bot.entities).filter((e) => {
    if (!e?.position || e === bot.entity || !isHostile(e) || skip.has(`mob:${e.id}`)) return false;
    const dBot = e.position.distanceTo(me);
    if (e.name === 'creeper') return dBot <= ESCORT.creeperRange && !creeperPrimedRecently();
    if (dBot > ESCORT.fightRange && e.position.distanceTo(player.position) > ESCORT.fightRange) return false;
    if (e.position.distanceTo(player.position) > ESCORT.leash) return false;
    return canSee(bot, e);
  });
  candidates.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  return candidates[0] ?? null;
}

// 露在外面：至少一面贴着空气
function exposed(bot: Bot, pos: Vec3): boolean {
  return SIDES.some((d) => AIRY.test(bot.blockAt(pos.plus(d))?.name ?? ''));
}

function nearLiquid(bot: Bot, pos: Vec3): boolean {
  return SIDES.some((d) => LIQUID.test(bot.blockAt(pos.plus(d))?.name ?? ''));
}

function oreCandidates(bot: Bot, player: Entity): Vec3[] {
  const ids = Object.values(bot.registry.blocksByName).filter((b) => ORE.test(b.name)).map((b) => b.id);
  const found = bot.findBlocks({ matching: ids, maxDistance: ESCORT.oreBotRange, count: 64 }) as Vec3[];
  const center = (p: Vec3) => p.offset(0.5, 0.5, 0.5);
  return found.filter((p) => {
    const c = center(p);
    if (c.distanceTo(bot.entity.position) > ESCORT.oreBotRange + 0.5) return false;
    const toPlayer = c.distanceTo(player.position);
    if (toPlayer > ESCORT.orePlayerRange) return false;
    // 她脚下那一格、身边的不挖
    const under = p.x === Math.floor(player.position.x) && p.z === Math.floor(player.position.z) && p.y === Math.floor(player.position.y) - 1;
    if (under || c.distanceTo(player.position.offset(0, 0.9, 0)) <= ESCORT.orePlayerClear + 0.9) return false;
    return exposed(bot, p);
  });
}

// 要挖的矿：露在外面、旁边没有水和岩浆、有合适的镐子、允许挖；按离小克的距离排
export function pickOre(bot: Bot, player: Entity, skip: Map<string, number> = new Map()): Block | null {
  for (const pos of oreCandidates(bot, player)) {
    if (skip.has(`ore:${posKey(pos)}`)) continue;
    const block = bot.blockAt(pos);
    if (!block || !ORE.test(block.name)) continue;
    if (nearLiquid(bot, pos)) continue;
    if (!canHarvestWithInventory(bot, block)) continue;
    const grant = emptyGrant();
    grant.dig.add(posKey(pos));
    if (!checkDig(bot, pos, grant).ok) continue;
    return block;
  }
  return null;
}
