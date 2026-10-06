#!/usr/bin/env node
// Explicit fixture-driven checks. This script never prepares a world or replays an unknown action.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ClientBody, readConnection } from '../client-runtime/dist/client-body.js';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const elapsed = since => Math.round((performance.now() - since) * 10) / 10;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const faces = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
const help = `Usage: node scripts/client-body-smoke.mjs --connection-file <file> --username ClientBot --world-id <id>
  --scenario inspect|move|interact [--plan <JSON or JSON-file>] [--output <file>]

inspect: optional plan {"block":{"x":0,"y":64,"z":0}}; hello, observe, stop, observe, release.
move: prepared, clear, level test area only. Explicit plan:
  {"firstTarget":{"x":2,"y":64,"z":0},"newTarget":{"x":0,"y":64,"z":0},
   "stopAfterMs":250,"stationaryMs":1000,"tolerance":0.3,"timeoutMs":8000}
  Each target must be within 5 blocks of the observed starting position. No path digging.
interact: prepared single-block/container fixtures only. Explicit ordered steps:
  {"steps":[{"action":"dig-block","args":{"x":1,"y":64,"z":0,"expectedBlock":"minecraft:dirt"}}]}
  Supported: dig-block, place-block, open-container, click-slot, close-container.
  Args follow docs/archive/client_body_protocol.md. Existing menus require explicit containerId.
  New menus opened in this run can omit containerId in later steps; it is read from observation.
  click-slot requires all expected item/count and carried item/count fields.
  Every unknown result ends the scenario without another mutation; rerun only after review.

Exit 0: checks passed (client observations only); 1: failure; 2: inconclusive/unknown.
Output never includes the connection token. release is reported from its actual response.
`;

function parseArgs(argv) {
  const options = { scenario: 'inspect' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    assert(['--connection-file', '--username', '--world-id', '--scenario', '--plan', '--output'].includes(argv[i]), `Unknown option: ${argv[i]}`);
    const key = argv[i].slice(2);
    assert(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value for --${key}`);
    assert(key === 'scenario' || options[key] === undefined, `Repeated --${key}`);
    options[key] = argv[++i];
  }
  for (const key of ['connection-file', 'username', 'world-id']) assert(options[key], `Required: --${key}`);
  assert(/^[A-Za-z0-9_]{1,16}$/.test(options.username), 'Invalid username');
  assert(['inspect', 'move', 'interact'].includes(options.scenario), 'Invalid scenario');
  assert(!options.output || resolve(options.output).toLowerCase() !== resolve(options['connection-file']).toLowerCase(), 'Output must not overwrite the connection file');
  return options;
}

function position(value, label, integer = false) {
  assert(value && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]) && (!integer || Number.isInteger(value[key]))), `${label} requires explicit finite ${integer ? 'integer ' : ''}x/y/z`);
  return { x: value.x, y: value.y, z: value.z };
}
function bounded(value, fallback, min, max, label) {
  const result = value ?? fallback;
  assert(Number.isFinite(result) && result >= min && result <= max, `${label} must be ${min}..${max}`);
  return result;
}
function itemId(value, label) {
  assert(typeof value === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value), `${label} requires a namespaced ID`);
}
function validatePlan(scenario, plan) {
  assert(plan && typeof plan === 'object' && !Array.isArray(plan), 'Plan must be an object');
  if (scenario === 'inspect') { if (plan.block) position(plan.block, 'block', true); return; }
  if (scenario === 'move') {
    position(plan.firstTarget, 'firstTarget'); position(plan.newTarget, 'newTarget');
    plan.stopAfterMs = bounded(plan.stopAfterMs, 250, 0, 1000, 'stopAfterMs');
    plan.stationaryMs = bounded(plan.stationaryMs, 1000, 500, 3000, 'stationaryMs');
    plan.tolerance = bounded(plan.tolerance, 0.3, 0.1, 0.5, 'tolerance');
    plan.timeoutMs = bounded(plan.timeoutMs, 8000, 500, 15000, 'timeoutMs');
    return;
  }
  assert(Array.isArray(plan.steps) && plan.steps.length > 0 && plan.steps.length <= 8, 'interact requires 1..8 explicit steps');
  for (const { action, args } of plan.steps) {
    assert(['dig-block', 'place-block', 'open-container', 'click-slot', 'close-container'].includes(action), `Unsupported fixture action: ${action}`);
    assert(args && typeof args === 'object', `${action} requires args`);
    if (['dig-block', 'place-block', 'open-container'].includes(action)) {
      position(args, action, true); itemId(args.expectedBlock, 'expectedBlock');
      args.timeoutMs = bounded(args.timeoutMs, 8000, 500, 15000, 'timeoutMs');
    }
    if (action === 'place-block') {
      assert(Object.hasOwn(faces, args.face), 'place-block requires an explicit face');
      assert(Number.isInteger(args.slot) && args.slot >= 0 && args.slot <= 8, 'place-block requires hotbar slot 0..8');
      itemId(args.expectedItem, 'expectedItem');
    }
    if (action === 'click-slot') {
      assert(Number.isInteger(args.slot) && args.slot >= 0, 'click-slot requires explicit slot');
      for (const key of ['expectedCount', 'expectedCarriedCount']) assert(Number.isInteger(args[key]) && args[key] >= 0, `${key} must be an explicit nonnegative integer`);
      itemId(args.expectedItem, 'expectedItem'); itemId(args.expectedCarriedItem, 'expectedCarriedItem');
      assert(args.button === undefined || args.button === 0 || args.button === 1, 'button must be 0 or 1');
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  const raw = options.plan ? (options.plan.trim().startsWith('{') ? options.plan : await readFile(options.plan, 'utf8')) : '{}';
  const plan = JSON.parse(raw.replace(/^\uFEFF/, ''));
  validatePlan(options.scenario, plan);
  const report = { scenario: options.scenario, username: options.username, worldId: options['world-id'], startedAt: new Date().toISOString(), result: 'failed', evidence: 'client-observed; not independent server confirmation', steps: [] };
  let body, token, releaseReply;
  const record = (label, data) => { report.steps.push({ label, time: new Date().toISOString(), ...data }); return data; };
  const observe = async (label, block) => {
    const since = performance.now();
    const observation = await body.observe(block);
    record(label, { elapsedMs: elapsed(since), observation });
    return observation;
  };
  const stop = async label => {
    const since = performance.now();
    const response = await body.stop();
    record(label, { elapsedMs: elapsed(since), response });
  };
  const complete = async (name, args, label) => {
    const since = performance.now();
    let operation = await body.act(name, args);
    record(`${label}:submitted`, { operation });
    const deadline = performance.now() + (args.timeoutMs ?? 8000) + 2000;
    while (operation.status === 'running' && performance.now() < deadline) {
      await sleep(100);
      operation = await body.operation(operation.operationId); // Polling observes; it never resends act.
    }
    record(`${label}:result`, { elapsedMs: elapsed(since), operation });
    return operation;
  };
  const requireSuccess = operation => {
    if (operation.status === 'unknown' || operation.status === 'running') {
      report.result = 'inconclusive';
      throw new Error(`${operation.name}: ${operation.status}; no further mutation will be sent`);
    }
    assert(operation.status === 'succeeded', `${operation.name}: ${operation.status}: ${operation.summary}`);
  };
  try {
    const connection = await readConnection(options['connection-file']);
    token = connection.token;
    const transport = async (url, init) => {
      const response = await fetch(url, init);
      if (JSON.parse(init.body).method === 'release') {
        try { releaseReply = { httpStatus: response.status, reply: await response.clone().json() }; }
        catch { releaseReply = { httpStatus: response.status, invalidResponse: true }; }
      }
      return response;
    };
    body = await ClientBody.connect({ connection, username: options.username, worldId: options['world-id'], claimWaitMs: 0, fetch: transport });
    record('hello', { hello: body.hello });
    const initial = await observe('initial', plan.block);
    if (options.scenario === 'inspect') {
      await stop('stop');
      await observe('after-stop', plan.block);
    } else if (options.scenario === 'move') {
      const targetCheck = (target, from) => {
        assert(distance(from, target) <= 5 && Math.abs(target.y - from.y) <= 1, 'Target must be within 5 blocks on level ground');
        assert(distance(from, target) > plan.tolerance + 0.2, 'Target is too close to test movement');
      };
      targetCheck(plan.firstTarget, initial.position); targetCheck(plan.newTarget, plan.firstTarget);
      const first = await body.act('move-to-position', { ...plan.firstTarget, tolerance: plan.tolerance, timeoutMs: plan.timeoutMs });
      record('first-move:submitted', { operation: first });
      if (first.status === 'unknown') requireSuccess(first);
      assert(first.status === 'running', `First movement did not start: ${first.status}`);
      await sleep(plan.stopAfterMs);
      const before = await observe('before-stop');
      const beforeOp = await body.operation(first.operationId);
      record('before-stop:operation', { operation: beforeOp });
      await stop('stop-during-move');
      const after = await observe('immediate-after-stop');
      const finalOp = await body.operation(first.operationId);
      record('stopped-operation', { operation: finalOp });
      await sleep(300); // Allow normal client inertia to settle, then compare two observations.
      const settled = await observe('settled-after-stop');
      await sleep(plan.stationaryMs);
      const stationary = await observe('stationary-after-stop');
      const drift = distance(settled.position, stationary.position);
      record('stop-check', { drift, threshold: 0.15, movementBeforeStop: distance(initial.position, before.position), stopTravel: distance(before.position, after.position), interruptedRunningOperation: beforeOp.status === 'running', sameSession: initial.sessionId === stationary.sessionId });
      assert(beforeOp.status === 'running' && finalOp.status === 'cancelled', 'Stop was not demonstrated during an active movement');
      assert(drift <= 0.15, `Player moved ${drift} blocks after settling`);
      assert(distance(initial.position, before.position) > 0.02, 'No movement was observed before stopping');
      targetCheck(plan.newTarget, stationary.position);
      const next = await complete('move-to-position', { ...plan.newTarget, tolerance: plan.tolerance, timeoutMs: plan.timeoutMs }, 'new-move');
      const final = await observe('after-new-move');
      requireSuccess(next);
      assert(Math.hypot(final.position.x - plan.newTarget.x, final.position.z - plan.newTarget.z) <= plan.tolerance + 0.15, 'Final observed position is outside target tolerance');
    } else {
      let openedMenu;
      for (const [index, step] of plan.steps.entries()) {
        const args = { ...step.args };
        const label = `${index + 1}:${step.action}`;
        const hasBlock = ['dig-block', 'place-block', 'open-container'].includes(step.action);
        const current = await observe(`${label}:before`, hasBlock ? position(args, label, true) : undefined);
        if (hasBlock) assert(current.block?.state === 'loaded' && current.block.id === args.expectedBlock, `${label}: block ID does not match fixture`);
        let target;
        if (step.action === 'place-block') {
          const delta = faces[args.face];
          target = { x: args.x + delta[0], y: args.y + delta[1], z: args.z + delta[2] };
          const empty = await observe(`${label}:target`, target);
          assert(empty.block?.state === 'loaded' && empty.block.id === 'minecraft:air', `${label}: placement target is not loaded air`);
          const stack = current.inventory.find(item => item.slot === args.slot);
          assert(stack?.id === args.expectedItem && stack.count > 0, `${label}: inventory does not match fixture`);
        }
        if (['click-slot', 'close-container'].includes(step.action)) {
          assert(current.container && current.container.id === (args.containerId ?? openedMenu), `${label}: container handle does not match`);
          args.containerId = current.container.id;
          if (step.action === 'click-slot') {
            const stack = current.container.slots.find(item => item.slot === args.slot);
            assert(stack && stack.id === args.expectedItem && stack.count === args.expectedCount, `${label}: slot does not match fixture`);
            assert(current.container.carried.id === args.expectedCarriedItem && current.container.carried.count === args.expectedCarriedCount, `${label}: carried stack does not match fixture`);
          } else assert(current.container.carried.count === 0, 'Refusing to close a menu while carrying items');
        }
        const operation = await complete(step.action, args, label);
        const after = await observe(`${label}:after`, target ?? (hasBlock ? position(args, label, true) : undefined));
        requireSuccess(operation); // unknown is evidence, never permission to continue.
        if (step.action === 'open-container') {
          assert(after.container, 'Open operation finished without an observed menu');
          openedMenu = after.container.id;
        }
      }
    }
    report.result = 'passed';
  } catch (error) {
    report.error = { code: error.code ?? 'CHECK_FAILED', message: error.message };
    if (['TRANSPORT_LOST', 'HTTP_ERROR', 'INVALID_RESPONSE', 'LEASE_LOST', 'WORLD_CHANGED'].includes(error.code)) report.result = 'inconclusive';
  } finally {
    if (body) {
      // Safety stop/release do not replay any action, and do not close a carried-stack menu.
      try { await stop('cleanup-stop'); } catch (error) {
        record('cleanup-stop-failed', { code: error.code, message: error.message });
        if (report.result === 'passed') report.result = 'inconclusive';
      }
      const since = performance.now();
      await body.close();
      const confirmed = releaseReply?.reply?.ok === true && releaseReply.reply.result?.released === true;
      record('release', { elapsedMs: elapsed(since), confirmed, response: releaseReply ?? null });
      if (!confirmed && report.result === 'passed') report.result = 'inconclusive';
    }
    report.finishedAt = new Date().toISOString();
    const serialized = JSON.stringify(report, null, 2).replaceAll(token || '\0', '[REDACTED]');
    if (options.output) { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(options.output, `${serialized}\n`, 'utf8'); }
    console.log(serialized);
    process.exitCode = report.result === 'passed' ? 0 : report.result === 'inconclusive' ? 2 : 1;
  }
}

main().catch(error => { console.error(`Smoke check failed before connecting: ${error.message}`); process.exitCode = 1; });
