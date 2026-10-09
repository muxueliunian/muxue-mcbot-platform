import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addGameDir, connectionFileOf, findGames, gameDirOf, gameOnline, inspectGame, localAppearances, modelLabels, personaFile, readPersona, removeGameDir, setBotName, writePersona } from '../../scripts/webui-games.mjs';
import { endReason } from '../../scripts/webui-profiles.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-games-'));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const control = (dir, f) => path.join(dir, 'config', 'mcbot-server-control', f);

test('找游戏目录：Prism 系实例用 instance.cfg 的名字，.minecraft 的版本隔离也列，手动加的去重', () => {
  const root = tmp();
  try {
    const appdata = path.join(root, 'AppData');
    const inst = path.join(appdata, 'ElyPrismLauncher', 'instances', 'pack');
    put(path.join(inst, 'instance.cfg'), 'InstanceType=OneSix\nname=我的整合包\n');
    fs.mkdirSync(path.join(inst, 'minecraft', 'mods'), { recursive: true });
    fs.mkdirSync(path.join(appdata, '.minecraft', 'versions', '1.21.1-NeoForge', 'mods'), { recursive: true });
    const server = path.join(root, 'server'); put(path.join(server, 'server.properties'), 'x'); fs.mkdirSync(path.join(server, 'mods'));
    const runtime = path.join(root, 'rt');
    assert.equal(addGameDir(runtime, server).ok, true);
    assert.equal(addGameDir(runtime, `"${server}"`).ok, true, '带引号粘贴也认，不重复记');
    assert.match(addGameDir(runtime, 'relative').error, /完整路径/);
    assert.match(addGameDir(runtime, path.join(root, 'nothing')).error, /不存在/);
    assert.match(addGameDir(runtime, appdata).error, /看不出/);
    const games = findGames(runtime, { APPDATA: appdata });
    assert.deepEqual(games.map((g) => [g.name, g.kind]), [['我的整合包', 'ElyPrism'], ['1.21.1-NeoForge', '.minecraft（版本隔离）'], ['server', '服务器']]);
    assert.equal(removeGameDir(runtime, server).ok, true);
    assert.equal(findGames(runtime, { APPDATA: appdata }).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('游戏状态：核心 jar 按字节比对，读 server.json 的名字，连接文件不带令牌', () => {
  const dir = tmp();
  try {
    const ref = path.join(dir, 'ref.jar'); fs.writeFileSync(ref, 'new');
    put(path.join(dir, 'mods', 'mcbot-server-control-0.1.0.jar'), 'old');
    const g0 = inspectGame({ dir, kind: 'Prism', name: 'x' }, ref);
    assert.equal(g0.core, 'different'); assert.equal(g0.hasConnection, false); assert.equal(g0.nameConfigurable, false);
    fs.writeFileSync(path.join(dir, 'mods', 'mcbot-server-control-0.1.0.jar'), 'new');
    put(control(dir, 'server.json'), JSON.stringify({ worldId: 'auto', username: 'ServerBot', port: 8766 }));
    put(control(dir, 'connection.json'), JSON.stringify({ protocol: 2, backend: 'server', endpoint: 'http://127.0.0.1:8766/v2', token: 'secret-token', worldId: 'sp-w', username: 'ServerBot' }));
    const g = inspectGame({ dir, kind: 'Prism', name: 'x' }, ref);
    assert.deepEqual([g.core, g.username, g.hasConnection, g.worldId, g.nameConfigurable], ['ok', 'ServerBot', true, 'sp-w', true]);
    assert.doesNotMatch(JSON.stringify(g), /secret-token/);
    assert.equal(inspectGame({ dir: path.join(dir, 'none'), kind: 'x', name: 'y' }, ref).core, 'missing');
    assert.equal(gameDirOf(connectionFileOf(dir)), dir);
    assert.equal(gameDirOf(path.join(dir, 'other.json')), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('世界开着没有：用令牌问 hello，只回通不通', async () => {
  const dir = tmp();
  try {
    put(connectionFileOf(dir), JSON.stringify({ endpoint: 'http://127.0.0.1:8766/v2', token: 't' }));
    let auth;
    assert.equal(await gameOnline(connectionFileOf(dir), async (u, init) => { auth = init.headers.authorization; return { ok: true, json: async () => ({ ok: true }) }; }), true);
    assert.equal(auth, 'Bearer t');
    assert.equal(await gameOnline(connectionFileOf(dir), async () => { throw new Error('ECONNREFUSED'); }), false);
    put(connectionFileOf(dir), JSON.stringify({ endpoint: 'http://example.com/v2', token: 't' }));
    assert.equal(await gameOnline(connectionFileOf(dir), async () => { throw new Error('不该发出去'); }), false, '只问本机');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('改游戏名：只改 server.json 的 username，其余字段原样；名字要合法；没有 server.json 先开世界', () => {
  const dir = tmp();
  try {
    assert.match(setBotName(dir, 'Xiaojing').error, /先进一次世界/);
    put(control(dir, 'server.json'), JSON.stringify({ worldId: 'auto', username: 'ServerBot', uuid: 'u', port: 8766, spawn: null }));
    assert.match(setBotName(dir, '小鲸').error, /英文字母/);
    assert.match(setBotName(dir, 'a'.repeat(17)).error, /16/);
    assert.deepEqual(setBotName(dir, 'Xiaojing'), { ok: true, changed: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(control(dir, 'server.json'), 'utf8')), { worldId: 'auto', username: 'Xiaojing', uuid: 'u', port: 8766, spawn: null });
    assert.deepEqual(setBotName(dir, 'Xiaojing'), { ok: true, changed: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('外观：世界没开时列游戏目录里的 YSM 模型（要装适配），显示名读 ysm.json', () => {
  const dir = tmp();
  try {
    const custom = path.join(dir, 'config', 'yes_steve_model', 'custom');
    put(path.join(custom, 'claude_orange', 'ysm.json'), JSON.stringify({ metadata: { name: 'Claude · 暖橙长裙', authors: [{ name: 'Maks' }, { name: 'Ykisan' }] } }));
    put(path.join(custom, 'ds_whale.ysm'), 'bin'); put(path.join(custom, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'mods'));
    assert.deepEqual(localAppearances(dir), [], '没装 YSM 适配就不列');
    put(path.join(dir, 'mods', 'mcbot-yes-steve-model-0.1.0.jar'), 'jar');
    assert.deepEqual(localAppearances(dir), [{ id: 'yes_steve_model:model', choices: ['claude_orange', 'ds_whale.ysm'] }]);
    assert.deepEqual(modelLabels(dir, ['claude_orange', 'ds_whale.ysm', '../x']), {
      claude_orange: { name: 'Claude · 暖橙长裙', authors: ['Maks', 'Ykisan'] }, 'ds_whale.ysm': { name: 'ds_whale', authors: [] } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('人设：位置和驱动器一致（小克在 xiaoke，独立身份按游戏名小写），能读写，示例里写了说话方式', () => {
  const root = tmp();
  try {
    assert.equal(personaFile({ agent: 'claude' }, root), path.join(root, 'memory', 'xiaoke', 'persona.md'));
    assert.equal(personaFile({ agent: 'dsh', username: 'ServerBot' }, root), path.join(root, 'runtime', 'dsh-memory', 'serverbot', 'persona.md'));
    assert.equal(personaFile({ agent: 'codex', username: 'Bot', memoryDir: path.join(root, 'm') }, root), path.join(root, 'm', 'bot', 'persona.md'));
    assert.throws(() => personaFile({ agent: 'dsh' }, root), /游戏名/);
    const opts = { agent: 'dsh', username: 'ServerBot' };
    assert.deepEqual(readPersona(opts, root), { ok: true, file: personaFile(opts, root), exists: false, text: '' });
    assert.equal(writePersona(opts, '# 人设\r\n- 名字：小鲸\n', root).ok, true);
    assert.equal(readPersona(opts, root).text, '# 人设\n- 名字：小鲸\n');
    assert.match(writePersona(opts, 'x'.repeat(8001), root).error, /8000/);
    assert.match(writePersona(opts, 'a\u0000b', root).error, /控制字符/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('托管退出原因：游戏关了算断开，跑了一阵才退出不算启动失败', () => {
  const t = 1000000;
  assert.equal(endReason({ startedAt: t, endedAt: t + 500000, exitCode: 1 }, '服务端停止通道：CONTROL_UNREACHABLE'), 'disconnected');
  assert.equal(endReason({ startedAt: t, endedAt: t + 500000, exitCode: 0 }, '正在退出…（收到停止标记）'), 'stopped');
  assert.equal(endReason({ startedAt: t, endedAt: t + 500000, exitCode: 1 }, 'boom'), 'crashed');
  assert.equal(endReason({ startedAt: t, endedAt: t + 3000, exitCode: 2 }, '找不到 dsh'), 'failed');
});
