// 游戏是否在运行：WebUI 的插件安装和卸载前都要问一次（列表和安装任务共用这一份）。
// - 世界开着：控制模组的连接文件能问通 hello（gameOnline，由调用方传入）。
// - 进程：游戏还在启动、加载模组或停在主菜单时连接文件还不存在，所以再看 Windows 上有没有
//   java/javaw 进程的命令行带着这个游戏目录（启动器传 --gameDir；服务器没有这个参数，就看命令行里是否出现完整目录）。
// - 查不了进程（pwsh 和 powershell.exe 都不能用、超时、输出不是 JSON）时状态是 unknown，调用方按「可能还在运行」处理，不当作没在运行。
import { execFile } from 'node:child_process';

/** 比较用的目录写法：去掉引号和结尾斜杠，统一斜杠，小写（Windows 路径不分大小写）。 */
export const normalizeDir = (p) => String(p ?? '').trim().replace(/^"+|"+$/g, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 命令行里 --gameDir 的值（带引号按引号取；不带引号取到下一个 --参数或结尾）；没有这个参数返回 null。 */
export function gameDirArg(cmd) {
  const m = /--gamedir(?:=|\s+)(?:"([^"]*)"|(.*?)(?=\s+--|\s*$))/i.exec(String(cmd ?? ''));
  if (!m) return null;
  return m[1] !== undefined ? m[1] : (m[2] ?? '');
}

/** 这条进程命令行是不是在跑这个游戏目录。有 --gameDir 就只认它；没有（服务器）就找完整目录，后面是空白、引号、斜杠或结尾。 */
export function commandLineUsesDir(cmd, gameDir) {
  const target = normalizeDir(gameDir);
  if (!target || !cmd) return false;
  const arg = gameDirArg(cmd);
  if (arg !== null) return normalizeDir(arg) === target;
  const text = String(cmd).replace(/\\/g, '/').toLowerCase();
  for (let i = text.indexOf(target); i >= 0; i = text.indexOf(target, i + 1)) {
    const after = text.charAt(i + target.length);
    if (after === '' || /[\s"/]/.test(after)) return true;
  }
  return false;
}

// 输出按 UTF-8：控制台默认是系统代码页（中文系统是 GBK），带中文的游戏目录会被 Node 读成乱码而对不上。
const PS_LIST = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('javaw.exe','java.exe') } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";

/** 列出 java/javaw 进程（pid 和命令行）。先用 pwsh；没装 PowerShell 7 的电脑（Windows 自带的只有 5.1）用 powershell.exe；都查不了就 reject。 */
export async function javaProcesses({ timeoutMs = 8000, shells = ['pwsh', 'powershell.exe'] } = {}) {
  let last;
  for (const shell of shells) {
    try { return await listWith(shell, timeoutMs); } catch (e) { last = e; }
  }
  throw last || new Error('无法查询进程列表');
}

function listWith(shell, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(new Error('无法查询进程列表'));
      const text = String(stdout ?? '').trim();
      if (!text) return resolve([]);
      let v;
      try { v = JSON.parse(text); } catch { return reject(new Error('无法解析进程列表')); }
      resolve((Array.isArray(v) ? v : [v]).filter(Boolean).map((x) => ({ pid: x.ProcessId, commandLine: x.CommandLine || '' })));
    });
  });
}

/**
 * 游戏状态：world（世界开着）、process（有进程在跑这个目录）、unknown（查不了进程，世界也没开）、off（没在运行）。
 * online(dir) → 世界开着吗（调用方传 gameOnline 的包装）；listProcesses() → 进程列表（测试时替换）。
 */
export async function gameRunState(gameDir, { online = async () => false, listProcesses = javaProcesses } = {}) {
  if (await online(gameDir)) return { state: 'world' };
  let procs;
  try { procs = await listProcesses(); }
  catch (e) { return { state: 'unknown', error: e?.message || String(e) }; }
  if (procs.some((p) => commandLineUsesDir(p.commandLine, gameDir))) return { state: 'process' };
  return { state: 'off' };
}

/** 状态对应的提示（网页和安装接口共用）；off 返回空字符串。 */
export function runMessage(state, type = '') {
  const server = type === 'server';
  if (state === 'world') return server ? '服务器运行中：请先关闭服务器再操作' : '世界运行中：请先退出世界并关闭游戏再操作';
  if (state === 'process') return server ? '服务器运行中：请先关闭服务器再操作' : '游戏运行中：请先关闭游戏再操作';
  if (state === 'unknown') return server ? '无法确认服务器是否已关闭：请先关闭服务器后再操作' : '无法确认游戏是否已关闭：请先关闭游戏后再操作';
  return '';
}
