import test from 'node:test';
import assert from 'node:assert/strict';
import { commandLineUsesDir, gameDirArg, gameRunState, javaProcesses, normalizeDir, runMessage } from '../../scripts/game-processes.mjs';

test('目录比较：大小写、斜杠、引号、结尾分隔符都不影响；前缀相同的另一个目录不算同一个', () => {
  assert.equal(normalizeDir('"D:\\MC\\A\\"'), normalizeDir('d:/mc/a'));
  assert.notEqual(normalizeDir('D:\\mc\\a'), normalizeDir('D:\\mc\\ab'));
  assert.ok(commandLineUsesDir('javaw.exe --gameDir "D:\\mc\\a" --version 1.21', 'D:\\mc\\a'));
  assert.ok(commandLineUsesDir('javaw.exe --gameDir D:\\MC\\A\\ --version 1.21', 'd:/mc/a'));
  assert.equal(commandLineUsesDir('javaw.exe --gameDir "D:\\mc\\ab" --version 1.21', 'D:\\mc\\a'), false, '--gameDir 是前缀相同的另一个目录');
  assert.equal(commandLineUsesDir('javaw.exe --gameDir "D:\\mc\\a\\versions\\1.21" --version 1.21', 'D:\\mc\\a'), false, '版本子目录不是游戏目录本身');
});

test('--gameDir：带引号取引号内的值，不带引号取到下一个 -- 参数，等号写法也认', () => {
  assert.equal(gameDirArg('java -Xmx4G --gameDir "D:\\a b\\c" --x y'), 'D:\\a b\\c');
  assert.equal(gameDirArg('java --gameDir D:\\a\\c --x y'), 'D:\\a\\c');
  assert.equal(gameDirArg('java --gameDir=D:\\a\\c'), 'D:\\a\\c');
  assert.equal(gameDirArg('java -jar server.jar nogui'), null);
});

test('路径带空格：带引号的游戏目录能认出来，未带引号时也按整段比较', () => {
  assert.ok(commandLineUsesDir('javaw.exe --gameDir "D:\\My Games\\inst" --x', 'D:\\My Games\\inst'));
  assert.ok(commandLineUsesDir('javaw.exe --gameDir D:\\My Games\\inst --x', 'D:\\My Games\\inst'));
  assert.equal(commandLineUsesDir('javaw.exe --gameDir "D:\\My Games\\inst 2" --x', 'D:\\My Games\\inst'), false);
});

test('没有 --gameDir 的进程（服务器）：命令行里出现完整目录才算；目录名只是前缀不算', () => {
  assert.ok(commandLineUsesDir('java -jar "D:\\srv\\server.jar" nogui', 'D:\\srv'));
  assert.ok(commandLineUsesDir('java @D:\\srv\\user_jvm_args.txt nogui', 'D:\\srv'));
  assert.equal(commandLineUsesDir('java -jar D:\\srv2\\server.jar nogui', 'D:\\srv'), false);
  assert.equal(commandLineUsesDir('', 'D:\\srv'), false);
  assert.equal(commandLineUsesDir('java nogui', ''), false);
});

test('游戏状态：世界开着优先；查不了进程时是 unknown（不当作没运行）；进程在跑是 process；否则 off', async () => {
  const dir = 'D:\\mc\\inst';
  let listed = 0;
  const list = (procs) => async () => { listed++; return procs; };
  assert.deepEqual(await gameRunState(dir, { online: async () => true, listProcesses: list([]) }), { state: 'world' });
  assert.equal(listed, 0, '世界开着时不再查进程');
  assert.deepEqual(await gameRunState(dir, { online: async () => false, listProcesses: async () => { throw new Error('boom'); } }), { state: 'unknown', error: 'boom' });
  assert.deepEqual(await gameRunState(dir, { online: async () => false, listProcesses: list([{ pid: 7, commandLine: `javaw --gameDir "${dir}"` }]) }), { state: 'process' });
  assert.deepEqual(await gameRunState(dir, { online: async () => false, listProcesses: list([{ pid: 8, commandLine: 'javaw --gameDir "D:\\mc\\other"' }]) }), { state: 'off' });
  assert.deepEqual(await gameRunState(dir, { online: async () => false, listProcesses: list([]) }), { state: 'off' }, '注入空列表照常可以操作');
});

test('提示文字：世界、加载中（进程）、查不了、服务器各一句，没在运行时为空', () => {
  assert.equal(runMessage('world'), '世界运行中：请先退出世界并关闭游戏再操作');
  assert.equal(runMessage('process'), '游戏运行中：请先关闭游戏再操作');
  assert.equal(runMessage('unknown'), '无法确认游戏是否已关闭：请先关闭游戏后再操作');
  assert.equal(runMessage('process', 'server'), '服务器运行中：请先关闭服务器再操作');
  assert.equal(runMessage('off'), '');
});

test('真实进程查询能跑通（pwsh 输出能解析成数组）', async () => {
  const list = await javaProcesses();
  assert.ok(Array.isArray(list));
  for (const p of list) assert.equal(typeof p.commandLine, 'string');
});
