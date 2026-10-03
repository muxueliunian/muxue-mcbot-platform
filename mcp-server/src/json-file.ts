// 多个 Bot（多个进程）共用的小型 JSON 数据文件。
// - 修改：持有数据文件旁的锁文件（内容带 pid 和本次随机 token）期间，读取最新内容、修改、写临时文件再改名
// - 锁的创建、过期清理、释放都要先拿到"门"文件（.gate，只持有约 1 毫秒），
//   所以多个进程同时发现同一个旧锁时只有一个能清理，旧持有者释放时也不会删掉别人新建的锁
// - 门文件不会被自动删除：进程在持门的那一瞬间崩溃会留下遗留门文件，之后所有写入都明确报错
//   （宁可不保存，也不冒险删掉别人正在用的门）。恢复办法见报错信息和 docs/archive/companion_roadmap.md
// - 锁只有在持有进程已经不存在（或内容损坏且很旧）时才算过期；活着的写入者持锁再久也不会被抢，别人等到超时报错
// - 改名前再次确认锁仍然是自己的，不是就放弃这次保存
// - 读取：每次读文件，内容和上次完全相同时直接用缓存
// - Windows 上文件被其他进程短暂占用时（EPERM/EBUSY/EACCES）重试
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let tmpCounter = 0;

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function retrying<R>(fn: () => R, totalMs = 3000): R {
  const deadline = Date.now() + totalMs;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code) || Date.now() > deadline) throw err;
      sleepSync(5 + Math.random() * 20);
    }
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockInfo {
  pid: number;
  token: string;
}

interface LockState {
  raw: string;
  info: LockInfo | null;
  mtime: number;
}

// 读锁文件；不存在返回 null
function readLock(file: string): LockState | null {
  let raw: string;
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT') return null;
    if (TRANSIENT.has(code)) return { raw: '', info: null, mtime: Date.now() };
    throw err;
  }
  let info: LockInfo | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number') info = { pid: parsed.pid, token: String(parsed.token ?? '') };
  } catch {
    info = null;
  }
  return { raw, info, mtime };
}

// 是否可以当作已失效的锁清理掉
function lockIsStale(state: LockState, staleMs: number): boolean {
  if (!state.info) return Date.now() - state.mtime > staleMs; // 内容损坏：只有很旧才清理（可能正在写入内容）
  if (state.info.pid === process.pid) return false; // 本进程持有：一定还活着
  return !processAlive(state.info.pid);
}

function tryCreate(file: string, content: string): boolean {
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST' || TRANSIENT.has(code)) return false;
    throw err;
  }
}

function tryUnlink(file: string): void {
  try {
    retrying(() => fs.unlinkSync(file));
  } catch {
    // 已经不在了
  }
}

export interface JsonFileTestHooks {
  // 已判定旧锁过期、正要清理它时调用（仍持有门）
  beforeStaleRemoval?: (lockFile: string) => void;
}

export class JsonFile<T> {
  // 等锁的最长时间；测试里可以调小
  static lockTimeoutMs = 5000;
  // 内容损坏的锁超过这么久才清理；活着的持有者不受这个时间影响
  static staleLockMs = 15000;
  // 门文件正常只持有约 1 毫秒；等不到就报错，绝不自动删除（见文件顶部说明）
  static testHooks: JsonFileTestHooks = {};

  private cache: T;
  private cacheRaw: string | null = null;
  private token: string | null = null;

  constructor(
    readonly file: string | null,
    private readonly empty: () => T,
    private readonly validate: (data: unknown) => data is T
  ) {
    this.cache = empty();
  }

  private get lockFile(): string {
    return `${this.file}.lock`;
  }

  private get gateFile(): string {
    return `${this.file}.gate`;
  }

  // 文件不存在时返回空数据；内容损坏时抛出错误（调用方决定如何保守处理）
  read(): T {
    if (!this.file) return this.cache;
    const file = this.file;
    let raw: string;
    try {
      raw = retrying(() => fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = this.empty();
        this.cacheRaw = null;
        return this.cache;
      }
      throw err;
    }
    if (raw === this.cacheRaw) return this.cache;
    const parsed: unknown = JSON.parse(raw);
    if (!this.validate(parsed)) throw new Error(`数据文件格式不对：${file}`);
    this.cache = parsed;
    this.cacheRaw = raw;
    return parsed;
  }

  private busyError(): Error {
    return new Error(`数据文件 ${this.file} 正被其他进程写入，${JsonFile.lockTimeoutMs} 毫秒内没等到，这次没有保存`);
  }

  private gateError(): Error {
    return new Error(
      `数据文件 ${this.file} 的门文件 ${this.gateFile} 一直没有释放，${JsonFile.lockTimeoutMs} 毫秒内没等到，这次没有保存（数据和锁都没有改动）。` +
        `门文件正常只存在约 1 毫秒，一直在说明有进程在持门时崩溃了。恢复办法：先停掉所有在用这个数据目录的 MCP 服务，确认没有进程在跑，` +
        `再人工删除 ${this.gateFile}（必要时一并删除同目录下残留的 .lock 和 .tmp 文件），然后重新启动。程序不会自动删除它`
    );
  }

  // 在门内执行 fn（门持有时间很短）
  private withGate<R>(deadline: number, fn: () => R): R {
    const token = randomUUID();
    const content = JSON.stringify({ pid: process.pid, token });
    for (;;) {
      if (tryCreate(this.gateFile, content)) break;
      // 遗留的门文件不自动清理：无法可靠区分"持门者刚崩溃"和"持门者正在这 1 毫秒里工作"，
      // 删错了就会让两个进程同时改锁，可能覆盖别人的数据。等不到就报错，交给人工处理
      if (Date.now() > deadline) throw this.gateError();
      sleepSync(1 + Math.random() * 4);
    }
    try {
      return fn();
    } finally {
      const gate = readLock(this.gateFile);
      if (gate?.info?.token === token) tryUnlink(this.gateFile);
    }
  }

  private acquire(): void {
    const deadline = Date.now() + JsonFile.lockTimeoutMs;
    const token = randomUUID();
    const content = JSON.stringify({ pid: process.pid, token, at: Date.now() });
    for (;;) {
      const got = this.withGate(deadline, () => {
        const current = readLock(this.lockFile);
        if (current) {
          if (!lockIsStale(current, JsonFile.staleLockMs)) return false;
          JsonFile.testHooks.beforeStaleRemoval?.(this.lockFile);
          const again = readLock(this.lockFile);
          if (!again || again.raw !== current.raw) return false; // 已经变了，下一轮重新判断
          tryUnlink(this.lockFile);
        }
        return tryCreate(this.lockFile, content);
      });
      if (got) {
        this.token = token;
        return;
      }
      if (Date.now() > deadline) throw this.busyError();
      sleepSync(5 + Math.random() * 25);
    }
  }

  private stillHolding(): boolean {
    return this.token !== null && readLock(this.lockFile)?.info?.token === this.token;
  }

  // 只删除自己的锁；锁已经被别人换掉就不动
  private release(): void {
    const token = this.token;
    this.token = null;
    if (!token) return;
    try {
      this.withGate(Date.now() + JsonFile.lockTimeoutMs, () => {
        if (readLock(this.lockFile)?.info?.token === token) tryUnlink(this.lockFile);
      });
    } catch {
      // 等不到门：锁留给过期清理（本进程退出后会被判定为过期）
    }
  }

  // 在锁内基于最新内容修改并保存；fn 抛出错误或锁已不是自己的时候不写入
  update<R>(fn: (data: T) => R): R {
    if (!this.file) throw new Error('没有配置数据目录');
    const file = this.file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.acquire();
    let result: R;
    try {
      this.cacheRaw = null;
      const data = structuredClone(this.read());
      result = fn(data);
      const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      try {
        if (!this.stillHolding()) throw new Error(`数据文件 ${file} 的锁已经不是自己的，放弃这次保存`);
        retrying(() => fs.renameSync(tmp, file));
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      this.release();
    }
    this.cacheRaw = null;
    this.read();
    return result;
  }
}
