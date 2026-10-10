import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CompanionMode } from '../dist/companion-mode.js';
import { GatherTasks } from '../dist/gather-tasks.js';
import { ContainerTasks } from '../dist/tasks.js';
import { ServerBody } from '../dist/server-body.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { SurvivalReflexes } from '../dist/survival-reflexes.js';
import { createActionStop, companionReflexHooks } from '../dist/action-stop.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { mockServerControl } from './mock-server-control.mjs';

// Player trial: a follow stepping aside for gather-resources / approach-container moved the control generation on and
// the reference the model had just found failed with WORLD_CHANGED; a failed self-defense while following ended the body.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what = 'condition') { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail(`${what} did not become observable`); }
const alex = randomUUID();

/**
 * ServerBody against a mock control port that keeps targets like ControlSession/TargetTokens/ResourceTargets: a token
 * holds in the generation it was issued and across step-aside stops only; an ordinary stop cuts the chain.
 */
async function fixture(t, { stepAside = true } = {}) {
  const mock = await mockServerControl();
  mock.setState({ dimension: 'minecraft:overworld', pickupCursor: 0, pickupOldestCursor: 0, pickupReceipts: [], groundItems: [],
    inventory: Array.from({ length: 36 }, (_, slot) => ({ slot, id: 'minecraft:air', count: 0, components: {} })),
    entities: [{ id: alex, name: 'Alex', type: 'minecraft:player', position: { x: 2, y: 64, z: 0 } }] });
  let generation = 0, carryFloor = 0;
  const tokens = new Map(), tokenActs = [];
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'follow-companion', 'nearby-resources', 'approach-resource', 'dig-block', 'select-slot', 'pickup-item',
    'nearby-blocks', 'approach-container', 'defend-entity', ...(stepAside ? ['step-aside-stop'] : [])] });
  const stop = mock.handlers.stop;
  mock.handlers.stop = params => {
    const result = stop(params); generation = result.controlGeneration;
    if (!(stepAside && params.stepAside === true && !params.clearGuard)) carryFloor = generation;
    return result;
  };
  const carries = issued => issued >= carryFloor && issued <= generation;
  const issue = () => { const token = randomUUID(); tokens.set(token, generation); return token; };
  const context = params => ({ instanceId: 'instance-1', sessionId: params.sessionId, worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: generation });
  mock.handlers['nearby-resources'] = params => ({ ...context(params), center: { x: 0, y: 64, z: 0 }, candidates: [{ position: { x: 2, y: 64, z: 1 }, id: 'minecraft:oak_log', kind: 'log',
    drops: [{ item: 'minecraft:oak_log', preference: 'any', least: 1 }], properties: { axis: 'y' }, targetToken: issue(), distance: 2, visible: true, requiresCorrectTool: false, suitableToolSlots: [0], recommendedToolSlot: 0 }] });
  mock.handlers['nearby-blocks'] = params => ({ ...context(params), center: { player: 'ServerBot', position: { x: 0, y: 64, z: 0 } }, candidates: [{ position: { x: 2, y: 64, z: 2 }, id: 'minecraft:chest',
    properties: { facing: 'north', type: 'single', waterlogged: 'false' }, targetToken: issue(), distance: 2.8, visibility: 'visible', visible: true }] });
  const act = mock.handlers.act;
  mock.handlers.act = (params, ctx) => {
    const token = params.args?.targetToken;
    if (token !== undefined) {
      const ok = tokens.has(token) && carries(tokens.get(token));
      tokenActs.push({ name: params.name, ok });
      if (!ok) throw Object.assign(new Error('Resource reference expired or control changed'), { code: 'STALE_TARGET' });
    }
    const op = act(params, ctx);
    if (params.name === 'follow-companion') {
      const following = { ...op, status: 'running', result: { ...params.args, distance: params.args.distance ?? 2.5, state: 'following', position: { x: 0, y: 64, z: 0 } } };
      ctx.operations.set(op.operationId, following); return following;
    }
    // Only the first guarded step matters here: end the task there instead of scripting a whole tree.
    if (token !== undefined && params.name !== 'approach-container') { const done = { ...op, status: 'failed', summary: 'test ends the task here', result: { code: 'BLOCKED' } }; ctx.operations.set(op.operationId, done); return done; }
    return op;
  };
  const lost = [];
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000, onLost: error => lost.push(error.code) });
  const events = new EventJournal();
  const gather = new GatherTasks(body, events), tasks = new ContainerTasks(body);
  const mode = new CompanionMode(body, events, gather);
  mode.resumeDelayMs = 0;
  const fatal = [];
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: error => fatal.push(error.code) });
  const server = createMcpServer(body, events, { companion: mode, gather, tasks });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'step-aside-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { monitor.stop(); await client.close(); await server.close(); await body.close(); await mock.close(); });
  const call = async (name, args = {}) => { const reply = await client.callTool({ name, arguments: args }); return { error: reply.isError === true, value: JSON.parse(reply.content[0].text) }; };
  const stops = () => mock.calls.filter(entry => entry.method === 'stop').map(entry => entry.params);
  const follow = async () => { await mode.request({ action: 'follow', player: 'Alex' }); await until(() => mode.snapshot().stage === 'active', 'following'); };
  return { mock, body, mode, events, monitor, call, stops, follow, tokenActs, lost, fatal, generation: () => generation };
}

test('following: discover-resources then gather-resources starts; the step-aside does not void the resourceRef', async t => {
  const f = await fixture(t);
  await f.follow();
  const found = await f.call('discover-resources', { blockIds: ['#minecraft:logs'] });
  assert.equal(found.error, false, JSON.stringify(found.value));
  const discoveredAt = f.generation();
  const gathered = await f.call('gather-resources', { item: 'minecraft:oak_log', count: 1, resourceRef: found.value.resourceRef });
  assert.equal(gathered.error, false, `gather was refused: ${JSON.stringify(gathered.value)}`);
  assert.equal(gathered.value.status, 'running');
  assert.equal(f.generation(), discoveredAt + 1, 'the follow stepped aside with one stop');
  assert.deepEqual(f.stops().map(stop => stop.stepAside === true), [true], 'that stop told the server it was a step-aside');
  await until(() => f.tokenActs.length > 0, "the first guarded step");
  assert.equal(f.tokenActs[0].ok, true, 'the server side also still accepts the target token');
  assert.deepEqual(f.lost, []);
});

test('following: a player stop-action between discover and gather still voids the resourceRef', async t => {
  const f = await fixture(t);
  await f.follow();
  const found = await f.call('discover-resources', { blockIds: ['#minecraft:logs'] });
  const discoveredAt = f.generation();
  assert.equal((await f.call('stop-action')).error, false);
  assert.equal(f.body.carries(discoveredAt), false, 'the stop cut the generation chain');
  const gathered = await f.call('gather-resources', { item: 'minecraft:oak_log', count: 1, resourceRef: found.value.resourceRef });
  assert.equal(gathered.error, true);
  assert.ok(['STALE_REFERENCE', 'WORLD_CHANGED'].includes(gathered.value.code), gathered.value.code);
  assert.deepEqual(f.tokenActs, [], 'nothing was dug');
});

test('a reference kept locally is still refused after any stop that is not a step-aside', async t => {
  const f = await fixture(t);
  await f.follow();
  const found = await f.call('discover-containers', {});
  // Some other stop (not the follow stepping aside) while the follow is paused by hand: the generation chain is cut.
  await f.mode.request({ action: 'pause' });
  await f.body.stop();
  const walked = await f.call('approach-container', { containerRef: found.value.candidates[0].containerRef });
  assert.equal(walked.error, true);
  assert.equal(walked.value.code, 'WORLD_CHANGED');
  assert.deepEqual(f.tokenActs, []);
});

test('following: discover-containers then approach-container walks; a stop-action in between refuses it', async t => {
  const f = await fixture(t);
  await f.follow();
  const found = await f.call('discover-containers', {});
  assert.equal(found.error, false, JSON.stringify(found.value));
  const walked = await f.call('approach-container', { containerRef: found.value.candidates[0].containerRef });
  assert.equal(walked.error, false, `approach was refused: ${JSON.stringify(walked.value)}`);
  assert.equal(walked.value.status, 'succeeded');
  assert.deepEqual(f.tokenActs, [{ name: 'approach-container', ok: true }]);
  assert.equal(f.stops().at(-1).stepAside, true);

  const again = await f.call('discover-containers', {});
  assert.equal((await f.call('stop-action')).error, false);
  const refused = await f.call('approach-container', { containerRef: again.value.candidates[0].containerRef });
  assert.equal(refused.error, true);
  assert.ok(['STALE_REFERENCE', 'WORLD_CHANGED'].includes(refused.value.code), refused.value.code);
  assert.equal(f.tokenActs.length, 1, 'no second walk');
});

test('a body without step-aside-stop keeps the old strict rule', async t => {
  const f = await fixture(t, { stepAside: false });
  await f.follow();
  const found = await f.call('discover-containers', {});
  const walked = await f.call('approach-container', { containerRef: found.value.candidates[0].containerRef });
  assert.equal(walked.error, true);
  assert.equal(walked.value.code, 'WORLD_CHANGED');
  assert.equal('stepAside' in f.stops().at(-1), false, 'the flag is only sent to servers that understand it');
});

test('a stop arriving during a step-aside runs as its own stop and cuts the chain', async t => {
  const f = await fixture(t);
  const before = f.generation();
  const stopHandler = f.mock.handlers.stop;
  let release; const held = new Promise(resolve => { release = resolve; });
  f.mock.handlers.stop = async params => { if (params.stepAside) await held; return stopHandler(params); };
  const aside = f.body.stop({ stepAside: true });
  await until(() => f.stops().length === 1, 'the step-aside stop');
  const plain = f.body.stop();
  release();
  await aside; await plain;
  assert.deepEqual(f.stops().map(stop => stop.stepAside === true), [true, false], 'the stop-action was not folded into the step-aside');
  assert.equal(f.generation(), before + 2);
  assert.equal(f.body.carries(before), false);
});

test('following + self-defense that fails for certain: the follow picks up again, no WORLD_CHANGED, no disconnect', async t => {
  const f = await fixture(t);
  await f.follow();
  const failed = { operationId: randomUUID(), sessionId: 'server-session-1', name: 'defend-self', status: 'failed', summary: '没有完整可核验的原版武器或空手热栏，不使用未知Mod物品', result: { code: 'UNSAFE_WEAPON' } };
  const survival = { read: () => ({ state: 'idle' }), assertIdle() {}, cancel: () => ({}), stopped() {}, async defend() { return structuredClone(failed); } };
  const tasks = { cancel: () => ({}), stopped() {}, assertIdle() {} }, gather = { cancel() {}, stopped() {}, assertIdle() {} };
  const stopCurrent = createActionStop(f.body, tasks, gather, f.mode, survival);
  const reflexes = new SurvivalReflexes(f.body, survival, f.events, { stopCurrent, stopWork: stopCurrent.keepCompanion,
    ...companionReflexHooks(tasks, gather, f.mode, stopCurrent.keepCompanion, survival, () => f.body.isBusy() || f.body.pendingOperations().length > 0),
    ordinaryBusy: () => f.body.isBusy() || !['idle', 'paused', 'stopped', 'blocked'].includes(f.mode.snapshot().state) });
  const states = [];
  const add = f.events.add.bind(f.events);
  f.events.add = (type, text, ...rest) => { states.push({ type, text }); return add(type, text, ...rest); };
  const startedAt = f.generation();
  const operation = await reflexes.defendSelf(randomUUID());
  assert.equal(operation.status, 'failed');
  // The trial log: step aside (one stop), then the busy body was stopped again; the failure then held the follow by hand.
  assert.equal(f.generation(), startedAt + 2, 'two stops moved the generation on by two');
  await until(() => f.mode.snapshot().state === 'following' && f.mode.snapshot().stage === 'active', 'the follow picking up again');
  for (let i = 0; i < 3; i++) await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'following');
  assert.equal(f.mode.snapshot().intent, 'follow');
  assert.equal(states.some(entry => entry.text.includes('WORLD_CHANGED')), false, JSON.stringify(states));
  assert.equal(states.some(entry => entry.type === 'disconnect'), false);
  assert.deepEqual(f.fatal, []); assert.deepEqual(f.lost, []);
  assert.equal((await f.body.observe()).connected, true, 'the body is still under control');
});

test('a follow paused by hand adopts a later generation of the same session and resumes', async t => {
  const f = await fixture(t);
  await f.follow();
  await f.mode.request({ action: 'pause' });
  await f.body.stop();
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'paused', 'a stop of other work does not discard a manual pause');
  await f.mode.request({ action: 'resume' });
  await until(() => f.mode.snapshot().stage === 'active', 'following again');
  assert.deepEqual(f.fatal, []);
});

test('a discarded follow (WORLD_CHANGED) ends the follow only, not control of the body', async t => {
  const f = await fixture(t);
  await f.follow();
  // The follow's context no longer matches (here: another dimension without a new body session).
  f.mock.setState({ dimension: 'minecraft:the_nether' });
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'stopped');
  assert.equal(f.mode.snapshot().code, 'WORLD_CHANGED');
  for (let i = 0; i < 2; i++) await f.monitor.tick();
  assert.deepEqual(f.fatal, [], 'the monitor kept running');
  assert.deepEqual(f.lost, []);
  assert.equal(f.mock.calls.some(entry => entry.method === 'release'), false, 'the lease was not released');
  assert.equal((await f.body.observe()).connected, true);
});
