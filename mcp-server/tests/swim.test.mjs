// 游泳本能：头在水里就浮上去；快没气了停下任务、往最近的空气游
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { flatWorld, createFakeBot, Vec3 } from './helpers/fake-bot.mjs';
import { sleep } from './helpers/harness.mjs';
import { startSwimReflex, nearestAir, headUnderwater, SWIM } from '../dist/swim.js';
import { taskGeneration } from '../dist/task-control.js';

let stops = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

// 水池 x,z -3..3、y 64..67（四周石头池壁）；ceiling=true 时 y68 盖一层石头，只在 (3,68,0) 留个口
function pool({ ceiling = false } = {}) {
  const w = flatWorld();
  w.fill(-4, 64, -4, 4, 67, 4, 'stone'); // 池壁
  w.fill(-3, 64, -3, 3, 67, 3, 'water');
  if (ceiling) {
    w.fill(-3, 68, -3, 3, 68, 3, 'stone');
    w.set(3, 68, 0, 'air');
  }
  return w;
}

function start(bot) {
  const events = [];
  const r = startSwimReflex(bot, (type, text) => events.push({ type, text }));
  stops.push(() => r.stop());
  return { events, r };
}

test('找空气：头顶直通水面就是正上方；被石头盖住就找到旁边的口', () => {
  const open = createFakeBot(pool(), { position: new Vec3(0.5, 64, 0.5), withPathfinder: false });
  assert.ok(headUnderwater(open));
  assert.deepEqual(nearestAir(open)?.toArray(), [0, 68, 0]);

  const covered = createFakeBot(pool({ ceiling: true }), { position: new Vec3(0.5, 64, 0.5), withPathfinder: false });
  assert.deepEqual(nearestAir(covered)?.toArray(), [3, 68, 0]);

  const sealed = pool({ ceiling: true });
  sealed.set(3, 68, 0, 'stone');
  const stuck = createFakeBot(sealed, { position: new Vec3(0.5, 64, 0.5), withPathfinder: false });
  assert.equal(nearestAir(stuck), null);
});

test('头在水里、没在寻路：按住跳跃浮上去；出水就松开，不停任务', async () => {
  const bot = createFakeBot(pool(), { position: new Vec3(0.5, 64, 0.5), withPathfinder: false });
  bot.oxygenLevel = 20;
  const gen = taskGeneration();
  const { events } = start(bot);
  await sleep(SWIM.tickMs * 2);
  assert.equal(bot.controlState.jump, true);
  assert.equal(taskGeneration(), gen, '不缺气时不停任务');

  bot.entity.position = new Vec3(0.5, 67, 0.5); // 头伸出水面
  await sleep(SWIM.tickMs * 2);
  assert.equal(bot.controlState.jump, false);
  assert.equal(events.length, 0);
});

test('快没气了：停下任务，朝旁边的口游过去，发一次 danger', async () => {
  const bot = createFakeBot(pool({ ceiling: true }), { position: new Vec3(0.5, 64, 0.5), withPathfinder: false });
  bot.oxygenLevel = 6;
  const gen = taskGeneration();
  const { events, r } = start(bot);
  await sleep(SWIM.tickMs * 3);
  assert.ok(taskGeneration() > gen, '要停下手上的任务');
  assert.equal(bot.controlState.jump, true);
  assert.equal(bot.controlState.forward, true, '口在旁边，要往那边游');
  assert.deepEqual(r.state().target?.toArray(), [3, 68, 0]);
  assert.ok(Math.abs(bot.entity.yaw - (-Math.PI / 2)) < 0.3, `应该朝东（口在 x=3），yaw=${bot.entity.yaw}`);
  const danger = events.filter((e) => e.type === 'danger');
  assert.equal(danger.length, 1);
  assert.match(danger[0].text, /快没气了.*\(3, 68, 0\)/);

  assert.match(danger[0].text, /不用调用移动工具/);

  bot.entity.position = new Vec3(3.5, 67, 0.5); // 游到口下面，头伸进空气
  await sleep(SWIM.tickMs * 2);
  assert.equal(bot.controlState.jump, false);
  assert.equal(bot.controlState.forward, false);
  const after = events.filter((e) => e.type === 'danger');
  assert.equal(after.length, 2);
  assert.match(after[1].text, /^危险解除：游上来换到气了/);
  await sleep(SWIM.tickMs * 2);
  assert.equal(events.filter((e) => e.type === 'danger').length, 2, '只说一次');
});

test('换到气后在水面起伏：10 秒内又沉下去只管往上游，不再停任务、不再报', async () => {
  const bot = createFakeBot(pool({ ceiling: true }), { position: new Vec3(0.5, 64, 0.5), withPathfinder: false });
  bot.oxygenLevel = 6;
  const { events } = start(bot);
  await sleep(SWIM.tickMs * 2);
  bot.entity.position = new Vec3(3.5, 67, 0.5); // 出水
  await sleep(SWIM.tickMs * 2);
  assert.equal(events.length, 2);
  const gen = taskGeneration();
  bot.entity.position = new Vec3(3.5, 65, 0.5); // 又沉下去，氧气还低
  await sleep(SWIM.tickMs * 2);
  assert.equal(bot.controlState.jump, true, '照样往上游');
  assert.equal(taskGeneration(), gen, '不再停任务');
  bot.entity.position = new Vec3(3.5, 67, 0.5);
  await sleep(SWIM.tickMs * 2);
  assert.equal(bot.controlState.jump, false, '出水松开');
  assert.equal(events.length, 2, '不再报');
});
