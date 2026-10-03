import http from 'node:http';

export const capabilities = ['send-chat', 'look-at', 'move-to-position', 'follow-player', 'dig-block', 'place-block', 'open-container', 'click-slot', 'close-container'];
export function container(overrides = {}) {
  return { id: 'world-session-1:1:1', type: 'minecraft:generic_9x3', slots: [{ slot: 0, id: 'example:custom_block', count: 2 }], carried: { id: 'minecraft:air', count: 0 }, ...overrides };
}
export function observation(overrides = {}) {
  return { sessionId: 'world-session-1', worldId: 'test-world', connected: true, username: 'ClientBot', dimension: 'minecraft:overworld', health: 20, food: 20,
    position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, inventory: [{ slot: 0, id: 'example:custom_block', count: 2 }],
    entities: [{ id: 'player-2', type: 'minecraft:player', name: 'Alex', position: { x: 2, y: 64, z: 0 } }],
    chat: [], chatCursor: 0, container: null, source: 'client-observed', ...overrides };
}
export async function mockControl(overrides = {}) {
  const calls = [];
  const operations = new Map();
  let state = observation();
  const token = 'test-token-not-for-real-use';
  const handlers = {
    hello: () => ({ protocol: 1, platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.217' }, capabilities, connected: true, username: 'ClientBot', sessionId: state.sessionId }),
    claim: () => ({ leaseId: 'test-lease', ttlMs: 10000 }),
    heartbeat: () => ({ ttlMs: 10000 }),
    release: () => ({ released: true }),
    observe: params => ({ ...state, ...(params.block ? { block: { position: params.block, state: 'loaded', id: 'example:custom_block' } } : {}) }),
    act: params => {
      const op = { operationId: params.operationId, sessionId: params.sessionId, name: params.name, status: ['follow-player', 'move-to-position'].includes(params.name) ? 'running' : 'succeeded', summary: 'mock result' };
      operations.set(params.operationId, op); return op;
    },
    operation: params => operations.get(params.operationId),
    stop: () => { for (const [id, op] of operations) if (op.status === 'running') operations.set(id, { ...op, status: 'cancelled' }); return { stopped: true }; },
    ...overrides,
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ method, params, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    try {
      const result = await handlers[method](params, { request, response, operations });
      if (response.destroyed || response.writableEnded) return;
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, result }));
    } catch (error) { response.end(JSON.stringify({ ok: false, error: { code: error.code ?? 'MOCK_ERROR', message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    connection: { protocol: 1, endpoint: `http://127.0.0.1:${server.address().port}/v1`, token }, calls, operations, handlers,
    setState: next => { state = next; },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
