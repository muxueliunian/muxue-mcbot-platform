// 极简 RCON 客户端：node scripts/rcon.mjs "<命令>" ["<命令>" ...]
// 连本机服务器，端口和密码从 server/server.properties 读；换目录用环境变量 MC_SERVER_DIR。
// 例：node scripts/rcon.mjs "ysm model reload" 'ysm model set Claude "wine_fox/13_matured" - true'
// 也可以被 import：import { rcon, tellrawCommand } from './rcon.mjs'
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SERVER_DIR = fileURLToPath(new URL('../server/', import.meta.url));

export function readServerProps(serverDir = process.env.MC_SERVER_DIR || DEFAULT_SERVER_DIR) {
  const text = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

const pkt = (id, type, body) => {
  const b = Buffer.from(body, 'utf8');
  const p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12);
  return p;
};

// 依次执行命令，返回每条命令的回复；连不上、认证失败、超时都会 reject
export function rcon(cmds, { serverDir, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let props;
    try {
      props = readServerProps(serverDir);
    } catch (e) {
      reject(new Error(`读不到 server.properties：${e.message}`));
      return;
    }
    const replies = [];
    let buf = Buffer.alloc(0);
    let next = 0;
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      if (err) reject(err); else resolve(replies);
    };
    const s = net.connect(+props['rcon.port'], '127.0.0.1');
    const timer = setTimeout(() => done(new Error('RCON 超时')), timeoutMs);
    s.on('connect', () => s.write(pkt(1, 3, props['rcon.password'] ?? '')));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0), id = buf.readInt32LE(4), body = buf.toString('utf8', 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (id === -1) { done(new Error('RCON auth failed')); return; }
        if (next > 0) replies.push(body);
        if (next < cmds.length) { s.write(pkt(100 + next, 2, cmds[next])); next++; } else { done(); return; }
      }
    });
    s.on('error', (e) => done(e));
    s.on('close', () => done(new Error('RCON 连接被关闭')));
  });
}

// 生成一条 tellraw 命令；非 ASCII 字符转成 \uXXXX，RCON 里只传 ASCII，不受编码影响
export function tellrawCommand(text, { color = 'gray', target = '@a' } = {}) {
  const json = JSON.stringify({ text, color }).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `tellraw ${target} ${json}`;
}

// 命令行用法（行为和以前一样）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cmds = process.argv.slice(2);
  rcon(cmds).then((replies) => {
    replies.forEach((body, i) => console.log(`> ${cmds[i]}\n${body}`));
  }, (e) => {
    console.log(/auth failed/.test(e.message) ? 'RCON auth failed' : `RCON error ${e.message}`);
    process.exit(1);
  });
}
