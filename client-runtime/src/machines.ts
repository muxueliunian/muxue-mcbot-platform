import fs from 'node:fs';
import path from 'node:path';
import type { Body, MachineStatus, Operation } from './body.js';
import type { EventJournal } from './events.js';

/**
 * 8b "load it, leave, come back": a machine the body loaded and left (a furnace without wait), per world. When its
 * time is up the watcher reads the machine (machine-status, no walking) and wakes the model with a machine event:
 * done, stalled (no fuel, result slot full), or unknown (unloaded, another dimension, too far). The model decides
 * when to go back; collecting there forgets it.
 */
export interface PendingMachine {
  key: string; dimension: string; position: { x: number; y: number; z: number }; block: string;
  input?: string; output?: string; queued: number; loadedAt: number; readyAt: number;
  /** Set once the model was told; the entry stays until collected or for {@link FORGET_AFTER_MS}. */
  notifiedAt?: number;
  /** A recheck after collecting: if nothing is left in progress, drop it without an event. */
  quiet?: boolean;
  checks: number; errors: number;
}
const FORGET_AFTER_MS = 2 * 60 * 60_000, MAX_MACHINES = 32;
const key = (dimension: string, p: { x: number; y: number; z: number }) => `${dimension}|${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const at = (p: { x: number; y: number; z: number }) => `(${p.x}, ${p.y}, ${p.z})`;
const short = (id?: string) => id?.replace(/^minecraft:/, '') ?? '?';

export class MachineBook {
  private machines = new Map<string, PendingMachine>();
  private readonly file?: string;
  constructor(runtimeDir?: string, worldId?: string) {
    if (!runtimeDir || !worldId) return;
    this.file = path.join(runtimeDir, 'machines', `${worldId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
    try { for (const machine of JSON.parse(fs.readFileSync(this.file, 'utf8')) as PendingMachine[]) if (machine?.key && machine.position) this.machines.set(machine.key, machine); } catch {}
  }
  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.machines.values()], null, 2));
    fs.renameSync(temporary, this.file);
  }
  list(): PendingMachine[] { return [...this.machines.values()].sort((a, b) => a.readyAt - b.readyAt); }
  track(machine: Omit<PendingMachine, 'key' | 'checks' | 'errors'>): PendingMachine {
    const entry = { ...machine, key: key(machine.dimension, machine.position), checks: 0, errors: 0 };
    this.machines.delete(entry.key); this.machines.set(entry.key, entry);
    while (this.machines.size > MAX_MACHINES) this.machines.delete(this.machines.keys().next().value!);
    this.save(); return entry;
  }
  update(entry: PendingMachine, change: Partial<PendingMachine>): void { if (this.machines.get(entry.key) !== entry) return; Object.assign(entry, change); this.save(); }
  forget(dimension: string, position: { x: number; y: number; z: number }): boolean { const gone = this.machines.delete(key(dimension, position)); if (gone) this.save(); return gone; }
  /** What the model sees in get-status: waiting machines and when they should be done. */
  summary(now = Date.now()): object[] {
    return this.list().map(m => ({ position: m.position, dimension: m.dimension, block: m.block, input: m.input, output: m.output, queued: m.queued,
      ...(m.notifiedAt ? { told: true } : { readyInSeconds: Math.max(0, Math.round((m.readyAt - now) / 1000)) }) }));
  }
}

type Result = Record<string, unknown> & { furnace?: { x: number; y: number; z: number }; type?: string; input?: string; output?: string; queued?: number; readyInSeconds?: number; collected?: number; leftInFurnace?: number };

export class MachineWatch {
  private dimension?: string;
  private lastTick = 0;
  private busy = false;
  constructor(private readonly book: MachineBook, private readonly body: Body, private readonly events: EventJournal,
    private readonly options: { intervalMs?: number; now?: () => number } = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  /** Every finished operation passes here: a furnace loaded without waiting is tracked, collecting there forgets it. */
  operation(operation: Operation): void {
    if (operation.name !== 'smelt-item' || operation.status !== 'succeeded' || !this.dimension) return;
    const result = (operation.result ?? {}) as Result, furnace = result.furnace;
    if (!furnace) return;
    const now = this.now(), dimension = this.dimension;
    if (result.input && result.collected === undefined && (result.queued ?? 0) > 0) {
      // Loaded and left: check when it should be done (a little slack for server lag).
      this.book.track({ dimension, position: furnace, block: result.type ?? 'minecraft:furnace', input: result.input, output: result.output, queued: result.queued ?? 0,
        loadedAt: now, readyAt: now + Math.round((result.readyInSeconds ?? 0) * 1000) + 1500 });
    } else if (result.collected !== undefined) {
      // Collected (or waited until done): forget it; anything still cooking is rechecked quietly right away.
      this.book.forget(dimension, furnace);
      if (result.input === undefined || (result.leftInFurnace ?? 0) > 0)
        this.book.track({ dimension, position: furnace, block: result.type ?? 'minecraft:furnace', input: result.input, output: result.output, queued: 0, loadedAt: now, readyAt: now, quiet: true });
    }
  }
  /** Machines still waiting or told about, for get-status. */
  waiting(): object[] { return this.book.summary(this.now()); }
  /** Called with each observation; checks due machines every few seconds. */
  async tick(dimension: string): Promise<void> {
    this.dimension = dimension;
    const now = this.now();
    if (this.busy || now - this.lastTick < (this.options.intervalMs ?? 3000)) return;
    this.lastTick = now; this.busy = true;
    try {
      for (const machine of this.book.list()) {
        if (machine.notifiedAt) { if (now - machine.notifiedAt > FORGET_AFTER_MS) this.book.forget(machine.dimension, machine.position); continue; }
        if (machine.readyAt > now) continue;
        await this.check(machine, dimension, now);
      }
    } finally { this.busy = false; }
  }
  private tell(machine: PendingMachine, text: string): void {
    if (machine.quiet) { this.book.forget(machine.dimension, machine.position); return; }
    this.book.update(machine, { notifiedAt: this.now() });
    this.events.add('machine', text);
  }
  private async check(machine: PendingMachine, dimension: string, now: number): Promise<void> {
    const where = `${short(machine.block)} ${at(machine.position)}`, what = machine.input ? `${machine.queued} 个 ${short(machine.input)}` : '东西';
    const collect = `想取的时候走过去用 smelt-item furnace=${JSON.stringify(machine.position)}（不带 input）取出来。`;
    if (machine.dimension !== dimension) return this.tell(machine, `${where} 里的${what}到了预计的时间，但你不在那个维度，读不到进度；那边没人时不会烧。${collect}`);
    if (!this.body.machineStatus) return this.tell(machine, `${where} 里的${what}应该好了（按时间估的）。${collect}`);
    let status: MachineStatus;
    try { status = await this.body.machineStatus(machine.position); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'OUT_OF_REACH') return this.tell(machine, `${where} 里的${what}到了预计的时间，但你离得太远读不到进度，那边没加载时不会烧。${collect}`);
      if (machine.errors >= 2) return this.tell(machine, `${where} 里的${what}到了预计的时间，读进度没成功（${(error as Error).message}）。${collect}`);
      this.book.update(machine, { errors: machine.errors + 1, readyAt: now + 20_000 }); return;
    }
    if (status.state === 'unloaded') return this.tell(machine, `${where} 里的${what}到了预计的时间，但那边区块没加载（附近没人），没加载时不会烧，回去后会接着烧。${collect}`);
    if (status.id !== machine.block) { this.book.forget(machine.dimension, machine.position); if (!machine.quiet) this.events.add('machine', `${where} 那里现在是 ${status.id ?? '空的'}，炉子不见了，放进去的${what}可能已经掉出来了。`); return; }
    if (!status.supported) return this.tell(machine, `${where} 里的${what}应该好了（按时间估的）。${collect}`);
    const results = (status.results ?? []).map(s => `${s.count} 个 ${short(s.item)}`).join('、'), left = (status.inputs ?? []).reduce((n, s) => n + s.count, 0);
    if (machine.quiet) {
      // Just collected there: nothing left to do is no news; something still cooking is followed like a fresh load.
      if (left === 0) { this.book.forget(machine.dimension, machine.position); return; }
      this.book.update(machine, { quiet: false, queued: left, input: status.inputs?.[0]?.item ?? machine.input });
    }
    if (left === 0) {
      if (!results) { this.book.forget(machine.dimension, machine.position); return; }
      return this.tell(machine, `${where} 烧好了，里面有 ${results}。不急的话等手头的事做完再去。${collect}`);
    }
    if (status.stalled) return this.tell(machine, `${where} 停了：还剩 ${left} 个 ${short(status.inputs?.[0]?.item)} 没烧，${status.fuel ? '出口可能满了' : '没燃料了'}${results ? `，已经出了 ${results}` : ''}。${status.fuel ? collect : '带上燃料用 smelt-item 再放一次，或先去取成品。'}`);
    // Still working: check again when it should be done now; give up estimating after many rechecks.
    if (machine.checks >= 20) return this.tell(machine, `${where} 还在烧，还剩 ${left} 个${results ? `，已经出了 ${results}` : ''}。${collect}`);
    const wait = status.ticksLeft !== undefined && status.ticksLeft >= 0 ? status.ticksLeft * 50 + 1500 : 30_000;
    this.book.update(machine, { checks: machine.checks + 1, readyAt: now + Math.max(3000, wait) });
  }
}
