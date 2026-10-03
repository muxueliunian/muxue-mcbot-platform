// 记忆：分层的 Markdown 文件，按 docs/memory_plan.md 设计，不依赖任何 harness 的导入机制
//   <memoryDir>/shared/world.md              世界现状（覆盖写）
//   <memoryDir>/shared/players/<名字>.md      玩家档案
//   <memoryDir>/<agent>/persona.md           核心人设（只读，改前要问玩家）
//   <memoryDir>/<agent>/bonds.md             长期回忆
//   <memoryDir>/<agent>/goals.md             想做的事
//   <memoryDir>/<agent>/digest.md            最近几天的摘要
//   <memoryDir>/<agent>/journal/YYYY-MM-DD.md 事件日志（程序自动写 + memory-note）
//   <memoryDir>/<agent>/state.json           上次整理的时间（驱动器也读它）
import fs from 'node:fs';
import path from 'node:path';

export const WRITABLE_SECTIONS = ['digest', 'goals', 'bonds', 'world'] as const;
export type WritableSection = typeof WRITABLE_SECTIONS[number];

// 每段的字数上限：超了就让写的人先压缩，保证开局上下文不会越长越大
export const SECTION_LIMITS: Record<WritableSection, number> = {
  digest: 3500,
  goals: 1500,
  bonds: 4000,
  world: 3000
};

const SECTION_TITLES: Record<WritableSection, string> = {
  digest: '最近几天',
  goals: '想做的事',
  bonds: '回忆',
  world: '世界现状'
};

const BACKUPS_KEPT = 10;
const CONTEXT_JOURNAL_LINES = 15;
const NOTE_MAX = 300;
// 日志一行最多存这么多字（MC 聊天一条最多 256 字，任务结果已经截到 120 字），只防意外的超长输入
const LINE_MAX = 2000;
const PENDING_PAGE_MAX = 200;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10_000;

export interface MemoryState {
  // 上次整理完成的时间（驱动器用它算躺床整理的间隔）
  consolidatedAt: number;
  // 整理到哪一条日志为止（游标 YYYY-MM-DD#N：那天的第 N 条）；null 表示旧格式，按时间算
  through: string | null;
}

export interface JournalEntry {
  date: string;
  // 这一天的第几条（从 1 开始）
  index: number;
  at: number;
  line: string;
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})#(\d+)$/;
// 同步等待几毫秒（等写锁用）
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export function parseCursor(text: string): { date: string; index: number } {
  const m = CURSOR_RE.exec(text.trim());
  if (!m) throw new Error(`日志游标「${text}」不对，格式是 YYYY-MM-DD#N（memory-recall since:"last" 会给出）`);
  return { date: m[1], index: Number(m[2]) };
}

export const cursorOf = (e: { date: string; index: number }) => `${e.date}#${e.index}`;

// 游标比较：先比日期，再比序号
export function cursorAfter(e: { date: string; index: number }, c: { date: string; index: number }): boolean {
  return e.date > c.date || (e.date === c.date && e.index > c.index);
}

export interface RecallHit {
  source: string;
  date: string | null;
  line: string;
}

export interface RecallOptions {
  query?: string;
  since?: string;
  until?: string;
  limit?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const oneLine = (s: string, max = LINE_MAX) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const JOURNAL_LINE_RE = /^- (\d{2}):(\d{2}) /;

// 解析 since/until：YYYY-MM-DD、YYYY-MM-DD HH:MM，或 ISO 时间
export function parseWhen(text: string, endOfDay = false): number {
  const t = text.trim();
  if (DATE_RE.test(t)) {
    const [y, m, d] = t.split('-').map(Number);
    return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(t);
  if (local) {
    const [, y, m, d, hh, mm] = local.map(Number);
    return new Date(y, m - 1, d, hh, mm).getTime();
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new Error(`看不懂时间「${text}」，用 YYYY-MM-DD 或 YYYY-MM-DD HH:MM`);
  return ms;
}

export class MemoryStore {
  readonly agentDir: string;
  readonly sharedDir: string;
  readonly journalDir: string;

  constructor(
    readonly rootDir: string,
    readonly agent: string,
    // 备份目录（runtime 下），不进 git
    private readonly backupDir: string,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!/^[a-z0-9_-]+$/i.test(agent)) throw new Error(`记忆目录名只能用英文、数字、下划线：${agent}`);
    this.agentDir = path.join(rootDir, agent);
    this.sharedDir = path.join(rootDir, 'shared');
    this.journalDir = path.join(this.agentDir, 'journal');
  }

  sectionFile(section: WritableSection | 'persona'): string {
    if (section === 'world') return path.join(this.sharedDir, 'world.md');
    return path.join(this.agentDir, `${section}.md`);
  }

  playerFile(name: string): string {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(`玩家名不对：${name}`);
    return path.join(this.sharedDir, 'players', `${name}.md`);
  }

  private stateFile(): string {
    return path.join(this.agentDir, 'state.json');
  }

  private read(file: string): string {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  readState(): MemoryState {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
      const through = typeof s.through === 'string' && CURSOR_RE.test(s.through) ? s.through : null;
      return { consolidatedAt: Number(s.consolidatedAt) || 0, through };
    } catch {
      return { consolidatedAt: 0, through: null };
    }
  }

  // 简单的跨进程写锁（交互会话和托管会话可能各开一个 MCP 服务端）：独占创建锁文件，超时或锁太旧就接管
  private withLock<T>(name: string, fn: () => T): T {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const lock = path.join(this.rootDir, `.${name}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let stale = false;
        try {
          stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
        } catch {
          continue;
        }
        if (stale || Date.now() > deadline) {
          fs.rmSync(lock, { force: true });
          continue;
        }
        Atomics.wait(SLEEP_CELL, 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  private writeState(state: MemoryState): void {
    fs.mkdirSync(this.agentDir, { recursive: true });
    const tmp = `${this.stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
    try {
      fs.renameSync(tmp, this.stateFile());
    } catch {
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(this.stateFile(), JSON.stringify(state) + '\n');
    }
  }

  // 往今天的日志追加一行。程序自动记的事件和 memory-note 都走这里
  append(text: string, at: Date = this.now()): string {
    const line = `- ${localTime(at)} ${oneLine(text)}`;
    const file = path.join(this.journalDir, `${localDate(at)}.md`);
    fs.mkdirSync(this.journalDir, { recursive: true });
    // 独占创建：两个进程同时写新的一天时，不会有一个把另一个刚写的内容覆盖掉
    try {
      fs.writeFileSync(file, `# ${localDate(at)}\n\n`, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    fs.appendFileSync(file, line + '\n');
    return line;
  }

  note(text: string, tags: string[] = []): string {
    const body = text.trim();
    if (!body) throw new Error('要记的内容是空的');
    if (body.length > NOTE_MAX) throw new Error(`一条最多 ${NOTE_MAX} 字，拆开记或者写短一点`);
    const tagText = tags.map((t) => ` #${t}`).join('');
    return this.append(`[记] ${body}${tagText}`);
  }

  // 整段替换 digest / goals / bonds / world；旧内容先备份。
  // through：整理的最后一步带上，表示日志已经整理到这个游标（只确认读过的部分，之后新来的日志还算没整理）
  write(section: WritableSection, content: string, through?: string): { file: string; backup: string | null; chars: number; through: string | null } {
    const text = content.trim();
    const limit = SECTION_LIMITS[section];
    if (text.length > limit) {
      throw new Error(`${SECTION_TITLES[section]}最多 ${limit} 字，现在 ${text.length} 字。先合并、删掉过时的再写`);
    }
    const target = through === undefined ? null : this.checkThrough(through);
    return this.withLock('write', () => {
      const file = this.sectionFile(section);
      const old = this.read(file);
      let backup: string | null = null;
      if (old.trim()) backup = this.backup(section, old);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text + '\n');
      if (target) this.writeState({ consolidatedAt: this.now().getTime(), through: cursorOf(target) });
      return { file, backup, chars: text.length, through: target ? cursorOf(target) : null };
    });
  }

  // through 必须指向一条存在的日志，而且不能比上次整理到的位置早
  private checkThrough(through: string): { date: string; index: number } {
    const c = parseCursor(through);
    const count = this.entriesOf(c.date).length;
    if (c.index < 1 || c.index > count) throw new Error(`日志里没有 ${through}（${c.date} 一共 ${count} 条）`);
    const prev = this.readState().through;
    if (prev && cursorAfter(parseCursor(prev), c)) throw new Error(`上次已经整理到 ${prev}，through 不能往回退`);
    return c;
  }

  private backup(section: WritableSection, text: string): string {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const d = this.now();
    const stamp = `${localDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${d.getMilliseconds()}`;
    const prefix = `${this.agent}-${section}-`;
    const file = path.join(this.backupDir, `${prefix}${stamp}.md`);
    fs.writeFileSync(file, text);
    const old = fs.readdirSync(this.backupDir).filter((f) => f.startsWith(prefix)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) {
      fs.rmSync(path.join(this.backupDir, f), { force: true });
    }
    return file;
  }

  private journalDates(): string[] {
    try {
      return fs.readdirSync(this.journalDir)
        .filter((f) => DATE_RE.test(f.replace(/\.md$/, '')) && f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  // 某一天的全部日志条目（按写入顺序编号）
  private entriesOf(date: string): JournalEntry[] {
    const [y, m, d] = date.split('-').map(Number);
    const out: JournalEntry[] = [];
    for (const line of this.read(path.join(this.journalDir, `${date}.md`)).split(/\r?\n/)) {
      const hit = JOURNAL_LINE_RE.exec(line);
      if (!hit) continue;
      out.push({ date, index: out.length + 1, at: new Date(y, m - 1, d, Number(hit[1]), Number(hit[2])).getTime(), line });
    }
    return out;
  }

  // 某段时间内的日志（按时间顺序）
  journalLines(sinceMs = 0, untilMs = Infinity): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const date of this.journalDates()) {
      const [y, m, d] = date.split('-').map(Number);
      const dayStart = new Date(y, m - 1, d).getTime();
      if (dayStart + 86_400_000 <= sinceMs || dayStart > untilMs) continue;
      for (const e of this.entriesOf(date)) {
        // 日志只精确到分钟：那一分钟里的也算进来，宁可重复不要漏
        if (e.at + 60_000 <= sinceMs || e.at > untilMs) continue;
        out.push(e);
      }
    }
    return out;
  }

  // 上次整理之后的日志。有游标按游标算（精确）；旧格式只有时间，按时间算
  unconsolidated(): JournalEntry[] {
    const state = this.readState();
    if (!state.through) return this.journalLines(state.consolidatedAt);
    const c = parseCursor(state.through);
    const out: JournalEntry[] = [];
    for (const date of this.journalDates()) {
      if (date < c.date) continue;
      for (const e of this.entriesOf(date)) if (cursorAfter(e, c)) out.push(e);
    }
    return out;
  }

  // 整理用：按顺序一页页读没整理的日志。after 是上一页给的游标
  pendingPage(opts: { after?: string; limit?: number } = {}): { entries: JournalEntry[]; total: number; remaining: number; lastCursor: string | null } {
    let all = this.unconsolidated();
    if (opts.after) {
      const a = parseCursor(opts.after);
      all = all.filter((e) => cursorAfter(e, a));
    }
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), PENDING_PAGE_MAX);
    const entries = all.slice(0, limit);
    const last = entries.at(-1);
    return { entries, total: all.length, remaining: all.length - entries.length, lastCursor: last ? cursorOf(last) : null };
  }

  // 开局上下文。stable：连人设、回忆、主人的档案一起给（没有文件导入机制的 harness 用）
  context(opts: { stable?: boolean; owners?: string[] } = {}): string {
    const now = this.now();
    const parts: string[] = [`【记忆】${localDate(now)} ${localTime(now)}`];
    const section = (title: string, file: string, body: string) => {
      const text = body.trim();
      parts.push(`## ${title}（${path.relative(this.rootDir, file).replace(/\\/g, '/')}）\n${text || '（空）'}`);
    };
    if (opts.stable) {
      section('人设', this.sectionFile('persona'), this.read(this.sectionFile('persona')));
      for (const owner of opts.owners ?? []) {
        try {
          const f = this.playerFile(owner);
          section(`${owner} 的档案`, f, this.read(f));
        } catch {
          // 名字不合法就跳过
        }
      }
      section(SECTION_TITLES.bonds, this.sectionFile('bonds'), this.read(this.sectionFile('bonds')));
    }
    for (const s of ['world', 'goals', 'digest'] as const) {
      section(SECTION_TITLES[s], this.sectionFile(s), this.read(this.sectionFile(s)));
    }
    const state = this.readState();
    const pending = this.unconsolidated();
    const since = state.consolidatedAt
      ? `上次整理 ${localDate(new Date(state.consolidatedAt))} ${localTime(new Date(state.consolidatedAt))}${state.through ? `，整理到 ${state.through}` : ''}`
      : '还没整理过';
    if (pending.length) {
      const shown = pending.slice(-CONTEXT_JOURNAL_LINES);
      const head = pending.length > shown.length ? `共 ${pending.length} 条，这里是最后 ${shown.length} 条；要看全部用 memory-recall since:"last"` : `共 ${pending.length} 条`;
      let lastDate = '';
      const lines = shown.map((l) => {
        const prefix = l.date !== lastDate ? `${l.date}\n` : '';
        lastDate = l.date;
        return prefix + l.line;
      });
      parts.push(`## 还没整理的日志（${since}，${head}）\n${lines.join('\n')}`);
    } else {
      parts.push(`## 还没整理的日志（${since}）\n（没有）`);
    }
    const others = this.playerNames().filter((n) => !(opts.owners ?? []).includes(n));
    if (others.length) parts.push(`## 其他玩家档案\n${others.join('、')}（在 shared/players/ 下，需要时用 memory-recall 查）`);
    return parts.join('\n\n');
  }

  playerNames(): string[] {
    try {
      return fs.readdirSync(path.join(this.sharedDir, 'players')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
    } catch {
      return [];
    }
  }

  // 按关键词（空格分开，全部都要出现）和时间查日志、回忆、摘要、世界现状、玩家档案。新的在前
  recall(opts: RecallOptions): { hits: RecallHit[]; total: number } {
    const terms = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
    const last = opts.since?.trim() === 'last';
    const sinceMs = opts.since === undefined || last ? 0 : parseWhen(opts.since);
    const untilMs = opts.until === undefined ? Infinity : parseWhen(opts.until, true);
    if (!terms.length && opts.since === undefined && opts.until === undefined) {
      throw new Error('至少给一个关键词或时间范围');
    }
    const match = (line: string) => terms.every((t) => line.toLowerCase().includes(t));
    const hits: RecallHit[] = [];
    const source = last ? this.unconsolidated().filter((e) => e.at <= untilMs) : this.journalLines(sinceMs, untilMs);
    const journal = source.filter((l) => match(l.line)).reverse();
    for (const l of journal) hits.push({ source: `journal/${l.date}.md`, date: l.date, line: l.line });
    // 时间范围只对日志有意义；只按时间查时不翻其他文件
    if (terms.length && opts.since === undefined && opts.until === undefined) {
      const files: Array<[string, string]> = [
        ['bonds.md', this.sectionFile('bonds')],
        ['digest.md', this.sectionFile('digest')],
        ['goals.md', this.sectionFile('goals')],
        ['shared/world.md', this.sectionFile('world')],
        ...this.playerNames().map((n): [string, string] => [`shared/players/${n}.md`, this.playerFile(n)])
      ];
      for (const [source, file] of files) {
        for (const line of this.read(file).split('\n')) {
          if (line.trim() && match(line)) {
            const date = /(\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? null;
            hits.push({ source, date, line: line.trim() });
          }
        }
      }
    }
    return { hits: hits.slice(0, limit), total: hits.length };
  }
}

// 哪些游戏事件自动写进日志，以及写成什么样。其余（hurt、time、reflex、hostile……）太碎，不记；
// presence 也不记：每个开着 MCP 的会话（包括开发会话）启动时都会发一条「不在线」
const JOURNAL_LABELS: Record<string, string> = {
  chat: '',
  whisper: '[悄悄话] ',
  death: '[我死了] ',
  player_death: '[有人死了] ',
  advancement: '[成就] ',
  player_joined: '[上线] ',
  player_left: '[下线] ',
  player_sleep: '[有人睡觉] ',
  sleep: '[我睡觉] ',
  teleport: '[被传送] ',
  task: '[任务] ',
  spawn: '[进服] ',
  danger: '[危险] '
};

export function journalLineFor(type: string, text: string, worldId = ''): string | null {
  const label = JOURNAL_LABELS[type];
  if (label === undefined) return null;
  let body = text;
  if (type === 'spawn' && worldId) body = `${worldId}，${text}`;
  if (type === 'task') body = oneLine(text, 120);
  return `${label}${body}`;
}
