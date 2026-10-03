#!/usr/bin/env node
// C 批次测试玩家：模拟真人在 25568 隔离服说话、走动，读取 ServerBot 的回应和收到的物品。
// 只是测试发言者，不是 Body；不执行命令、不自动重连、不接触控制口或模型凭据。
// 指令从 --commands 文件按行追加读取（便于后台运行），事件写入 --events JSONL。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const help = `node scripts/server-play-test-peer.mjs --commands <file> --events <file> [--username C2Tester]
Fixed 127.0.0.1:25568, offline, 1.21.1. Append one JSON object per line to the commands file:
  {"type":"chat","message":"小克，你在哪"}
  {"type":"walk","direction":"forward|back|left|right","ms":800}
  {"type":"look-at","username":"ServerBot"}
  {"type":"inventory"}
  {"type":"quit"}`;
const opts = { username: 'C2Tester' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i] === '--help') { console.log(help); process.exit(0); }
  if (!['--commands', '--events', '--username'].includes(argv[i]) || !argv[i + 1]) { console.error(help); process.exit(1); }
  opts[argv[i].slice(2)] = argv[i + 1];
}
if (!opts.commands || !opts.events || !/^[A-Za-z0-9_]{1,16}$/.test(opts.username)) { console.error(help); process.exit(1); }

const require = createRequire(new URL('../mcp-server/package.json', import.meta.url));
const mineflayer = require('mineflayer');
const emit = (type, fields = {}) => fs.appendFileSync(opts.events, `${JSON.stringify({ type, time: new Date().toISOString(), ...fields })}\n`);
if (!fs.existsSync(opts.commands)) fs.writeFileSync(opts.commands, '');
let offset = fs.statSync(opts.commands).size;
let ready = false, closing = false, walking;

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: opts.username, auth: 'offline', version: '1.21.1' });
const inventory = () => bot.inventory.items().map((i) => ({ slot: i.slot, name: i.name, count: i.count }));
const pos = () => bot.entity && { x: +bot.entity.position.x.toFixed(2), y: +bot.entity.position.y.toFixed(2), z: +bot.entity.position.z.toFixed(2) };

function quit(reason) {
  if (closing) return;
  closing = true;
  clearInterval(poll);
  bot.clearControlStates();
  emit('end', { reason, position: pos(), inventory: ready ? inventory() : [] });
  bot.quit(reason);
  setTimeout(() => process.exit(0), 2000).unref();
}

function handle(command) {
  if (command.type === 'quit') return quit('quit requested');
  if (!ready) return emit('error', { code: 'NOT_READY' });
  if (command.type === 'chat') {
    const m = command.message;
    if (typeof m !== 'string' || !m.trim() || m.length > 256 || m.trimStart().startsWith('/') || /[\x00-\x1f\x7f§]/.test(m)) return emit('error', { code: 'INVALID_CHAT' });
    bot.chat(m);
    return emit('sent', { message: m });
  }
  if (command.type === 'walk') {
    if (!['forward', 'back', 'left', 'right'].includes(command.direction) || !Number.isInteger(command.ms) || command.ms < 1 || command.ms > 3000) return emit('error', { code: 'INVALID_WALK' });
    clearTimeout(walking);
    bot.clearControlStates();
    bot.setControlState(command.direction, true);
    walking = setTimeout(() => { bot.clearControlStates(); emit('position', { reason: 'walk-finished', position: pos() }); }, command.ms);
    return;
  }
  if (command.type === 'look-at') {
    const target = bot.players[command.username]?.entity;
    if (!target) return emit('error', { code: 'NOT_VISIBLE', username: command.username });
    void bot.lookAt(target.position.offset(0, 1.6, 0), true).then(() => emit('looked', { username: command.username, at: pos() }));
    return;
  }
  if (command.type === 'inventory') return emit('inventory', { position: pos(), inventory: inventory() });
  emit('error', { code: 'UNKNOWN_COMMAND', command: command.type });
}

const poll = setInterval(() => {
  let size;
  try { size = fs.statSync(opts.commands).size; } catch { return; }
  if (size <= offset) return;
  const fd = fs.openSync(opts.commands, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const last = text.lastIndexOf('\n');
  if (last < 0) return;
  offset += Buffer.byteLength(text.slice(0, last + 1));
  for (const line of text.slice(0, last).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch (e) { emit('error', { code: 'BAD_LINE', message: e.message }); }
  }
}, 200);

bot.once('spawn', () => { ready = true; emit('spawn', { username: bot.username, position: pos(), inventory: inventory() }); });
bot.on('chat', (username, message) => emit('chat', { username, message }));
bot.on('playerCollect', (collector, collected) => {
  if (collector === bot.entity) setTimeout(() => emit('collected', { inventory: inventory() }), 300);
});
bot.on('error', (e) => { emit('error', { code: e.code ?? 'CLIENT_ERROR', message: e.message }); quit('client error'); });
bot.on('kicked', (r) => { emit('error', { code: 'KICKED', message: typeof r === 'string' ? r : JSON.stringify(r) }); quit('kicked'); });
bot.on('death', () => emit('died', { position: pos() }));
bot.on('end', () => { if (!closing) { closing = true; emit('end', { reason: 'connection ended' }); process.exit(0); } });
process.once('SIGINT', () => quit('interrupted'));
process.once('SIGTERM', () => quit('terminated'));
