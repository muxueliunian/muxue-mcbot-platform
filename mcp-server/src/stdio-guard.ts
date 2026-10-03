// stdout 只留给 MCP 协议。这个模块必须是入口文件的第一个 import：
// ESM 按顺序执行依赖，它会在其他模块（mineflayer 等）初始化之前接管 stdout。
// - 任何人写 process.stdout（console.log、第三方库、原生调试输出）都转到 stderr，不再按内容猜测是不是协议消息
// - 协议消息只通过 protocolStdout 写出，保留原始的回调和背压（drain）语义
// - console.error / console.warn 保持原样，本来就写 stderr
import process from 'node:process';
import type { Writable } from 'node:stream';

type WriteArgs = [chunk: unknown, encodingOrCallback?: unknown, callback?: unknown];

const stdout = process.stdout;
const originalWrite = stdout.write.bind(stdout) as (...args: WriteArgs) => boolean;
const stderrWrite = process.stderr.write.bind(process.stderr) as (...args: WriteArgs) => boolean;

stdout.write = function redirectedWrite(...args: WriteArgs): boolean {
  return stderrWrite(...args);
} as typeof stdout.write;

// 交给 StdioServerTransport 用的写出口：写入走原始 stdout，事件（drain/error）仍来自真实的 stdout
export const protocolStdout = new Proxy(stdout, {
  get(target, prop) {
    if (prop === 'write') return originalWrite;
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }
}) as Writable;
