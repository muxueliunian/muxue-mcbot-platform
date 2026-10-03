// 复现：多个独立写入者同时更新共享 JSON 数据文件时，记录不能丢失
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/harness.mjs';
import { RegionStore } from '../dist/regions.js';
import { JsonFile } from '../dist/json-file.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const WRITER = path.join(FIXTURES, 'concurrent-writer.mjs');
const HOLDER = path.join(FIXTURES, 'lock-holder.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function regionNames(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).regions.map((r) => r.name).sort();
}

function runWriter(kind, dir, id, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, kind, dir, String(id), String(count)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 && out.includes('done') ? resolve() : reject(new Error(`writer ${id} exit ${code}: ${err}`))));
  });
}

// 跑一个写入进程，不要求成功，把退出码和 stderr 交给调用方判断
function runWriterRaw(kind, dir, id, count, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRITER, kind, dir, String(id), String(count)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

function expectedNames(workers, count) {
  const names = [];
  for (let w = 0; w < workers; w++) for (let i = 0; i < count; i++) names.push(`w${w}-${i}`);
  return names.sort();
}

for (const kind of ['regions', 'places']) {
  test(`${kind}：6 个独立进程各写 25 条，全部保留，没有残留的锁和临时文件`, async () => {
    const dir = tempDir('mcbot-concurrent-');
    await Promise.all(Array.from({ length: 6 }, (_, id) => runWriter(kind, dir, id, 25)));
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${kind}.json`), 'utf8'));
    const names = data[kind].map((r) => r.name).sort();
    assert.equal(names.length, 150);
    assert.deepEqual(names, expectedNames(6, 25));
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${kind}.json`]);
  }, { timeout: 120000 });
}

test('同一进程里两个独立实例在同一毫秒内交替写入，互不覆盖', () => {
  const dir = tempDir('mcbot-same-ms-');
  const file = path.join(dir, 'regions.json');
  const a = new RegionStore(file, 'test-world', 'a');
  const b = new RegionStore(file, 'test-world', 'b');
  for (let i = 0; i < 20; i++) {
    const store = i % 2 ? b : a;
    store.upsert({ name: `r${i}`, kind: 'build', dimension: 'overworld', from: { x: i, y: 60, z: 0 }, to: { x: i, y: 60, z: 0 }, source: 't' });
    // 另一个实例立刻能读到刚写的记录
    const other = i % 2 ? a : b;
    assert.ok(other.list().some((r) => r.name === `r${i}`), `r${i} 应对另一个实例可见`);
  }
  assert.deepEqual(a.list().map((r) => r.name).sort(), Array.from({ length: 20 }, (_, i) => `r${i}`).sort());
});

test('已经死掉的写入者留下的锁会被清理，写入照常进行', () => {
  const dir = tempDir('mcbot-stale-lock-');
  const file = path.join(dir, 'regions.json');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, at: Date.now() - 60000 }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  const store = new RegionStore(file, 'test-world', 'x');
  store.upsert({ name: 'after-stale', kind: 'build', dimension: 'overworld', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, source: 't' });
  assert.deepEqual(store.list().map((r) => r.name), ['after-stale']);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('锁被活着的写入者占用时等到超时就报错，不写入', () => {
  const dir = tempDir('mcbot-busy-lock-');
  const file = path.join(dir, 'regions.json');
  const store = new RegionStore(file, 'test-world', 'x');
  store.upsert({ name: 'first', kind: 'build', dimension: 'overworld', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, source: 't' });
  const before = fs.readFileSync(file, 'utf8');
  // 持有者（这个进程自己）还活着，锁即使已经很旧也不能被抢
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: 'live-holder', at: Date.now() - 60000 }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  const saved = JsonFile.lockTimeoutMs;
  JsonFile.lockTimeoutMs = 300;
  try {
    assert.throws(() => store.upsert({ name: 'second', kind: 'build', dimension: 'overworld', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, source: 't' }), /正被其他进程写入/);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).token, 'live-holder', '别人的锁不能被删');
  } finally {
    JsonFile.lockTimeoutMs = saved;
    fs.unlinkSync(`${file}.lock`);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('另一个进程持锁时间超过 staleLockMs 但仍活着：不抢锁、不覆盖，等它写完后才能写', async () => {
  const dir = tempDir('mcbot-live-holder-');
  const file = path.join(dir, 'regions.json');
  const ready = path.join(dir, 'ready');
  const child = spawn(process.execPath, [HOLDER, file, '2500', ready], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const savedStale = JsonFile.staleLockMs;
  const savedTimeout = JsonFile.lockTimeoutMs;
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await sleep(20);
    assert.ok(fs.existsSync(ready), '持锁进程应已进入临界区');
    JsonFile.staleLockMs = 200;
    JsonFile.lockTimeoutMs = 1000;
    await sleep(400); // 锁的年龄已超过 staleLockMs
    const lockBefore = fs.readFileSync(`${file}.lock`, 'utf8');
    const store = new RegionStore(file, 'test-world', 'intruder');
    assert.throws(() => store.upsert({ name: 'intruder', kind: 'build', dimension: 'overworld', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, source: 't' }), /正被其他进程写入/);
    assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), lockBefore, '持锁进程的锁不能被删或替换');
    assert.equal(await exited, 0);
    assert.deepEqual(regionNames(file), ['from-holder']);
    store.upsert({ name: 'intruder', kind: 'build', dimension: 'overworld', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, source: 't' });
    assert.deepEqual(regionNames(file), ['from-holder', 'intruder']);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally {
    JsonFile.staleLockMs = savedStale;
    JsonFile.lockTimeoutMs = savedTimeout;
    child.kill();
  }
}, { timeout: 30000 });

test('多个进程同时发现同一个旧锁：只清理一次，互斥不被破坏，记录不丢', async () => {
  const dir = tempDir('mcbot-stale-race-');
  const file = path.join(dir, 'regions.json');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, token: 'dead-holder', at: Date.now() - 60000 }));
  await Promise.all(Array.from({ length: 6 }, (_, id) => runWriter('excl', dir, id, 20)));
  const names = regionNames(file);
  assert.equal(names.length, 120);
  assert.deepEqual(names, expectedNames(6, 20));
  // 临界区日志必须是一进一出成对出现，不能有两个写入者同时在里面
  const lines = fs.readFileSync(path.join(dir, 'excl.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 240);
  for (let i = 0; i < lines.length; i += 2) {
    const enter = lines[i];
    const exit = lines[i + 1];
    assert.ok(enter.startsWith('enter ') && exit === `exit ${enter.slice(6)}`, `第 ${i + 1} 行起出现交错：${enter} / ${exit}`);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['excl.log', 'regions.json']);
}, { timeout: 120000 });

test('一个写入者正在清理旧锁时，另一个写入者不能同时清理或建新锁（确定性检查）', () => {
  const dir = tempDir('mcbot-stale-hook-');
  const file = path.join(dir, 'regions.json');
  const make = () => new JsonFile(file, () => ({ version: 1, regions: [] }), (d) => Boolean(d && d.version === 1 && Array.isArray(d.regions)));
  const a = make();
  const b = make();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, token: 'dead-holder', at: Date.now() - 60000 }));
  const savedTimeout = JsonFile.lockTimeoutMs;
  let hookRuns = 0;
  JsonFile.testHooks.beforeStaleRemoval = (lockFile) => {
    hookRuns++;
    if (hookRuns > 1) return;
    // b 已经判定旧锁过期、正要清理：此时 a 也来写
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'dead-holder');
    JsonFile.lockTimeoutMs = 200;
    try {
      // b 此刻正持着门，a 只能等门；等不到就报错（门不会被自动删除）
      assert.throws(() => a.update((d) => { d.regions.push({ name: 'from-a' }); }), /门文件 .* 一直没有释放/);
    } finally {
      JsonFile.lockTimeoutMs = savedTimeout;
    }
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'dead-holder', 'a 不能动这个锁');
  };
  try {
    b.update((d) => { d.regions.push({ name: 'from-b' }); });
  } finally {
    JsonFile.testHooks.beforeStaleRemoval = undefined;
    JsonFile.lockTimeoutMs = savedTimeout;
  }
  assert.equal(hookRuns, 1);
  assert.deepEqual(regionNames(file), ['from-b']);
  assert.deepEqual(fs.readdirSync(dir), ['regions.json']);
  a.update((d) => { d.regions.push({ name: 'from-a' }); });
  assert.deepEqual(regionNames(file), ['from-a', 'from-b']);
});

test('锁在写入过程中被别人换掉：放弃这次保存，也不删除别人的新锁', () => {
  const dir = tempDir('mcbot-lock-replaced-');
  const file = path.join(dir, 'regions.json');
  const store = new JsonFile(file, () => ({ version: 1, regions: [] }), (d) => Boolean(d && d.version === 1 && Array.isArray(d.regions)));
  store.update((d) => { d.regions.push({ name: 'kept' }); });
  const before = fs.readFileSync(file, 'utf8');
  const newLock = JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now() });
  assert.throws(() => store.update((d) => {
    d.regions.push({ name: 'lost-lock-write' });
    fs.writeFileSync(`${file}.lock`, newLock); // 模拟锁已被别人接管
  }), /锁已经不是自己的/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '失去锁后不能写入');
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), newLock, '不能删掉别人的锁');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['regions.json', 'regions.json.lock'], '临时文件要清掉');
});

test('持有者已退出的锁（即使很新）会被清理；损坏且很旧的锁也会被清理', () => {
  const dir = tempDir('mcbot-dead-fresh-');
  const file = path.join(dir, 'regions.json');
  const store = new RegionStore(file, 'test-world', 'x');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, token: 'dead', at: Date.now() }));
  store.upsert({ name: 'a', kind: 'build', dimension: 'overworld', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, source: 't' });
  fs.writeFileSync(`${file}.lock`, '{ broken');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  store.upsert({ name: 'b', kind: 'build', dimension: 'overworld', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, source: 't' });
  assert.deepEqual(store.list().map((r) => r.name).sort(), ['a', 'b']);
  assert.deepEqual(fs.readdirSync(dir), ['regions.json']);
});

test('遗留的门文件：两个独立进程都安全失败，数据和门文件都不变；人工清理后并发写入照常', async () => {
  const dir = tempDir('mcbot-gate-');
  const file = path.join(dir, 'regions.json');
  const store = new RegionStore(file, 'test-world', 'setup');
  store.upsert({ name: 'before', kind: 'build', dimension: 'overworld', from: { x: 0, y: 60, z: 0 }, to: { x: 0, y: 61, z: 0 }, source: 'setup' });
  const before = fs.readFileSync(file, 'utf8');

  // 模拟有进程在持门的一瞬间崩溃：门文件留了下来，而且已经很旧、写它的进程也早就不在了
  const gate = `${file}.gate`;
  const gateRaw = JSON.stringify({ pid: 999999, token: 'leftover' });
  fs.writeFileSync(gate, gateRaw);
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(gate, old, old);

  const env = { MCBOT_LOCK_TIMEOUT_MS: '400', MCBOT_WRITER_DELAY_MS: '0' };
  const results = await Promise.all([runWriterRaw('regions', dir, 0, 1, env), runWriterRaw('regions', dir, 1, 1, env)]);
  for (const r of results) {
    assert.notEqual(r.code, 0);
    assert.match(r.err, /门文件/);
    assert.match(r.err, /这次没有保存/);
    assert.match(r.err, /停掉所有在用这个数据目录的 MCP 服务/);
  }
  // 两个进程都没改数据、没删门、没留下锁或临时文件
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(gate, 'utf8'), gateRaw);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['regions.json', 'regions.json.gate']);

  // 受控清理（人工删掉遗留门文件）之后，并发写入恢复正常，记录一条不少
  fs.unlinkSync(gate);
  await Promise.all([0, 1, 2].map((i) => runWriter('regions', dir, i, 5)));
  assert.deepEqual(regionNames(file), ['before', ...expectedNames(3, 5)].sort());
  assert.deepEqual(fs.readdirSync(dir), ['regions.json']);
});
