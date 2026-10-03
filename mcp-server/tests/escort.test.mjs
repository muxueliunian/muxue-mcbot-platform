// 陪挖（跟随时先打怪、挖露在外面的矿）和按食物回复量算的自动进食
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { flatWorld, createFakeBot, attachTeleportKinematics, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, sleep } from './helpers/harness.mjs';
import { chooseFood, autoEatChoice, reflexSettings } from '../dist/reflexes.js';
import { pickOre, pickHostile } from '../dist/escort.js';

let stops = [];
beforeEach(() => { stops = []; });
afterEach(async () => { for (const s of stops.splice(0)) await s(); });

function player(bot, name, pos) {
  const entity = { id: 900 + Object.keys(bot.players).length, type: 'player', username: name, position: pos, height: 1.8, yaw: 0, pitch: 0 };
  bot.players[name] = { username: name, entity };
  bot.entities[entity.id] = entity;
  return entity;
}

function mob(bot, id, name, pos) {
  const e = { id, type: 'hostile', name, displayName: name, position: pos, height: 1.95, isValid: true };
  bot.entities[id] = e;
  return e;
}

async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await sleep(30);
  return cond();
}

async function escortSetup(world, inventory) {
  const bot = createFakeBot(world, { inventory });
  const h = createHarness(bot);
  const stopKin = attachTeleportKinematics(bot);
  stops.push(async () => { await h.call('stop-action'); stopKin(); });
  return { bot, h };
}

// ---- 吃饭 ----

test('挑食物：缺口够一个食物才吃，挑不浪费里最大的', () => {
  const bot = createFakeBot(flatWorld(), { inventory: [['cooked_beef', 4], ['bread', 4], ['carrot', 4]] });
  bot.food = 19;
  assert.equal(chooseFood(bot, false), undefined, '缺 1 点什么都不吃');
  bot.food = 17;
  assert.equal(chooseFood(bot, false)?.name, 'carrot');
  bot.food = 15;
  assert.equal(chooseFood(bot, false)?.name, 'bread');
  bot.food = 13;
  assert.equal(chooseFood(bot, false)?.name, 'bread', '缺 7 点：牛排 8 点会浪费');
  bot.food = 12;
  assert.equal(chooseFood(bot, false)?.name, 'cooked_beef');
});

test('挑食物：一定要吃时，挑能吃到 18 的里面最小的；金苹果、生鸡肉不自动吃', () => {
  const bot = createFakeBot(flatWorld(), { inventory: [['cooked_beef', 1], ['golden_apple', 1], ['chicken', 1]] });
  bot.food = 16;
  assert.equal(chooseFood(bot, false), undefined);
  assert.equal(chooseFood(bot, true)?.name, 'cooked_beef');
  const only = createFakeBot(flatWorld(), { inventory: [['golden_apple', 1], ['chicken', 1]] });
  only.food = 5;
  assert.equal(chooseFood(only, true), undefined);
});

test('自动进食：只有牛排时等到 12；掉血又回不了血就先吃；饿坏了打架也吃', () => {
  const bot = createFakeBot(flatWorld(), { inventory: [['cooked_beef', 4]] });
  bot.food = 16;
  assert.equal(autoEatChoice(bot), undefined, '缺 4 点不吃牛排');
  bot.health = reflexSettings.hurtHealth;
  assert.equal(autoEatChoice(bot)?.name, 'cooked_beef', '掉了血、饥饿值不到 18');
  bot.health = 20;
  bot.food = 12;
  assert.equal(autoEatChoice(bot)?.name, 'cooked_beef');

  mob(bot, 1, 'zombie', new Vec3(2.5, 64, 0.5));
  assert.equal(autoEatChoice(bot), undefined, '怪在身边先不吃');
  bot.food = 6;
  assert.equal(autoEatChoice(bot)?.name, 'cooked_beef', '饿坏了照样吃');
  delete bot.entities[1];

  bot.food = 12;
  bot.targetDigBlock = bot.blockAt(new Vec3(1, 63, 0));
  assert.equal(autoEatChoice(bot), undefined, '正在挖东西先不吃');
  bot.targetDigBlock = null;
  bot.game.gameMode = 'creative';
  assert.equal(autoEatChoice(bot), undefined);
});

// ---- 挑矿、挑怪 ----

test('挑矿：只挑露在外面的、有镐子能挖的；贴着岩浆、在她脚边的不挑', () => {
  const w = flatWorld();
  w.set(3, 63, 0, 'iron_ore');            // 地面上露着
  w.set(2, 61, 0, 'iron_ore');            // 埋在石头里
  w.set(-3, 63, 3, 'coal_ore');           // 贴着岩浆
  w.set(-3, 63, 4, 'lava');
  const bot = createFakeBot(w, { inventory: [['stone_pickaxe', 1]] });
  const her = player(bot, 'muxue', new Vec3(3.5, 64, 0.5)); // 站在铁矿上
  assert.equal(pickOre(bot, her), null, '她脚下的、埋着的、贴岩浆的都不挑');

  her.position = new Vec3(-2.5, 64, -3.5);
  assert.deepEqual(pickOre(bot, her)?.position.toArray(), [3, 63, 0]);

  const bare = createFakeBot(w);
  assert.equal(pickOre(bare, her), null, '没有镐子不挖铁');
  w.set(3, 63, 0, 'diamond_ore');
  assert.equal(pickOre(bot, her), null, '石镐挖不了钻石');
});

test('挑怪：8 格内看得见的；苦力怕要到 4 格内；隔着墙不打', () => {
  const w = flatWorld();
  const bot = createFakeBot(w);
  const her = player(bot, 'muxue', new Vec3(-3.5, 64, 0.5));
  mob(bot, 1, 'creeper', new Vec3(6.5, 64, 0.5));
  assert.equal(pickHostile(bot, her), null, '苦力怕 6 格不主动打');
  mob(bot, 2, 'zombie', new Vec3(0.5, 64, 7.5));
  assert.equal(pickHostile(bot, her)?.id, 2);
  w.fill(-2, 64, 4, 3, 66, 4, 'stone');
  assert.equal(pickHostile(bot, her), null, '隔着墙');
  bot.entities[1].position = new Vec3(3.5, 64, 0.5);
  assert.equal(pickHostile(bot, her)?.id, 1, '苦力怕 3 格内要打');
});

// ---- 跟随里的陪挖 ----

test('陪挖：身边露着的铁矿先挖掉、捡起来，状态里记个数，普通矿不发事件', async () => {
  const w = flatWorld();
  w.set(2, 63, 0, 'iron_ore');
  const { bot, h } = await escortSetup(w, [['stone_pickaxe', 1]]);
  bot.fakeDrops.iron_ore = () => [['raw_iron', 1]];
  player(bot, 'muxue', new Vec3(-2.5, 64, 0.5));
  assert.match(text(await h.call('follow-player', { username: 'muxue', escort: true })), /陪挖/);
  assert.ok(await waitFor(() => w.name(2, 63, 0) === 'air', 3000), '铁矿应该被挖掉');
  assert.ok(await waitFor(() => bot.countOf('raw_iron') === 1, 3000), '掉落物要捡起来');
  assert.match(text(await h.call('get-status')), /iron_ore×1/);
  assert.equal(h.events.since(0, ['follow']).length, 0);
});

test('陪挖：挖到钻石发事件；石镐挖不了的钻石只说一次', async () => {
  const w = flatWorld();
  w.set(2, 63, 0, 'diamond_ore');
  const { bot, h } = await escortSetup(w, [['stone_pickaxe', 1]]);
  player(bot, 'muxue', new Vec3(-2.5, 64, 0.5));
  await h.call('follow-player', { username: 'muxue', escort: true });
  await sleep(900);
  const said = h.events.since(0, ['follow']).map((e) => e.text);
  assert.equal(said.length, 1);
  assert.match(said[0], /diamond_ore.*没有能挖它的镐子/);
  assert.equal(w.name(2, 63, 0), 'diamond_ore');

  bot.addItem('iron_pickaxe', 1);
  assert.ok(await waitFor(() => w.name(2, 63, 0) === 'air', 3000));
  assert.ok(await waitFor(() => h.events.since(0, ['follow']).some((e) => /挖到了 diamond_ore/.test(e.text)), 2000));
});

test('陪挖：有怪先打怪（换上剑），怪死了接着跟', async () => {
  const w = flatWorld();
  w.set(2, 63, 0, 'iron_ore');
  const { bot, h } = await escortSetup(w, [['stone_pickaxe', 1], ['iron_sword', 1]]);
  player(bot, 'muxue', new Vec3(-2.5, 64, 0.5));
  const zombie = mob(bot, 50, 'zombie', new Vec3(0.5, 64, 4.5));
  let hits = 0;
  const realAttack = bot.attack;
  bot.attack = (e) => {
    realAttack(e);
    if (e === zombie && ++hits >= 3) { delete bot.entities[zombie.id]; zombie.isValid = false; }
  };
  await h.call('follow-player', { username: 'muxue', escort: true });
  assert.ok(await waitFor(() => hits >= 3, 4000), `应该打死僵尸（打了 ${hits} 下）`);
  const firstDig = bot.calls.findIndex((c) => c.type === 'dig');
  const firstAttack = bot.calls.findIndex((c) => c.type === 'attack');
  assert.ok(firstAttack >= 0 && (firstDig < 0 || firstAttack < firstDig), '先打怪再挖矿');
  assert.ok(bot.calls.some((c) => c.type === 'equip' && c.name === 'iron_sword'));
  assert.ok(await waitFor(() => w.name(2, 63, 0) === 'air', 3000), '打完接着挖矿');
});

test('陪挖：stop-action 停下正在挖的矿，普通跟随不挖矿', async () => {
  const w = flatWorld();
  w.set(2, 63, 0, 'iron_ore');
  const { bot, h } = await escortSetup(w, [['stone_pickaxe', 1]]);
  bot.digTimeMs = 2000;
  player(bot, 'muxue', new Vec3(-2.5, 64, 0.5));
  await h.call('follow-player', { username: 'muxue', escort: true });
  assert.ok(await waitFor(() => bot.targetDigBlock, 2000));
  await h.call('stop-action');
  assert.ok(await waitFor(() => !bot.targetDigBlock, 1000));
  assert.equal(w.name(2, 63, 0), 'iron_ore');

  await h.call('follow-player', { username: 'muxue' });
  await sleep(800);
  assert.equal(bot.calls.filter((c) => c.type === 'dig').length, 1, '普通跟随不挖');
});

test('陪挖：背包满了不挖，说一次', async () => {
  const w = flatWorld();
  w.set(2, 63, 0, 'iron_ore');
  const inv = [['stone_pickaxe', 1], ...Array.from({ length: 35 }, () => ['dirt', 64])];
  const { bot, h } = await escortSetup(w, inv);
  player(bot, 'muxue', new Vec3(-2.5, 64, 0.5));
  await h.call('follow-player', { username: 'muxue', escort: true });
  await sleep(900);
  assert.equal(w.name(2, 63, 0), 'iron_ore');
  const said = h.events.since(0, ['follow']).map((e) => e.text);
  assert.deepEqual(said, ['背包满了，矿先不挖']);
});

// ---- 进食：掉了血、挖矿中途 ----

test('自动进食：掉了一点血、饥饿值不到 18 回不了血就吃（血 18.1、饥饿值 17、只有面包）', () => {
  const bot = createFakeBot(flatWorld(), { inventory: [['bread', 4]] });
  bot.food = 17;
  assert.equal(autoEatChoice(bot), undefined, '满血时缺 3 点不吃面包');
  bot.health = 18.1;
  assert.equal(autoEatChoice(bot)?.name, 'bread');
  bot.food = 18;
  assert.equal(autoEatChoice(bot), undefined, '饥饿值 18 能自己回血');
});

function withConsume(bot) {
  bot.consume = async () => {
    const held = bot.heldItem;
    bot.calls.push({ type: 'consume', name: held?.name });
    bot.food = Math.min(20, bot.food + bot.registry.foodsByName[held.name].foodPoints);
    bot.removeItem(held.type, 1);
  };
  return bot;
}

test('一直在挖（mine-blocks）时，挖下一格之前趁空当吃', async () => {
  const w = flatWorld();
  const bot = withConsume(createFakeBot(w, { inventory: [['stone_pickaxe', 1], ['bread', 4]] }));
  const h = createHarness(bot);
  const stopKin = attachTeleportKinematics(bot);
  stops.push(async () => stopKin());
  bot.food = 12;
  const r = text(await h.call('mine-blocks', { positions: [{ x: 1, y: 63, z: 0 }, { x: 1, y: 62, z: 0 }], collect: false }));
  assert.match(r, /挖掉 2 个方块/);
  const firstEat = bot.calls.findIndex((c) => c.type === 'consume');
  const firstDig = bot.calls.findIndex((c) => c.type === 'dig');
  assert.ok(firstEat >= 0 && firstEat < firstDig, '先吃再挖');
  assert.equal(bot.food, 17, '12 → 吃一个面包到 17；缺 3 点不再吃面包（会浪费）');
  assert.equal(bot.calls.filter((c) => c.type === 'consume').length, 1);
});

// ---- 捡掉落物 ----

test('陪挖：墙上比脚高一格的矿，掉落物在洞里也能捡到', async () => {
  const w = flatWorld();
  w.fill(3, 64, -3, 3, 66, 3, 'stone');
  w.set(3, 65, 0, 'iron_ore');
  const { bot, h } = await escortSetup(w, [['stone_pickaxe', 1]]);
  bot.fakeDrops.iron_ore = () => [['raw_iron', 1]];
  player(bot, 'muxue', new Vec3(-2.5, 64, 0.5));
  await h.call('follow-player', { username: 'muxue', escort: true });
  assert.ok(await waitFor(() => w.name(3, 65, 0) === 'air', 3000));
  assert.ok(await waitFor(() => bot.countOf('raw_iron') === 1, 4000), '洞里的掉落物要捡到');
  assert.equal(w.name(3, 64, 0), 'stone', '站在旁边就捡得到，不用挖');
});

test('mine-blocks 挖矿：掉落物卡在石头里走不过去，挖开天然石头去捡；木板墙不挖', async () => {
  const w = flatWorld();
  w.fill(2, 64, -3, 4, 66, 3, 'stone');
  w.set(3, 64, 0, 'iron_ore'); // 埋在墙里第二格
  const bot = createFakeBot(w, { inventory: [['stone_pickaxe', 1]] });
  bot.fakeDrops.iron_ore = () => [['raw_iron', 1]];
  const h = createHarness(bot);
  const stopKin = attachTeleportKinematics(bot);
  stops.push(async () => stopKin());
  const r = text(await h.call('mine-blocks', { positions: [{ x: 3, y: 64, z: 0 }] }));
  assert.equal(bot.countOf('raw_iron'), 1, r);
  assert.match(r, /捡起掉落物 1 堆（为了捡挖开 \d 格）/);

  const w2 = flatWorld();
  w2.fill(2, 64, -3, 4, 66, 3, 'oak_planks');
  w2.set(3, 64, 0, 'iron_ore');
  const bot2 = createFakeBot(w2, { inventory: [['stone_pickaxe', 1]] });
  bot2.fakeDrops.iron_ore = () => [['raw_iron', 1]];
  const h2 = createHarness(bot2);
  const stopKin2 = attachTeleportKinematics(bot2);
  stops.push(async () => stopKin2());
  const r2 = text(await h2.call('mine-blocks', { positions: [{ x: 3, y: 64, z: 0 }] }));
  assert.equal(bot2.countOf('raw_iron'), 0);
  assert.equal(w2.name(2, 64, 0), 'oak_planks', '人造方块不挖');
  assert.match(r2, /还有 1 堆没捡到/);
});

test('吃完后饥饿值晚到：提示写吃前 → 吃后，1.5 秒内不接着再吃', async () => {
  const bot = createFakeBot(flatWorld(), { inventory: [['bread', 4]] });
  bot.consume = async () => {
    bot.calls.push({ type: 'consume' });
    bot.removeItem(bot.heldItem.type, 1);
    setTimeout(() => { bot.food = Math.min(20, bot.food + 5); }, 150); // 服务器稍后才发新的饥饿值
  };
  bot.food = 12;
  const { eatBestFood } = await import('../dist/reflexes.js');
  const msg = await eatBestFood(bot, autoEatChoice(bot));
  assert.equal(msg, '吃了 bread，饥饿值 12 → 17');
  bot.food = 12; // 就算数值又低了，刚吃完也先不吃
  assert.equal(autoEatChoice(bot), undefined);
  await sleep(1600);
  assert.equal(autoEatChoice(bot)?.name, 'bread');
});
