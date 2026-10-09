// WebUI 的「连接配置」和「灵魂设置」用到的本机文件：
// - 找本机的游戏目录（Prism/ElyPrism/MultiMC 实例、.minecraft 和它的版本隔离目录、用户手动加的服务器或实例目录），
//   看核心模组装没装、连接文件在不在、世界开着没有；用户点选后连接文件路径自动填好，不用自己找。
// - 改 Bot 的游戏名：写游戏目录里 config/mcbot-server-control/server.json 的 username（模组启动世界时读，退出重进才生效）。
// - 人设：读写托管时会带上的 persona.md（位置和 scripts/companion.mjs 的 resolveMemory 一致）。
// - YSM 模型的显示名：读 config/yes_steve_model/custom/<模型>/ysm.json 的 metadata.name。
// 连接文件里的令牌只用来问一次 hello，不返回给网页。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentProtocol } from './agents/process-protocols.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const EXTRA_FILE = 'webui-games.json';
const CONTROL_DIR = path.join('config', 'mcbot-server-control');
const MODEL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const PERSONA_MAX = 8000;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const subdirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };

/** 连接文件在游戏目录里的位置。 */
export const connectionFileOf = (dir) => path.join(dir, CONTROL_DIR, 'connection.json');
/** 反过来：连接文件 → 游戏目录（不是标准位置就返回空串）。 */
export function gameDirOf(connectionFile) {
  const p = path.normalize(connectionFile || '');
  const tail = path.join(CONTROL_DIR, 'connection.json');
  return p.toLowerCase().endsWith(path.sep + tail.toLowerCase()) ? p.slice(0, p.length - tail.length - 1) : '';
}

/** Prism 系的实例名在 instance.cfg 的 name= 行。 */
function instanceName(instDir) {
  try { const m = /^name=(.+)$/m.exec(fs.readFileSync(path.join(instDir, 'instance.cfg'), 'utf8')); if (m) return m[1].trim(); } catch { /* 用文件夹名 */ }
  return path.basename(instDir);
}

/** 一个目录可能是游戏目录本身，也可能是带 versions 的 .minecraft（HMCL、PCL 的版本隔离）。 */
function expand(dir, kind, name) {
  const out = [];
  if (isDir(path.join(dir, 'mods')) || fs.existsSync(path.join(dir, 'server.properties')) || isDir(path.join(dir, CONTROL_DIR)))
    out.push({ dir, kind: fs.existsSync(path.join(dir, 'server.properties')) ? '服务器' : kind, name });
  for (const v of subdirs(path.join(dir, 'versions'))) {
    const vd = path.join(dir, 'versions', v);
    if (isDir(path.join(vd, 'mods'))) out.push({ dir: vd, kind: kind + '（版本隔离）', name: v });
  }
  return out;
}

/** 本机常见位置里的游戏目录，加上用户手动加的。只看文件夹在不在，不读存档。 */
export function findGames(runtime, env = process.env) {
  const found = [];
  const appdata = env.APPDATA || '';
  if (appdata) {
    for (const [folder, kind] of [['PrismLauncher', 'Prism'], ['ElyPrismLauncher', 'ElyPrism'], ['MultiMC', 'MultiMC'], ['PolyMC', 'PolyMC']]) {
      const root = path.join(appdata, folder, 'instances');
      for (const inst of subdirs(root)) {
        const instDir = path.join(root, inst);
        const game = ['minecraft', '.minecraft'].map((n) => path.join(instDir, n)).find(isDir);
        if (game) found.push(...expand(game, kind, instanceName(instDir)));
      }
    }
    found.push(...expand(path.join(appdata, '.minecraft'), '.minecraft', '.minecraft'));
  }
  for (const dir of loadExtraDirs(runtime)) found.push(...expand(dir, '手动添加', path.basename(dir)).map((g) => ({ ...g, manual: true })));
  const seen = new Set();
  return found.filter((g) => { const k = path.normalize(g.dir).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export function loadExtraDirs(runtime) {
  const data = readJson(path.join(runtime, EXTRA_FILE));
  return Array.isArray(data?.dirs) ? data.dirs.filter((d) => typeof d === 'string' && path.isAbsolute(d)) : [];
}
function writeExtraDirs(runtime, dirs) {
  fs.mkdirSync(runtime, { recursive: true });
  const file = path.join(runtime, EXTRA_FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, dirs }, null, 2)); fs.renameSync(tmp, file);
}
/** 手动加一个目录：服务器目录、启动器实例的游戏目录，或带 versions 的 .minecraft。 */
export function addGameDir(runtime, input) {
  const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw || /[\u0000-\u001f]/.test(raw) || raw.length > 400) return { ok: false, error: '目录格式不对' };
  const dir = path.normalize(raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw);
  if (!path.isAbsolute(dir)) return { ok: false, error: '要填完整路径' };
  if (!isDir(dir)) return { ok: false, error: '这个目录不存在' };
  if (!expand(dir, '手动添加', path.basename(dir)).length) return { ok: false, error: '这里看不出是游戏目录：没有 mods 文件夹、server.properties 或 versions 里的游戏' };
  const dirs = loadExtraDirs(runtime);
  if (!dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) writeExtraDirs(runtime, [...dirs, dir]);
  return { ok: true, dir };
}
export function removeGameDir(runtime, dir) {
  const dirs = loadExtraDirs(runtime), next = dirs.filter((d) => d.toLowerCase() !== String(dir).toLowerCase());
  if (next.length === dirs.length) return { ok: false, error: '不是手动添加的目录' };
  writeExtraDirs(runtime, next); return { ok: true };
}

/** 用来比对的核心 jar：绿色版在 mods/ 下，仓库里在构建目录。 */
export function referenceCoreJar(root = ROOT) {
  const jar = readJson(path.join(root, 'compat.json'))?.core?.jar;
  if (!jar) return '';
  return [path.join(root, 'mods', jar), path.join(root, 'mods', 'mcbot-server-control', 'build', 'libs', jar)].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}

/** 一个游戏目录的状态：核心模组、Bot 名、连接文件（不带令牌）。 */
export function inspectGame(game, refJar = referenceCoreJar()) {
  const mods = path.join(game.dir, 'mods');
  let jars = [];
  try { jars = fs.readdirSync(mods).filter((n) => /^mcbot-server-control-.*\.jar$/i.test(n)); } catch { /* 没有 mods */ }
  let core = jars.length ? 'ok' : 'missing';
  if (jars.length && refJar) {
    // 比实际字节：文件名一样的旧构建也能看出来
    try { if (!fs.readFileSync(path.join(mods, jars[0])).equals(fs.readFileSync(refJar))) core = 'different'; } catch { /* 读不了就不判断 */ }
  }
  const server = readJson(path.join(game.dir, CONTROL_DIR, 'server.json'));
  const conn = readJson(connectionFileOf(game.dir));
  const connOk = conn?.protocol === 2 && conn?.backend === 'server' && NAME_RE.test(conn?.username || '') && !!conn?.token;
  return {
    dir: game.dir, kind: game.kind, name: game.name, manual: !!game.manual,
    core, coreJar: jars[0] || '',
    username: (NAME_RE.test(server?.username || '') ? server.username : '') || (connOk ? conn.username : ''),
    nameConfigurable: !!server,
    connectionFile: connectionFileOf(game.dir), hasConnection: connOk, worldId: connOk ? String(conn.worldId || '') : '',
  };
}

/** 世界开着没有：用连接文件里的令牌问一次 hello（只看通不通）。 */
export async function gameOnline(connectionFile, fetchImpl = fetch, timeoutMs = 1200) {
  const c = readJson(connectionFile);
  if (!c?.endpoint || !c?.token) return false;
  try {
    const url = new URL(c.endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) return false;
    const r = await fetchImpl(c.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
    const v = await r.json();
    return r.ok && v?.ok === true;
  } catch { return false; }
}

/** 列出所有游戏目录和状态；有连接文件的并发问一下世界开着没有。核心模组没装的排后面。 */
export async function listGames(runtime, { env = process.env, fetchImpl = fetch, refJar = referenceCoreJar() } = {}) {
  const games = findGames(runtime, env).map((g) => inspectGame(g, refJar));
  await Promise.all(games.map(async (g) => { g.online = g.hasConnection ? await gameOnline(g.connectionFile, fetchImpl) : false; }));
  const rank = (g) => (g.core === 'missing' ? 2 : 0) + (g.online ? 0 : 1);
  return games.sort((a, b) => rank(a) - rank(b));
}

/** 改 Bot 的游戏名：只改 server.json 的 username，其余字段原样保留；server.json 由模组第一次开世界时生成。 */
export function setBotName(dir, name) {
  if (!NAME_RE.test(String(name ?? ''))) return { ok: false, error: '游戏名只能用英文字母、数字和下划线，最多 16 个' };
  const file = path.join(String(dir), CONTROL_DIR, 'server.json');
  const data = readJson(file);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '这个目录还没有 server.json：装好核心模组后先进一次世界（单人要开局域网），再来改名' };
  if (data.username === name) return { ok: true, changed: false };
  data.username = name;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file);
  return { ok: true, changed: true };
}

/**
 * 世界没开、问不到服务器时，从游戏目录直接列 YSM 的自定义模型（文件夹和 .ysm 文件），写法和服务器 hello 给的一样。
 * 没装我们的 YSM 适配模组就不列（装了才能在托管时换上）。
 */
export function localAppearances(gameDir) {
  if (!gameDir) return [];
  let mods = [];
  try { mods = fs.readdirSync(path.join(gameDir, 'mods')); } catch { return []; }
  if (!mods.some((n) => /^mcbot-yes-steve-model-.*\.jar$/i.test(n))) return [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(gameDir, 'config', 'yes_steve_model', 'custom'), { withFileTypes: true }); } catch { return []; }
  const choices = entries.filter((e) => (e.isDirectory() || /\.ysm$/i.test(e.name)) && MODEL_RE.test(e.name)).map((e) => e.name).sort();
  return choices.length ? [{ id: 'yes_steve_model:model', choices }] : [];
}

/** YSM 模型的显示名：本机能读到模型文件夹就用 ysm.json 里的名字，否则用模型 id。 */
export function modelLabels(gameDir, choices) {
  const out = {};
  for (const c of choices) {
    if (!MODEL_RE.test(c) || c.includes('..')) continue;
    const meta = gameDir ? readJson(path.join(gameDir, 'config', 'yes_steve_model', 'custom', c, 'ysm.json'))?.metadata : null;
    const name = typeof meta?.name === 'string' ? meta.name.trim().slice(0, 80) : '';
    const authors = Array.isArray(meta?.authors) ? meta.authors.map((a) => a?.name).filter((n) => typeof n === 'string').slice(0, 3) : [];
    out[c] = { name: name || c.replace(/\.ysm$/i, ''), authors };
  }
  return out;
}

/**
 * 托管时带上的人设文件：和 companion.mjs 的 resolveMemory 一样。小克（Claude）用 <记忆目录>/xiaoke/persona.md，
 * 独立试玩身份（dsh、Codex）用 <记忆目录，默认 runtime/<agent>-memory>/<游戏名小写>/persona.md。
 */
export function personaFile({ agent, memoryDir = '', username = '' }, root = ROOT) {
  const protocol = getAgentProtocol(agent);
  if (protocol.identity === 'independent') {
    if (!NAME_RE.test(username)) throw new Error('先在「连接配置」选好游戏，读到 Bot 的游戏名才知道人设放哪');
    return path.join(memoryDir || path.join(root, 'runtime', `${agent}-memory`), username.toLowerCase(), 'persona.md');
  }
  return path.join(memoryDir || path.join(root, 'memory'), protocol.memoryAgent || 'xiaoke', 'persona.md');
}
export function readPersona(opts, root = ROOT) {
  let file;
  try { file = personaFile(opts, root); } catch (e) { return { ok: false, error: e.message }; }
  try { return { ok: true, file, exists: true, text: fs.readFileSync(file, 'utf8') }; }
  catch (e) { return e.code === 'ENOENT' ? { ok: true, file, exists: false, text: '' } : { ok: false, error: '人设文件读不了' }; }
}
export function writePersona(opts, text, root = ROOT) {
  if (typeof text !== 'string' || text.length > PERSONA_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { ok: false, error: `人设最多 ${PERSONA_MAX} 个字，不能有控制字符` };
  let file;
  try { file = personaFile(opts, root); } catch (e) { return { ok: false, error: e.message }; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text.replace(/\r\n/g, '\n')); fs.renameSync(tmp, file);
  return { ok: true, file };
}

/** 人设示例：给第一次用的人一个能直接改的起点。说话方式写在这里，而不是写死在系统指令里。 */
export const PERSONA_SAMPLE = `# 人设

- 名字：（在这里写它叫什么，比如 小鲸）
- 身份：玩家的 Minecraft 伙伴，像关系很好的朋友。
- 性格：温和、容易开心，做事稳；关心玩家但不肉麻。

## 说话方式
- 像真人在游戏里打字聊天：简体中文，一次一两句短句，可以只回"嗯""好呀""等我一下"。
- 对眼前的事即时反应："哇，好多煤""下雨了诶"。
- 不说客服腔：不用"收到""好的，我这就……""有什么需要随时叫我"，不复述对方的话、不列清单。
- 不把错误码、方块或物品 id、工具名、"接口""系统"这类词说给玩家，换成玩家听得懂的话，比如"这个椅子我还坐不了""只剩金苹果了，要吃吗"。
- 不报整份背包，只说跟眼前的事有关的。
- 做不到就直说，再给个别的办法。

## 做事
- 先确认再做大动作，不拆玩家的建筑。
- 有危险先护着玩家，打不过就撤。
`;
