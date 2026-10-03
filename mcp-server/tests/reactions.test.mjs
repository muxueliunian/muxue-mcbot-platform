// 组 B：程序先反应（听到名字/被打先转头）+ 新事件（player_death / advancement / player_sleep）
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import prismarineChat from 'prismarine-chat';
import { flatWorld, createFakeBot, registry, Vec3 } from './helpers/fake-bot.mjs';
import { sleep } from './helpers/harness.mjs';
import { EventStore } from '../dist/event-store.js';
import { configureTasks, beginBody, endBody } from '../dist/task-control.js';
import { releaseGaze, currentGaze } from '../dist/gaze.js';
import { attachGameEvents } from '../dist/game-events.js';
import { DEATH_CAUSE_WAIT_MS } from '../dist/reactions.js';

const ChatMessage = prismarineChat(registry);
let nextId = 100;

function addPlayer(bot, username, pos) {
  const entity = { id: nextId++, type: 'player', name: 'player', username, position: pos, height: 1.8 };
  bot.entities[entity.id] = entity;
  bot.players[username] = { username, entity };
  return entity;
}

function addMob(bot, name, type, pos) {
  const entity = { id: nextId++, type, name, displayName: name, position: pos, height: 1.95 };
  bot.entities[entity.id] = entity;
  return entity;
}

let w, bot, events;

beforeEach(() => {
  releaseGaze('chat');
  releaseGaze('observe');
  events = new EventStore();
  configureTasks(events, ['Claude', '小克']);
  w = flatWorld();
  bot = createFakeBot(w, { withPathfinder: false });
  attachGameEvents(bot, events);
});

afterEach(() => {
  bot.emit('end', 'test');
});

const eventsOf = (type) => events.since(0).filter((e) => e.type === type).map((e) => e.text);
const facingEast = () => Math.abs(bot.entity.yaw - (-Math.PI / 2)) < 0.05;

// 玩家名字组件：原版会带 insertion；队伍前缀会出现在文字里
const nameComp = (name, prefix = '') => ({ text: '', extra: [{ text: prefix }, { text: name }], insertion: name });

test('聊天里叫名字（不分大小写、昵称也行）就立刻转头看说话的人，并占住视线', () => {
  addPlayer(bot, 'muxue', new Vec3(5.5, 64, 0.5));
  bot.emit('chat', 'muxue', '今天天气不错');
  assert.equal(bot.entity.yaw, 0, '没叫名字不转头');
  bot.emit('chat', 'muxue', '小克，过来');
  assert.ok(facingEast(), `应该看向东边的 muxue，yaw=${bot.entity.yaw}`);
  assert.equal(currentGaze(), 'chat');

  bot.entity.yaw = 0;
  releaseGaze('chat');
  bot.emit('chat', 'muxue', 'hey CLAUDE');
  assert.ok(facingEast());
});

test('私聊不用叫名字也转头；其他 Bot、太远、隔墙都不转', () => {
  addPlayer(bot, 'muxue', new Vec3(5.5, 64, 0.5));
  bot.emit('whisper', 'muxue', '在吗');
  assert.ok(facingEast());

  bot.entity.yaw = 0;
  releaseGaze('chat');
  addPlayer(bot, 'Gemini', new Vec3(-5.5, 64, 0.5));
  bot.emit('chat', 'Gemini', '小克你好');
  assert.equal(bot.entity.yaw, 0, '其他 Bot 叫名字不转头');

  bot.players.muxue.entity.position = new Vec3(0.5, 64, 20.5);
  bot.emit('chat', 'muxue', '小克');
  assert.equal(bot.entity.yaw, 0, '超过 16 格不转头');

  bot.players.muxue.entity.position = new Vec3(5.5, 64, 0.5);
  w.fill(3, 64, -2, 3, 66, 2, 'stone');
  bot.emit('chat', 'muxue', '小克');
  assert.equal(bot.entity.yaw, 0, '隔着石墙看不见不转头');
  w.fill(3, 64, -2, 3, 66, 2, 'glass');
  bot.emit('chat', 'muxue', '小克');
  assert.ok(facingEast(), '隔着玻璃看得见');
});

test('干活时叫名字不抢视线，聊天事件照常记录', () => {
  addPlayer(bot, 'muxue', new Vec3(5.5, 64, 0.5));
  beginBody();
  try {
    bot.emit('chat', 'muxue', '小克，看这里');
  } finally {
    endBody();
  }
  assert.equal(bot.entity.yaw, 0);
  assert.deepEqual(eventsOf('chat'), ['muxue: 小克，看这里']);
});

test('被玩家打：转头看向对方，hurt 文字带名字；被反击范围内的僵尸打交给反击逻辑；不知道是谁打的照旧', () => {
  const muxue = addPlayer(bot, 'muxue', new Vec3(5.5, 64, 0.5));
  bot.emit('entityHurt', bot.entity, muxue);
  assert.ok(facingEast());
  assert.match(eventsOf('hurt')[0], /^受到伤害，被 muxue 打了，生命值 20\.0\/20$/);

  bot.entity.yaw = 0;
  releaseGaze('observe');
  const zombie = addMob(bot, 'zombie', 'hostile', new Vec3(0.5, 64, 3.5));
  bot.emit('entityHurt', bot.entity, zombie);
  assert.equal(bot.entity.yaw, 0, '反击范围内的敌对生物不在这里转头');
  assert.match(eventsOf('hurt')[1], /被 zombie 打了/);

  const skeleton = addMob(bot, 'skeleton', 'hostile', new Vec3(12.5, 64, 0.5));
  bot.emit('entityHurt', bot.entity, skeleton);
  assert.ok(facingEast(), '远处射箭的骷髅要看过去');
  assert.equal(currentGaze(), 'observe');

  bot.emit('entityHurt', bot.entity, undefined);
  assert.equal(eventsOf('hurt')[3], '受到伤害，生命值 20.0/20');

  // 别人受伤不算
  bot.emit('entityHurt', muxue, zombie);
  assert.equal(eventsOf('hurt').length, 4);
});

test('干活时被打：不转头，但 hurt 文字照样带是谁打的', () => {
  const muxue = addPlayer(bot, 'muxue', new Vec3(5.5, 64, 0.5));
  beginBody();
  try {
    bot.emit('entityHurt', bot.entity, muxue);
  } finally {
    endBody();
  }
  assert.equal(bot.entity.yaw, 0);
  assert.match(eventsOf('hurt')[0], /被 muxue 打了/);
});

test('系统消息：别的玩家死亡 → player_death（带原文）；拿到进度 → advancement；普通聊天不算', () => {
  addPlayer(bot, 'muxue', new Vec3(5.5, 64, 0.5));
  addPlayer(bot, 'Gemini', new Vec3(-5.5, 64, 0.5));
  bot.emit('message', new ChatMessage({ translate: 'death.attack.mob', with: [nameComp('muxue'), { translate: 'entity.minecraft.zombie' }] }), 'system', null);
  // 没有 insertion 时按文字认人（队伍前缀在前面）
  bot.emit('message', new ChatMessage({ translate: 'death.fell.accident.generic', with: [{ text: '[小双] Gemini' }] }), 'system', null);
  assert.deepEqual(eventsOf('player_death'), [
    'muxue 死了：muxue was slain by Zombie',
    'Gemini 死了：[小双] Gemini fell from a high place'
  ]);

  bot.emit('message', new ChatMessage({
    translate: 'chat.type.advancement.task',
    with: [nameComp('muxue'), { translate: 'chat.square_brackets', with: [{ translate: 'advancements.story.mine_stone.title' }] }]
  }), 'system', null);
  bot.emit('message', new ChatMessage({
    translate: 'chat.type.advancement.challenge',
    with: [nameComp('Claude', '[小克] '), { translate: 'chat.square_brackets', with: [{ text: 'Hot Tourist Destinations' }] }]
  }), 'system', null);
  assert.deepEqual(eventsOf('advancement'), [
    'muxue 完成了进度「Stone Age」：muxue has made the advancement [Stone Age]',
    '你自己 完成了挑战「Hot Tourist Destinations」：[小克] Claude has completed the challenge [Hot Tourist Destinations]'
  ]);

  bot.emit('message', new ChatMessage({ translate: 'chat.type.text', with: [nameComp('muxue'), { text: 'death.attack.mob 小克' }] }), 'chat', null);
  bot.emit('message', new ChatMessage({ translate: 'multiplayer.player.joined', with: [nameComp('muxue')] }), 'system', null);
  assert.equal(events.since(0).length, 4);
});

test('自己死亡：死亡消息先到就合并进 death 事件，不另发 player_death', () => {
  bot.emit('message', new ChatMessage({ translate: 'death.attack.mob', with: [nameComp('Claude', '[小克] '), { translate: 'entity.minecraft.zombie' }] }), 'system', null);
  assert.equal(events.since(0).length, 0, '死因先记着，等 death');
  bot.emit('death');
  assert.deepEqual(eventsOf('death'), ['死亡了，已在重生点复活。死因：[小克] Claude was slain by Zombie']);
  assert.deepEqual(eventsOf('player_death'), []);
});

test('自己死亡：血量先归零、死因稍后到也能合并；一直等不到就先发不带死因的，晚到再补一条', async () => {
  bot.emit('death');
  assert.equal(eventsOf('death').length, 0);
  await sleep(200);
  bot.emit('message', new ChatMessage({ translate: 'death.fell.accident.generic', with: [nameComp('Claude')] }), 'system', null);
  assert.deepEqual(eventsOf('death'), ['死亡了，已在重生点复活。死因：Claude fell from a high place']);

  bot.emit('death');
  await sleep(DEATH_CAUSE_WAIT_MS + 150);
  assert.deepEqual(eventsOf('death').slice(1), ['死亡了，已在重生点复活']);
  bot.emit('message', new ChatMessage({ translate: 'death.attack.lava', with: [nameComp('Claude')] }), 'system', null);
  assert.deepEqual(eventsOf('death').slice(2), ['补充刚才的死因：Claude tried to swim in lava']);
  assert.deepEqual(eventsOf('player_death'), []);
});

test('player_sleep：真人玩家躺床只报一次，其他 Bot、自己、村民不报', () => {
  const muxue = addPlayer(bot, 'muxue', new Vec3(5.5, 64, 0.5));
  const gemini = addPlayer(bot, 'Gemini', new Vec3(-5.5, 64, 0.5));
  const villager = addMob(bot, 'villager', 'passive', new Vec3(0.5, 64, 5.5));
  bot.emit('entitySleep', muxue);
  bot.emit('entitySleep', muxue);
  bot.emit('entitySleep', gemini);
  bot.emit('entitySleep', villager);
  bot.emit('entitySleep', { ...bot.entity, type: 'player', username: 'Claude' });
  assert.deepEqual(eventsOf('player_sleep'), [
    'muxue 躺到床上了。想一起睡可以用 sleep-in-bed（床在屋里要先 use-entrance 进门）'
  ]);
  assert.equal(bot.calls.length, 0, '不会自动去睡');
});
