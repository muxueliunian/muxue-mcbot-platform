// 本能反应：不经过 LLM，由程序自动执行（自动进食、自动反击）
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { claimGaze } from './gaze.js';

export interface ReflexSettings {
  autoEat: boolean;
  autoDefend: boolean;
  // 饥饿值不超过这个就不管浪费、有什么吃什么（6 以下跑不起来）
  urgentFood: number;
  // 生命值不超过这个（掉了血）、饥饿值又低于 18（不会自然回血）时，也不管浪费先吃
  hurtHealth: number;
  defendRange: number;
}

export const reflexSettings: ReflexSettings = {
  autoEat: true,
  autoDefend: true,
  urgentFood: 6,
  hurtHealth: 19,
  defendRange: 4
};

// 饥饿值到 18 才会自然回血
const REGEN_FOOD = 18;

// 苦力怕在附近点燃时，程序自动往反方向退开（不经过 LLM）
let lastPrimed = { at: 0, x: 0, y: 0, z: 0 };
export function notePrimed(pos: { x: number; y: number; z: number }): void {
  lastPrimed = { at: Date.now(), x: pos.x, y: pos.y, z: pos.z };
}

// 最近 2.5 秒内听到过苦力怕点燃
export function creeperPrimedRecently(): boolean {
  return Date.now() - lastPrimed.at < 2500;
}
let evadingUntil = 0;

const PASSABLE = /^(air|cave_air|short_grass|tall_grass|fern|snow|.*_carpet|.*_flower|dandelion|poppy|.*_tulip)$/;

// 后退方向 1~3 格：脚下实心、身体能过、没有岩浆和落差
function safeToRetreat(bot: Bot, away: { x: number; z: number }): boolean {
  const len = Math.hypot(away.x, away.z);
  if (len < 0.01) return false;
  const p = bot.entity.position;
  for (let d = 1; d <= 3; d++) {
    const x = Math.floor(p.x + (away.x / len) * d);
    const z = Math.floor(p.z + (away.z / len) * d);
    const y = Math.floor(p.y);
    const feet = bot.blockAt(new Vec3(x, y, z));
    const head = bot.blockAt(new Vec3(x, y + 1, z));
    const below = bot.blockAt(new Vec3(x, y - 1, z));
    if (!feet || !head || !below) return false;
    if (!PASSABLE.test(feet.name) || !PASSABLE.test(head.name)) return false;
    if (below.boundingBox !== 'block' || /lava|magma|fire/.test(below.name)) return false;
  }
  return true;
}

let eating = false;
let lastAteAt = 0;
const EAT_COOLDOWN_MS = 1500;
let lastAttack = 0;

export function isHostile(entity: Entity): boolean {
  const kind = (entity as { kind?: string }).kind;
  return entity.type === 'hostile' || kind === 'Hostile mobs';
}

// 不自动吃的：有副作用的、贵重的
const NOT_AUTO = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit', 'golden_apple', 'enchanted_golden_apple', 'chicken']);

function edibles(bot: Bot) {
  const foods = bot.registry.foodsByName;
  return bot.inventory.items().filter((item) => foods[item.name] && !NOT_AUTO.has(item.name));
}

// 挑一个吃的：优先"回复量不超过缺口"里回得最多的（不浪费），一样多就挑饱和度高的；
// force 时没有正好的也要吃：挑能吃到 18（自然回血）里最小的，都不够就挑最大的
export function chooseFood(bot: Bot, force: boolean) {
  const foods = bot.registry.foodsByName;
  const points = (name: string) => foods[name].foodPoints ?? 0;
  const saturation = (name: string) => foods[name].saturation ?? 0;
  const items = edibles(bot);
  const deficit = 20 - bot.food;
  const fits = items.filter((i) => points(i.name) <= deficit)
    .sort((a, b) => points(b.name) - points(a.name) || saturation(b.name) - saturation(a.name));
  if (fits.length) return fits[0];
  if (!force || !items.length) return undefined;
  const need = REGEN_FOOD - bot.food;
  const enough = items.filter((i) => points(i.name) >= need).sort((a, b) => points(a.name) - points(b.name));
  if (enough.length) return enough[0];
  return items.sort((a, b) => points(b.name) - points(a.name))[0];
}

// 不管浪费也要吃：快饿坏了，或者掉了血又回不了血
function mustEat(bot: Bot): boolean {
  return bot.food <= reflexSettings.urgentFood || (bot.health <= reflexSettings.hurtHealth && bot.food < REGEN_FOOD);
}

// 自动进食这一刻要不要吃、吃什么（不吃返回 undefined）：
// 平时缺口够一个食物的回复量才吃；打架时先不吃，正在挖东西时等这一格挖完（betweenDigs 是挖完一格的空当），快饿坏了除外
export function autoEatChoice(bot: Bot, opts: { betweenDigs?: boolean } = {}) {
  if (bot.game.gameMode === 'creative' || bot.food >= 20) return undefined;
  // 刚吃完：饥饿值要等服务器发回来才更新，别接着再吃
  if (Date.now() - lastAteAt < EAT_COOLDOWN_MS) return undefined;
  const urgent = bot.food <= reflexSettings.urgentFood;
  if (!urgent) {
    if (bot.targetDigBlock && !opts.betweenDigs) return undefined;
    const near = bot.nearestEntity((e) => isHostile(e) && e.position.distanceTo(bot.entity.position) <= reflexSettings.defendRange);
    if (near) return undefined;
  }
  return chooseFood(bot, mustEat(bot));
}

let reflexEvent: ((type: string, text: string) => void) | null = null;

// 挖东西的任务每挖一格之前调用：该吃就趁这个空当吃（一直在挖时本能反应的定时检查总碰上"正在挖"）
export async function eatBetweenDigs(bot: Bot): Promise<void> {
  if (!reflexSettings.autoEat || eating) return;
  const food = autoEatChoice(bot, { betweenDigs: true });
  if (!food) return;
  const msg = await eatBestFood(bot, food).catch((err) => `没吃成（${(err as Error).message}）`);
  reflexEvent?.('reflex', `自动进食：${msg}`);
}

export async function eatBestFood(bot: Bot, food = chooseFood(bot, true)): Promise<string> {
  if (eating) return '正在吃东西';
  if (bot.game.gameMode === 'creative') return '创造模式不需要进食';
  if (bot.food >= 20) return '现在不饿（饥饿值 20/20）';
  if (!food) return '背包里没有可以吃的食物';

  eating = true;
  const previous = bot.heldItem;
  const before = bot.food;
  try {
    await bot.equip(food, 'hand');
    await bot.consume();
    // 吃完后服务器才发来新的饥饿值，等一下再报
    for (let i = 0; i < 10 && bot.food === before; i++) await new Promise((r) => setTimeout(r, 50));
    if (previous && previous.name !== food.name) {
      const again = bot.inventory.items().find((i) => i.name === previous.name);
      if (again) await bot.equip(again, 'hand');
    }
    return `吃了 ${food.name}，饥饿值 ${before} → ${bot.food}`;
  } finally {
    eating = false;
    lastAteAt = Date.now();
  }
}

export function startReflexes(bot: Bot, onEvent: (type: string, text: string) => void): void {
  reflexEvent = onEvent;
  const timer = setInterval(() => {
    if (!bot.entity) return;

    const food = reflexSettings.autoEat && !eating ? autoEatChoice(bot) : undefined;
    if (food) {
      eatBestFood(bot, food)
        .then((msg) => onEvent('reflex', `自动进食：${msg}`))
        .catch(() => undefined);
    }

    if (reflexSettings.autoDefend && Date.now() - lastAttack > 650) {
      const target = bot.nearestEntity(
        (e) => isHostile(e) && e.position.distanceTo(bot.entity.position) <= reflexSettings.defendRange
      );
      // 正在点燃的苦力怕不去打（打不停它），交给下面的躲避
      const primedCreeper = target && target.name === 'creeper' && Date.now() - lastPrimed.at < 2500;
      if (target && !primedCreeper) {
        lastAttack = Date.now();
        claimGaze('combat', 1500);
        bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true).catch(() => undefined);
        bot.attack(target);
      }
    }

    // 躲避：2.5 秒内听到附近有苦力怕点燃，且苦力怕在 6 格内
    if (Date.now() - lastPrimed.at < 2500 && Date.now() > evadingUntil) {
      const creeper = bot.nearestEntity((e) => e.name === 'creeper' && e.position.distanceTo(bot.entity.position) <= 6);
      if (creeper) {
        evadingUntil = Date.now() + 1200;
        claimGaze('combat', 1200);
        const away = bot.entity.position.minus(creeper.position);
        const yaw = Math.atan2(-away.x, -away.z);
        if (!safeToRetreat(bot, away)) {
          onEvent('danger', '苦力怕要炸了，但身后不安全（坑/岩浆/墙），没有后退');
          return;
        }
        bot.look(yaw, 0, true)
          .then(() => {
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            setTimeout(() => {
              bot.setControlState('forward', false);
              bot.setControlState('sprint', false);
            }, 1000);
          })
          .catch(() => undefined);
        onEvent('reflex', `苦力怕要炸了，往后躲开`);
      }
    }
  }, 500);

  bot.once('end', () => clearInterval(timer));
}
