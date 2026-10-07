#!/usr/bin/env node
// Real v2 control-chain test. No model invocation, no Bot protocol client, no RCON actions.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--help') { console.log('node scripts/server-body-control-smoke.mjs --connection-file <v2 JSON> --output <evidence JSON>'); process.exit(0); }
  assert(['--connection-file', '--output'].includes(args[i]) && args[i + 1], 'Expected --connection-file and --output');
  opt[args[i].slice(2)] = args[i + 1];
}
assert(opt['connection-file'] && opt.output, 'Connection and evidence file required');
const connection = JSON.parse(await readFile(resolve(opt['connection-file']), 'utf8'));
assert.equal(connection.protocol, 2); assert.equal(connection.backend, 'server');
const url = new URL(connection.endpoint);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/v2'); assert.equal(url.port, '8766');
const evidence = { started: new Date().toISOString(), protocol: 2, checks: [], cleanup: [], boundary: 'Only v2 HTTP controls Claude; no RCON movement or model' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const position = state => ({ x: state.position.x, y: state.position.y, z: state.position.z });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
let lease, scope, hello;
function check(name, truth, detail) { evidence.checks.push({ name, passed: !!truth, ...(detail === undefined ? {} : { detail }) }); assert(truth, name); console.log(`PASS ${name}`); }
async function wire(method, params = {}, headers = {}) {
  const response = await fetch(connection.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}`, ...headers }, body: JSON.stringify({ method, params }) });
  const body = await response.json();
  return { status: response.status, ...body };
}
async function rpc(method, params = {}) {
  const reply = await wire(method, params);
  if (!reply.ok) throw Object.assign(new Error(`${method}: ${reply.error?.code}: ${reply.error?.message}`), { code: reply.error?.code });
  return reply.result;
}
async function refuses(name, method, params, codes) {
  const reply = await wire(method, params);
  check(name, !reply.ok && codes.includes(reply.error?.code), { code: reply.error?.code });
}
async function claim() {
  const controllerId = randomUUID();
  lease = await rpc('claim', { instanceId: hello.instanceId, worldId: connection.worldId, username: connection.username, controllerId });
  scope = { instanceId: lease.instanceId, sessionId: lease.sessionId, leaseId: lease.leaseId };
  return controllerId;
}
const observe = () => rpc('observe', scope);
const heartbeat = () => rpc('heartbeat', scope);
async function act(name, args, id = randomUUID(), generation = lease.controlGeneration) {
  return rpc('act', { ...scope, controlGeneration: generation, operationId: id, name, args });
}
async function release() { if (scope) await rpc('release', scope); lease = scope = undefined; }
async function stable(name) {
  await wait(650); const a = position(await observe()); await wait(700); const b = position(await observe());
  check(name, distance(a, b) < 0.03, { a, b }); return b;
}
try {
  const denied = await wire('hello', {}, { authorization: 'Bearer invalid-test-token' });
  check('unauthenticated caller rejected', denied.status === 403 && !denied.ok);
  const origin = await wire('hello', {}, { origin: 'http://localhost' });
  check('browser origin rejected', origin.status === 403 && !origin.ok);
  hello = await rpc('hello');
  check('server v2 identity matches selected connection', hello.protocol === 2 && hello.backend === 'server' && hello.worldId === connection.worldId && hello.username === connection.username);
  const wrong = { instanceId: hello.instanceId, worldId: connection.worldId, username: connection.username, controllerId: randomUUID() };
  await refuses('wrong world cannot claim', 'claim', { ...wrong, worldId: `${connection.worldId}-wrong` }, ['WRONG_WORLD']);
  await refuses('wrong player cannot claim', 'claim', { ...wrong, username: 'NotThisBot' }, ['WRONG_PLAYER']);
  await refuses('wrong service instance cannot claim', 'claim', { ...wrong, instanceId: randomUUID() }, ['WRONG_INSTANCE']);
  const controllerId = await claim();
  const duplicateClaim = await rpc('claim', { ...wrong, controllerId });
  check('same controller claim returns original lease', duplicateClaim.leaseId === lease.leaseId && duplicateClaim.controlGeneration === lease.controlGeneration);
  await refuses('second controller cannot take over', 'claim', { ...wrong, controllerId: randomUUID() }, ['LEASE_BUSY']);
  const initial = await observe();
  evidence.initial = { ...position(initial), sessionId: initial.sessionId, source: initial.source };
  check('authoritative observation and connected role', initial.connected && initial.source === 'server-observed' && initial.sessionId === lease.sessionId && initial.container === null);
  const ground = { x: Math.floor(initial.position.x), y: Math.floor(initial.position.y) - 1, z: Math.floor(initial.position.z) };
  const loadStarted = performance.now(); let groundState;
  do {
    groundState = (await rpc('observe', { ...scope, block: ground })).block;
    if (groundState?.state === 'loaded') break;
    await wait(100);
  } while (performance.now() - loadStarted < 5000);
  check('role loads its own chunk without external observer or forceload', groundState?.state === 'loaded', { groundState, waitMs: performance.now() - loadStarted });
  await wait(150); // Let normal physical ticks settle after asynchronous chunk loading.
  const message = `A-smoke-${randomUUID().slice(0, 8)}`, chatId = randomUUID();
  const chatted = await act('send-chat', { message }, chatId);
  const replay = await act('send-chat', { message }, chatId);
  check('duplicate operation returns original result', replay.operationId === chatted.operationId && replay.status === chatted.status);
  const afterChat = await observe();
  check('same action ID emits one chat line', afterChat.chat.filter(line => line.username === connection.username && line.message === message).length === 1);
  await refuses('same ID different arguments rejected', 'act', { ...scope, controlGeneration: lease.controlGeneration, operationId: chatId, name: 'send-chat', args: { message: `${message}-different` } }, ['OPERATION_CONFLICT']);
  const slash = await wire('act', { ...scope, controlGeneration: lease.controlGeneration, operationId: randomUUID(), name: 'send-chat', args: { message: '/op Claude' } });
  check('chat cannot run slash command', (!slash.ok && slash.error?.code === 'INVALID_ARGUMENT') || (slash.ok && slash.result?.status === 'failed'));
  check('rejected slash message was not broadcast', !(await observe()).chat.some(line => line.username === connection.username && line.message === '/op Claude'));
  await heartbeat();
  const p = position(await observe()), oldGeneration = lease.controlGeneration;
  const move = await act('move-to-position', { x: p.x, y: p.y, z: p.z + 2, tolerance: 0.25, timeoutMs: 5000 });
  check('movement accepted as operation', move.name === 'move-to-position' && move.status === 'running', move);
  await wait(200); const during = position(await observe());
  check('HTTP movement produces physical displacement', distance(p, during) > 0.05, { before: p, during });
  const stopBegin = performance.now(), stopped = await rpc('stop', scope);
  evidence.stopRpcMs = performance.now() - stopBegin;
  check('stop advances control generation', stopped.stopped && stopped.controlGeneration > oldGeneration);
  lease.controlGeneration = stopped.controlGeneration;
  await refuses('late old-generation action rejected', 'act', { ...scope, controlGeneration: oldGeneration, operationId: randomUUID(), name: 'look-at', args: p }, ['STALE_CONTROL']);
  const stoppedOp = await rpc('operation', { ...scope, operationId: move.operationId });
  check('stopped operation is cancelled', stoppedOp.status === 'cancelled');
  await stable('stop keeps role connected and stationary');
  check('new explicit action after stop succeeds', (await act('look-at', p)).status === 'succeeded');
  const oldScope = { ...scope }, oldStopToken = lease.stopToken, oldSession = lease.sessionId;
  const revoked = await rpc('revoke', { ...scope, stopToken: lease.stopToken });
  check('host revoke succeeds', revoked.stopped && revoked.revoked);
  await refuses('revoked MCP cannot act', 'act', { ...oldScope, controlGeneration: lease.controlGeneration, operationId: randomUUID(), name: 'look-at', args: p }, ['LEASE_LOST']);
  const retiredWatch = await rpc('watch', { ...oldScope, stopToken: oldStopToken });
  check('retired owner can only watch for new human task', Array.isArray(retiredWatch.chat) && Number.isInteger(retiredWatch.chatCursor));
  await claim();
  check('explicit reclaim preserves same role session', lease.sessionId === oldSession && lease.leaseId !== oldScope.leaseId);
  const staleRevoke = await wire('revoke', { ...oldScope, stopToken: oldStopToken });
  check('old revoke cannot control new lease', !staleRevoke.ok || staleRevoke.result?.revoked === true);
  await heartbeat();
  check('new owner survives old revoke', (await observe()).connected);
  await refuses('old watcher cannot observe new control', 'watch', { ...oldScope, stopToken: oldStopToken }, ['LEASE_LOST']);
  const releaseSession = lease.sessionId;
  await release();
  check('release retains role online', (await rpc('hello')).connected);
  await claim();
  check('release and reclaim do not recreate role', lease.sessionId === releaseSession);
  // Approach the lease deadline without renewing it; start motion shortly before expiry.
  const expiryStart = performance.now(), expiryScope = { ...scope }, expiryLease = { ...lease };
  const expiryPosition = position(await observe());
  const remaining = expiryLease.ttlMs - 600 - (performance.now() - expiryStart);
  if (remaining > 0) await wait(remaining);
  const expiryMove = await act('move-to-position', { x: expiryPosition.x, y: expiryPosition.y, z: expiryPosition.z - 3, tolerance: 0.25, timeoutMs: 5000 });
  check('movement starts just before lease expiry', expiryMove.status === 'running');
  await wait(850);
  await refuses('heartbeat cannot revive expired lease', 'heartbeat', expiryScope, ['LEASE_LOST']);
  await refuses('expired caller cannot act', 'act', { ...expiryScope, controlGeneration: expiryLease.controlGeneration, operationId: randomUUID(), name: 'look-at', args: expiryPosition }, ['LEASE_LOST']);
  await claim();
  check('lease expiry preserves role identity', lease.sessionId === expiryLease.sessionId);
  await stable('expiry stopped old movement before new owner attaches');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = { message: error.message, code: error.code }; process.exitCode = 1; console.error(error.message);
} finally {
  if (scope) { try { await release(); evidence.cleanup.push('current lease released'); } catch (error) { evidence.cleanup.push({ releaseError: error.code ?? error.message }); } }
  evidence.finished = new Date().toISOString();
  await mkdir(dirname(resolve(opt.output)), { recursive: true });
  await writeFile(resolve(opt.output), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Evidence: ${resolve(opt.output)}`);
}
