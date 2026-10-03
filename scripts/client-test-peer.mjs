#!/usr/bin/env node
// Test fixture only: this peer uses the legacy package's Mineflayer to imitate a player.
// ClientBody and client-runtime retain no Mineflayer runtime dependency.
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const help = `Test-only peer: V1Tester, offline, Minecraft 1.21.1, fixed 127.0.0.1:25566.
Run: node scripts/client-test-peer.mjs
After the spawn JSONL event, write one JSON object per stdin line:
  {"type":"chat","message":"ClientBot，跟着我"}
  {"type":"walk","direction":"forward","ms":500}
  {"type":"stop"}
  {"type":"quit"}
Walk direction is forward/back relative to the peer's reported yaw. Maximum 1000 ms.
No commands, automatic tasks, reconnect, server control, or account credentials.
EOF/quit stops movement and disconnects. stdout contains JSONL events only.
`;
if (process.argv.length > 2) {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    process.stderr.write(help);
    process.exit(0);
  }
  process.stderr.write('No connection overrides accepted; use --help.\n');
  process.exit(1);
}

const require = createRequire(new URL('../mcp-server/package.json', import.meta.url));
const mineflayer = require('mineflayer');
const emit = (type, fields = {}) => process.stdout.write(`${JSON.stringify({ type, time: new Date().toISOString(), ...fields })}\n`);
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'V1Tester', auth: 'offline', version: '1.21.1' });
const input = createInterface({ input: process.stdin, terminal: false });
let ready = false;
let closing = false;
let ended = false;
let walking;
let forceClose;
let lastPosition;

function position(reason, force = false) {
  if (!bot.entity) return;
  const { x, y, z } = bot.entity.position;
  if (!force && lastPosition && Math.hypot(x - lastPosition.x, y - lastPosition.y, z - lastPosition.z) < 0.02) return;
  lastPosition = { x, y, z };
  emit('position', { reason, position: lastPosition, yaw: bot.entity.yaw, pitch: bot.entity.pitch });
}
function stop(reason) {
  clearTimeout(walking);
  walking = undefined;
  bot.clearControlStates();
  position(reason, true);
}
function finish(reason) {
  if (ended) return;
  ended = true;
  closing = true;
  ready = false;
  clearTimeout(startupTimeout);
  clearTimeout(forceClose);
  clearInterval(positionTimer);
  clearTimeout(walking);
  input.close();
  process.stdin.pause();
  emit('end', { reason: String(reason) });
}
function quit(reason) {
  if (closing) return;
  closing = true;
  ready = false;
  stop('quitting');
  bot.quit(reason);
  forceClose = setTimeout(() => {
    bot.end(reason);
    finish(reason);
  }, 3000);
  forceClose.unref();
}
function invalid(message) { emit('error', { code: 'INVALID_INPUT', message }); }

const startupTimeout = setTimeout(() => {
  emit('error', { code: 'SPAWN_TIMEOUT', message: 'No spawn after 20 seconds; not reconnecting' });
  process.exitCode = 1;
  quit('Fixture spawn timeout');
}, 20_000);
const positionTimer = setInterval(() => { if (ready) position('changed'); }, 2000);
positionTimer.unref();

bot.once('spawn', () => {
  clearTimeout(startupTimeout);
  if (closing) return;
  ready = true;
  emit('spawn', { username: bot.username, host: '127.0.0.1', port: 25566, fixture: true });
  position('spawn', true);
});
bot.on('chat', (username, message) => emit('chat', { username, message }));
bot.on('error', error => { emit('error', { code: error.code ?? 'CLIENT_ERROR', message: error.message }); process.exitCode = 1; quit('Fixture client error'); });
bot.on('kicked', reason => { emit('error', { code: 'KICKED', message: typeof reason === 'string' ? reason : JSON.stringify(reason) }); process.exitCode = 1; quit('Fixture kicked'); });
bot.once('death', () => { emit('error', { code: 'DIED', message: 'Fixture died; no automatic respawn or new task' }); process.exitCode = 1; quit('Fixture died'); });
bot.once('end', finish);
input.on('line', line => {
  if (closing) return;
  if (line.length > 4096) return invalid('JSONL line too long');
  let command;
  try { command = JSON.parse(line); } catch { return invalid('Expected one JSON object per line'); }
  if (!command || typeof command !== 'object' || Array.isArray(command)) return invalid('Expected a JSON object');
  if (command.type === 'quit') return quit('Fixture quit requested');
  if (command.type === 'stop') return stop('stop-requested');
  if (!ready) return invalid('Wait for the spawn event before sending chat or walking');
  if (command.type === 'chat') {
    const message = command.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 256 || message.trimStart().startsWith('/') || /[\x00-\x1f\x7f\u00a7]/.test(message)) return invalid('Chat must be one ordinary non-command message, at most 256 characters');
    bot.chat(message);
    return;
  }
  if (command.type === 'walk') {
    if (!['forward', 'back'].includes(command.direction) || !Number.isInteger(command.ms) || command.ms < 1 || command.ms > 1000) return invalid('walk requires forward/back and integer ms in 1..1000');
    if (walking) return invalid('Already walking; stop or wait before issuing another walk');
    bot.clearControlStates();
    position('walk-start', true);
    bot.setControlState(command.direction, true);
    walking = setTimeout(() => stop('walk-finished'), command.ms);
    return;
  }
  invalid('Supported command types: chat, walk, stop, quit');
});
input.once('close', () => quit('Fixture stdin closed'));
process.once('SIGINT', () => quit('Fixture interrupted'));
process.once('SIGTERM', () => quit('Fixture terminated'));
