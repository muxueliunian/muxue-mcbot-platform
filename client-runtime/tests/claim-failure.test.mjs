import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BodyError } from '../dist/body.js';
import { claimFailureText, logClaimFailure, serverDetail } from '../dist/claim-failure.js';
import { mockServerControl } from './mock-server-control.mjs';

const SURVIVAL_HINT = 'Bot 不是生存模式，无法接管。目前只支持生存模式；开局域网时游戏模式请选「生存」。';
const directory = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-claim-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('claim failure text: survival rejections get the fixed hint, others keep code and server words', () => {
  assert.equal(claimFailureText(new BodyError('FORBIDDEN', 'x', 'Saved body is not in survival mode')), SURVIVAL_HINT);
  assert.equal(claimFailureText(new BodyError('FORBIDDEN', 'x', 'Existing body is not in survival mode; no automatic game-mode change')), SURVIVAL_HINT);
  assert.equal(claimFailureText(new BodyError('FORBIDDEN', '服务端拒绝请求（FORBIDDEN）', 'Server body refuses an OP identity')), '接管失败（FORBIDDEN）：Server body refuses an OP identity');
  assert.equal(claimFailureText(new BodyError('WRONG_PLAYER', '服务端拒绝请求（WRONG_PLAYER）')), '接管失败（WRONG_PLAYER）：服务端拒绝请求（WRONG_PLAYER）');
  assert.equal(serverDetail('a\u0000b\nc'), 'a b c');
  assert.equal(serverDetail('x'.repeat(500)).length, 200);
  assert.equal(serverDetail(3), undefined);
});

test('the same failure is logged once in ten minutes, again after', t => {
  const file = path.join(directory(t), 'activity-Bot.jsonl');
  const error = new BodyError('FORBIDDEN', 'x', 'Saved body is not in survival mode');
  logClaimFailure(file, error, 1_000);
  logClaimFailure(file, error, 60_000);
  logClaimFailure(file, new BodyError('WRONG_PLAYER', 'y'), 61_000);
  logClaimFailure(file, error, 62_000);
  assert.equal(lines(file).length, 2);
  logClaimFailure(file, error, 1_000 + 600_001 + 61_000);
  assert.deepEqual(lines(file).map(entry => entry.kind), ['error', 'error', 'error']);
});

test('hosted runtime that cannot take a non-survival body writes the hint to the activity log', async t => {
  const dir = directory(t);
  const mock = await mockServerControl({ claim: () => { throw Object.assign(new Error('Saved body is not in survival mode'), { code: 'FORBIDDEN' }); } });
  t.after(() => mock.close());
  const connectionFile = path.join(dir, 'connection.json'); fs.writeFileSync(connectionFile, JSON.stringify(mock.connection));
  fs.writeFileSync(path.join(dir, 'companion-ServerBot.json'), JSON.stringify({ pid: process.pid, updatedAt: Date.now() }));
  const child = spawn(process.execPath, ['--experimental-loader', pathToFileURL(path.resolve('tests/no-mineflayer-loader.mjs')).href, path.resolve('dist/main.js'),
    '--body', 'server', '--connection-file', connectionFile, '--username', 'ServerBot', '--world-id', 'test-world', '--runtime-dir', dir, '--hosted'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1, stderr);
  const [entry] = lines(path.join(dir, 'activity-ServerBot.jsonl'));
  assert.equal(entry.kind, 'error');
  assert.equal(entry.text, SURVIVAL_HINT);
  assert.ok(mock.calls.some(call => call.method === 'claim'));
});
