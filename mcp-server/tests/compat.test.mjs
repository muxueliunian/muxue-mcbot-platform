import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCompat, checkCompat, registeredIds } from '../../scripts/check-compat.mjs';

// compat.json 是网站、README 和 WebUI 模组页的唯一来源，要和模组代码里锁的版本一致。
test('compat.json matches the versions pinned in the mods', () => {
  assert.deepEqual(checkCompat(loadCompat()), []);
});

test('a drifted list is caught', () => {
  const compat = loadCompat();
  compat.platform.loaderMin = '21.1.229';
  compat.core.jar = 'mcbot-server-control-9.9.9.jar';
  const backpacks = compat.adapters.find(a => a.id === 'sophisticated_backpacks');
  backpacks.requires[0].version = '3.25.78';
  delete backpacks.requires[1].modrinth;
  compat.adapters.find(a => a.kind === 'config').config.mods.kaleidoscope_cookery = '1.5.0';
  const problems = checkCompat(compat).join('\n');
  assert.match(problems, /NeoForge 最低版本：清单 21\.1\.229，McbotApi 21\.1\.217/);
  assert.match(problems, /neoforge\.mods\.toml 的 NeoForge 下限是 21\.1\.217/);
  assert.match(problems, /核心 jar/);
  assert.match(problems, /没有锁 sophisticatedbackpacks 的版本 "3\.25\.78"/);
  assert.match(problems, /sophisticatedcore 缺官方下载信息/);
  assert.match(problems, /配置写 kaleidoscope_cookery 1\.5\.0/);
});

// 「给 AI 用」开关和插件说明按命名空间对应插件：附属模组登记的 id 必须在它 requires 的 mod id 下
test('registered add-on ids are found in source: literals, constants, record arguments and hints; unknown forms are reported', () => {
  const src = `
    final class A implements ContainerAdapter { @Override public String id() { return "mymod:crate"; } }
    final class B { static final String VERSION="1",ID="mymod:furnace"; public String id() {return ID;} }
    private record Step(String id, Object x) implements ItemInteraction {}
    static final Object S = new Step("mymod:pot/stir", null);
    McbotApi.registerHint("mymod:hint", HINT);`;
  assert.deepEqual(registeredIds(src), { ids: ['mymod:crate', 'mymod:furnace', 'mymod:pot/stir', 'mymod:hint'], unresolved: [] });
  const odd = registeredIds('public String id() { return prefix + "x"; } McbotApi.registerHint(name, HINT); record R(String id) {} Object r = new R(make());');
  assert.deepEqual(odd.unresolved, ['prefix + "x"', 'make(', 'name']);
});

test('an add-on id outside its requires namespaces is caught', () => {
  const compat = loadCompat();
  const furnaces = compat.adapters.find(a => a.id === 'iron_furnaces');
  furnaces.requires[0].modId = 'iron_furnaces_renamed';
  const problems = checkCompat(compat).join('\n');
  assert.match(problems, /iron_furnaces：登记的 id ironfurnaces:iron_furnace 的命名空间不是 requires 中的 mod id（iron_furnaces_renamed）/);
  assert.match(problems, /iron_furnaces：登记的 id ironfurnaces:hint/);
  const backpacks = loadCompat();
  backpacks.adapters.find(a => a.id === 'sophisticated_backpacks').requires.splice(0, 1);
  assert.match(checkCompat(backpacks).join('\n'), /sophisticatedbackpacks:backpack\/open 的命名空间不是 requires 中的 mod id（sophisticatedcore）/);
});
