import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { observation } from './mock-control.mjs';

export const serverCapabilities = ['send-chat', 'look-at', 'move-to-position', 'follow-player'];
export async function mockServerControl(overrides = {}) {
  const calls = [];
  const operations = new Map();
  const token = 'server-test-bearer-private';
  const stopToken = 'server-test-stop-private';
  let state = observation({ source: 'server-observed', username: 'ServerBot', instanceId: 'instance-1', sessionId: 'server-session-1', controlGeneration: 0, selectedSlot: 0,
    inventory: [{ slot: 0, id: 'example:custom_block', count: 2, components: {} }] });
  let lease = null;
  let generation = 0;
  function active(params) {
    if (params.instanceId !== state.instanceId) throw Object.assign(new Error('instance changed'), { code: 'WRONG_INSTANCE' });
    if (params.sessionId !== state.sessionId) throw Object.assign(new Error('session changed'), { code: 'WORLD_CHANGED' });
    if (!lease || params.leaseId !== lease.leaseId) throw Object.assign(new Error('lost'), { code: 'LEASE_LOST' });
  }
  const handlers = {
    hello: () => ({ protocol: 2, backend: 'server', instanceId: state.instanceId, worldId: state.worldId, username: state.username, connected: Boolean(lease), sessionId: lease ? state.sessionId : null,
      platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.217' }, capabilities: serverCapabilities }),
    claim: params => {
      if (lease) throw Object.assign(new Error('busy'), { code: 'LEASE_BUSY' });
      lease = { leaseId: randomUUID(), stopToken, ttlMs: 10000, instanceId: state.instanceId, sessionId: state.sessionId, controlGeneration: generation, chatCursor: state.chatCursor };
      return lease;
    },
    heartbeat: params => { active(params); return { ttlMs: 10000, controlGeneration: generation }; },
    observe: params => { active(params); return { ...state, controlGeneration: generation, ...(params.block ? { block: { position: params.block, state: 'loaded', id: 'example:custom_block' } } : {}) }; },
    act: params => {
      active(params);
      if (params.controlGeneration !== generation) throw Object.assign(new Error('stale'), { code: 'STALE_CONTROL' });
      const op = { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: ['follow-player', 'move-to-position'].includes(params.name) ? 'running' : 'succeeded', summary: 'server result' };
      operations.set(params.operationId, op); return op;
    },
    operation: params => { active(params); return operations.get(params.operationId); },
    stop: params => {
      active(params); generation++;
      for (const [id, op] of operations) if (op.status === 'running') operations.set(id, { ...op, status: 'cancelled' });
      return { stopped: true, controlGeneration: generation };
    },
    release: params => { if (lease?.leaseId === params.leaseId) lease = null; return { released: true }; },
    revoke: params => { active(params); if (params.stopToken !== stopToken) throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }); lease = null; return { stopped: true, revoked: true }; },
    ...overrides,
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ method, params, authorization: request.headers.authorization });
    if (request.url !== '/v2' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    try {
      const result = await handlers[method](params, { request, response, operations, active });
      if (response.destroyed || response.writableEnded) return;
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, result }));
    } catch (error) { response.end(JSON.stringify({ ok: false, error: { code: error.code ?? 'MOCK_ERROR', message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = { protocol: 2, backend: 'server', endpoint: `http://127.0.0.1:${server.address().port}/v2`, token, worldId: 'test-world', username: 'ServerBot' };
  return {
    calls, connection, operations, handlers, stopToken,
    setState: next => { state = { ...state, ...next }; },
    setGeneration: next => { generation = next; },
    rpc: async (method, params) => { const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) }); return response.json(); },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
