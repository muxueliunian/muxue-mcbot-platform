#!/usr/bin/env node
// Test-only transparent stdio mirror. Every request comes from the real Agent;
// this process never creates a JSON-RPC request or calls a Body/control endpoint.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const ownFile = fileURLToPath(import.meta.url);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const idValue = value => typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
const key = id => `${typeof id}:${id}`;
export function policyProjection(value) {
  if (!object(value)) return null;
  const out = {};
  for (const field of ['revision', 'urgentFood', 'defenseRadius', 'lowHealth', 'maxAttacks', 'defenseTimeoutMs', 'minRemainingDurability']) if (Number.isFinite(value[field])) out[field] = value[field];
  for (const field of ['armed', 'autoEat', 'autoDefend', 'defenseSupported']) if (typeof value[field] === 'boolean') out[field] = value[field];
  if (['idle', 'eating', 'defending', 'stopping', 'blocked'].includes(value.phase)) out.phase = value.phase;
  if (Array.isArray(value.excludedEntityIds)) out.excludedEntityIds = value.excludedEntityIds.filter(uuid).slice(0, 64);
  if (['fastest_valid', 'conserve_durability'].includes(value.toolPolicy)) out.toolPolicy = value.toolPolicy;
  return out;
}
/** Pure observation hook for offline verification; requests and replies are never mutated. */
export function createMirror(record, now = Date.now) {
  const pending = new Map();
  return {
    request(message) {
      if (!object(message) || !idValue(message.id)) return;
      const name = message.method === 'tools/list' ? 'tools/list' : message.method === 'tools/call' && ['set-reflexes', 'get-survival-state'].includes(message.params?.name) ? message.params.name : undefined;
      if (!name) return;
      const row = { requestId: message.id, method: message.method, name, requestedAt: now() };
      pending.set(key(message.id), row); if (pending.size > 512) pending.delete(pending.keys().next().value);
      record({ kind: 'request', ...row });
    },
    response(message) {
      if (!object(message) || !idValue(message.id)) return;
      const row = pending.get(key(message.id)); if (!row) return;
      pending.delete(key(message.id));
      // Failed MCP/RPC results are not presented as accepted policy. No arbitrary text is recorded.
      if (message.error || message.result?.isError === true) { record({ kind: 'response', ...row, respondedAt: now(), accepted: false }); return; }
      if (row.name === 'tools/list') {
        if (!Array.isArray(message.result?.tools)) return;
        const names = message.result.tools.map(tool => tool.name).filter(name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(name));
        record({ kind: 'response', ...row, respondedAt: now(), accepted: true, names }); return;
      }
      let payload;
      for (const content of message.result?.content ?? []) {
        if (content?.type !== 'text' || typeof content.text !== 'string') continue;
        try { const parsed = JSON.parse(content.text); if (object(parsed)) { payload = parsed; break; } } catch { /* Exact bytes still pass through. */ }
      }
      if (!payload) return;
      const policy = policyProjection(row.name === 'get-survival-state' ? payload.policy : payload);
      if (!policy || !Number.isSafeInteger(policy.revision) || policy.revision < 1) return;
      const facts = { kind: 'response', ...row, respondedAt: now(), accepted: true, policy };
      if (row.name === 'get-survival-state' && Array.isArray(payload.threats?.nearby)) {
        facts.threats = payload.threats.nearby.filter(threat => uuid(threat?.entityId)).slice(0, 64).map(threat => ({ entityId: threat.entityId,
          ...(typeof threat.type === 'string' && /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(threat.type) ? { type: threat.type } : {}) }));
      }
      record(facts);
    }
  };
}
function lineMirror(inspect) {
  const decoder = new StringDecoder('utf8'); let pending = '', skip = false;
  return chunk => {
    for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
      if (!skip) pending += part;
      if (pending.length > 1048576) { pending = ''; skip = true; }
      if (part.endsWith('\n')) { if (!skip) { try { inspect(JSON.parse(pending)); } catch { /* Observer cannot alter malformed input handling. */ } } pending = ''; skip = false; }
    }
  };
}
function main() {
  const forwarded = []; let logFile;
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === '--observer-log') { if (logFile || !process.argv[index + 1]) throw Error('MCP_OBSERVER_INVALID_ARGUMENT'); logFile = path.resolve(process.argv[++index]); }
    else forwarded.push(process.argv[index]);
  }
  if (!logFile || !forwarded.includes('--body') || forwarded[forwarded.indexOf('--body') + 1] !== 'server') throw Error('MCP_OBSERVER_INVALID_ARGUMENT');
  let auditFailed = false;
  const record = row => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5000000) fs.renameSync(logFile, `${logFile}.previous`);
      fs.appendFileSync(logFile, JSON.stringify({ observerPid: process.pid, at: Date.now(), ...row }) + '\n');
    } catch { if (!auditFailed) process.stderr.write('MCP_OBSERVER_AUDIT_FAILED\n'); auditFailed = true; }
  };
  const child = spawn(process.execPath, [path.resolve(path.dirname(ownFile), '../client-runtime/dist/main.js'), ...forwarded], { cwd: path.resolve(path.dirname(ownFile), '..'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const mirror = createMirror(record), input = lineMirror(message => mirror.request(message)), output = lineMirror(message => mirror.response(message));
  process.stdin.on('data', chunk => { input(chunk); if (!child.stdin.write(chunk)) process.stdin.pause(); });
  child.stdin.on('drain', () => process.stdin.resume());
  process.stdin.on('end', () => child.stdin.end());
  child.stdout.on('data', chunk => { output(chunk); if (!process.stdout.write(chunk)) child.stdout.pause(); });
  process.stdout.on('drain', () => child.stdout.resume());
  child.stderr.on('data', chunk => { if (!process.stderr.write(chunk)) child.stderr.pause(); });
  process.stderr.on('drain', () => child.stderr.resume());
  child.stdin.on('error', () => { /* Runtime close decides the observer exit status; never retry. */ });
  child.on('error', () => { process.stderr.write('MCP_OBSERVER_RUNTIME_START_FAILED\n'); process.exitCode = 1; process.stdin.pause(); });
  child.on('close', (code, signal) => { record({ kind: 'runtime-exit', runtimePid: child.pid ?? null, exitCode: code, signal });
    process.stdin.pause(); process.exitCode = code === 0 && signal === null && !auditFailed ? 0 : typeof code === 'number' && code !== 0 ? code : 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child.stdin.end(); child.kill(signal); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ownFile)) {
  try { main(); } catch { process.stderr.write('MCP_OBSERVER_START_FAILED\n'); process.exitCode = 1; }
}
