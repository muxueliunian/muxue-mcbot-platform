// 改蓝图（edit-blueprint）：换材料、删格子、改几格
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { flatWorld, createFakeBot } from './helpers/fake-bot.mjs';
import { createHarness, text, tempDir } from './helpers/harness.mjs';
import { loadBlueprint } from '../dist/blueprints.js';

const savedEnv = process.env.MCBOT_DATA_DIR;
process.env.MCBOT_DATA_DIR = tempDir('mcbot-bpedit-');
after(() => {
  if (savedEnv === undefined) delete process.env.MCBOT_DATA_DIR;
  else process.env.MCBOT_DATA_DIR = savedEnv;
});

async function setup() {
  const h = createHarness(createFakeBot(flatWorld()));
  const r = await h.call('save-blueprint', {
    name: '黑白房',
    overwrite: true,
    description: '原版',
    blocks: [
      { x: 0, y: 0, z: 0, block: 'black_concrete' },
      { x: 1, y: 0, z: 0, block: 'black_concrete' },
      { x: 2, y: 0, z: 0, block: 'quartz_block' },
      { x: 0, y: 1, z: 0, block: 'oak_stairs[facing=east,half=top]' },
      { x: 1, y: 1, z: 0, block: 'oak_stairs[facing=west,half=bottom]' },
      { x: 2, y: 1, z: 0, block: 'oak_door[facing=south,half=lower,hinge=left]' }
    ]
  });
  assert.match(text(r), /已保存/);
  return h;
}

const blockAt = (bp, x, y, z) => bp.blocks.find((b) => b[0] === x && b[1] === y && b[2] === z)?.[3];

test('换材料：只写名字全换并保留朝向，写了属性只换对得上的；存成新名字时原来的还在', async () => {
  const h = await setup();
  const r = text(await h.call('edit-blueprint', {
    name: '黑白房',
    saveAs: '木色房',
    replace: [
      { from: 'black_concrete', to: 'stripped_spruce_log[axis=y]' },
      { from: 'oak_stairs[half=top]', to: 'spruce_stairs' },
      { from: 'oak_door', to: 'spruce_door' },
      { from: 'red_wool', to: 'white_wool' }
    ]
  }));
  assert.match(r, /已保存蓝图「木色房」：6 格/);
  assert.match(r, /换 black_concrete → stripped_spruce_log\[axis=y\]：2 格/);
  assert.match(r, /换 oak_stairs\[half=top\] → spruce_stairs：1 格/);
  assert.match(r, /red_wool → white_wool：0 格（一格都没对上/);
  const bp = loadBlueprint('木色房');
  assert.equal(blockAt(bp, 0, 0, 0), 'stripped_spruce_log[axis=y]');
  assert.equal(blockAt(bp, 0, 1, 0), 'spruce_stairs[facing=east,half=top]');
  assert.equal(blockAt(bp, 1, 1, 0), 'oak_stairs[facing=west,half=bottom]');
  assert.equal(blockAt(bp, 2, 1, 0), 'spruce_door[facing=south,half=lower,hinge=left]');
  assert.match(bp.source, /由「黑白房」改出来/);
  assert.equal(blockAt(loadBlueprint('黑白房'), 0, 0, 0), 'black_concrete');
});

test('within 只换范围里的；remove 删格子；set 改/加格子，超出范围时尺寸变大', async () => {
  const h = await setup();
  const r = text(await h.call('edit-blueprint', {
    name: '黑白房',
    overwrite: true,
    replace: [{ from: 'black_concrete', to: 'quartz_block' }],
    within: { from: { x: 1, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } },
    remove: [{ from: { x: 0, y: 1, z: 0 }, to: { x: 1, y: 1, z: 0 } }],
    set: [{ x: 4, y: 0, z: 2, block: 'lantern[hanging=false]' }]
  }));
  assert.match(r, /删掉 2 格/);
  assert.match(r, /改\/加 1 格/);
  const bp = loadBlueprint('黑白房');
  assert.equal(blockAt(bp, 0, 0, 0), 'black_concrete');
  assert.equal(blockAt(bp, 1, 0, 0), 'quartz_block');
  assert.equal(blockAt(bp, 0, 1, 0), undefined);
  assert.equal(blockAt(bp, 4, 0, 2), 'lantern[hanging=false]');
  assert.deepEqual(bp.size, { x: 5, y: 2, z: 3 });
});

test('不说存到哪、没给改动、写错方块、负坐标都不保存', async () => {
  const h = await setup();
  const call = async (args) => text(await h.call('edit-blueprint', { name: '黑白房', ...args }));
  assert.match(await call({ replace: [{ from: 'black_concrete', to: 'stone' }] }), /给 saveAs/);
  assert.match(await call({ overwrite: true }), /给 replace、remove 或 set/);
  assert.match(await call({ overwrite: true, replace: [{ from: 'black_concrete', to: 'no_such_block' }] }), /没有叫 no_such_block/);
  assert.match(await call({ overwrite: true, set: [{ x: 0, y: 0, z: 0, block: 'oak_stairs[facing=up]' }] }), /没保存：oak_stairs 的 facing 只能是/);
  assert.match(await call({ overwrite: true, set: [{ x: -1, y: 0, z: 0, block: 'stone' }] }), /是负的/);
  assert.match(text(await h.call('edit-blueprint', { name: '没有的', overwrite: true, set: [{ x: 0, y: 0, z: 0, block: 'stone' }] })), /没有叫「没有的」的蓝图/);
  assert.equal(blockAt(loadBlueprint('黑白房'), 0, 0, 0), 'black_concrete');
});
