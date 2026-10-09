import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCompat, checkCompat } from '../../scripts/check-compat.mjs';

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
