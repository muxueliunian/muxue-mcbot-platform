import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rcon } from '../../scripts/rcon.mjs';

const packet = (id, type, body = '') => {
  const bytes = Buffer.from(body), value = Buffer.alloc(bytes.length + 14);
  value.writeInt32LE(bytes.length + 10, 0); value.writeInt32LE(id, 4); value.writeInt32LE(type, 8); bytes.copy(value, 12); return value;
};
async function fixture(t, respond = ({ body, reply }) => setTimeout(() => reply(`reply:${body}`), 25)) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcbot-rcon-'));
  const sockets = new Set(), commands = [];
  const stats = { activeCommands: 0, maximumCommands: 0 };
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0), pending = 0;
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); stats.activeCommands -= pending; });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const length = buffer.readInt32LE(0), id = buffer.readInt32LE(4), type = buffer.readInt32LE(8), body = buffer.toString('utf8', 12, length + 2);
        buffer = buffer.subarray(length + 4);
        if (type === 3) { socket.write(packet(id, 2)); continue; }
        commands.push(body); pending++; stats.activeCommands++; stats.maximumCommands = Math.max(stats.maximumCommands, stats.activeCommands);
        const reply = text => { pending--; stats.activeCommands--; socket.write(packet(id, 0, text)); };
        const reject = () => { pending--; stats.activeCommands--; socket.write(packet(-1, 2)); };
        respond({ socket, id, body, reply, reject, stats });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = `rcon.port=${port}\nrcon.password=tcp-fixture-only\n`;
  await fs.writeFile(path.join(dir, 'server.properties'), config);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, port, config, commands, stats };
}

test('same localhost port serializes concurrent calls, including two directories, and preserves each command reply', async t => {
  const f = await fixture(t, ({ body, reply }) => setTimeout(() => reply(`reply:${body}`), 25));
  const other = path.join(f.dir, 'same-endpoint'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'server.properties'), f.config);
  const results = await Promise.all([
    rcon(['alpha', 'beta'], { serverDir: f.dir }), rcon(['gamma'], { serverDir: other }), rcon(['delta', 'epsilon'], { serverDir: f.dir }),
  ]);
  assert.deepEqual(results, [['reply:alpha', 'reply:beta'], ['reply:gamma'], ['reply:delta', 'reply:epsilon']]);
  assert.equal(f.stats.maximumCommands, 1, 'same port must never execute two requests concurrently');
  // Remote TCP close callbacks can lag the already-completed request; measure command work, not TCP teardown.
  assert.deepEqual(f.commands, ['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
});

test('authentication failure rejects its caller without poisoning the same-port queue', async t => {
  const f = await fixture(t, ({ body, reply, reject }) => body === 'fail' ? reject() : reply(`reply:${body}`));
  const results = await Promise.allSettled([rcon(['fail'], { serverDir: f.dir }), rcon(['after-failure'], { serverDir: f.dir })]);
  assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /RCON auth failed/);
  assert.deepEqual(results[1], { status: 'fulfilled', value: ['reply:after-failure'] });
  assert.equal(f.stats.maximumCommands, 1);
});

test('timeout rejects only its request, closes its socket, and permits the next queued call', async t => {
  const f = await fixture(t, ({ body, reply }) => { if (body !== 'no-reply') reply(`reply:${body}`); });
  const results = await Promise.allSettled([rcon(['no-reply'], { serverDir: f.dir, timeoutMs: 35 }), rcon(['after-timeout'], { serverDir: f.dir, timeoutMs: 150 })]);
  assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /RCON 超时/);
  assert.deepEqual(results[1], { status: 'fulfilled', value: ['reply:after-timeout'] });
  assert.equal(f.stats.maximumCommands, 1);
});

test('queued waiting does not consume the existing per-connection timeout budget', async t => {
  const f = await fixture(t, ({ body, reply }) => setTimeout(() => reply(`reply:${body}`), body === 'slow-first' ? 100 : 10));
  const results = await Promise.all([rcon(['slow-first'], { serverDir: f.dir, timeoutMs: 500 }), rcon(['short-budget'], { serverDir: f.dir, timeoutMs: 60 })]);
  assert.deepEqual(results, [['reply:slow-first'], ['reply:short-budget']]);
  assert.equal(f.stats.maximumCommands, 1);
});

test('different localhost ports run concurrently instead of sharing a global queue', async t => {
  const arrivals = [];
  const respond = ({ body, reply }) => { arrivals.push(() => reply(`reply:${body}`)); if (arrivals.length === 2) for (const send of arrivals) send(); };
  const a = await fixture(t, respond), b = await fixture(t, respond);
  const results = await Promise.all([rcon(['port-a'], { serverDir: a.dir, timeoutMs: 500 }), rcon(['port-b'], { serverDir: b.dir, timeoutMs: 500 })]);
  assert.deepEqual(results, [['reply:port-a'], ['reply:port-b']]);
});
