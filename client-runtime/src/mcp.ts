import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { BodyError, type Body, type ActionArguments, type ActionName, type Observation } from './body.js';
import { EventJournal } from './events.js';
import { ContainerTasks } from './tasks.js';
import { CompanionMode } from './companion-mode.js';
import { GatherTasks } from './gather-tasks.js';
import { SurvivalTasks } from './survival-tasks.js';
import { SurvivalReflexes } from './survival-reflexes.js';
import { createActionStop } from './action-stop.js';
import { interactBlock } from './interactions.js';
import { summarizeOperation, summarizeObservation, summarizeContainer } from './model-view.js';

const coordinate = z.coerce.number().finite();
const xyz = { x: coordinate, y: coordinate, z: coordinate };
const blockXyz = { x: coordinate.int(), y: coordinate.int(), z: coordinate.int() };
const registryId = z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/).describe('Namespaced registry ID, for example minecraft:stone');
const timeoutMs = z.number().int().min(500).max(120000).optional();
/** chatFloor: ServerBody claim chatCursor; chat at or before it predates this control and is withheld from the model. */
export function createMcpServer(body: Body, events: EventJournal, options: { chatFloor?: number; companion?: CompanionMode; gather?: GatherTasks; tasks?: ContainerTasks; survival?: SurvivalTasks; reflexes?: SurvivalReflexes; stopCurrent?: () => Promise<{ stopped: true }> } = {}): McpServer {
  const server = new McpServer({ name: 'mcbot-client-runtime', version: '0.1.0' });
  const serverObserved = body.hello.backend === 'server';
  const tasks = options.tasks ?? new ContainerTasks(body, Date.now, operation => events.deliverOperation(operation));
  const gather = options.gather ?? new GatherTasks(body, events);
  const companion = body.hello.capabilities.includes('follow-companion') ? options.companion ?? new CompanionMode(body, events, gather) : undefined;
  const survival = options.survival ?? (['survival-state', 'swap-inventory', 'eat-item'].every(cap => body.hello.capabilities.includes(cap)) ? new SurvivalTasks(body, Date.now, operation => events.recordOperation(operation)) : undefined);
  const stopCurrent = options.stopCurrent ?? createActionStop(body, tasks, gather, companion, survival);
  const reflexes = options.reflexes ?? (survival ? new SurvivalReflexes(body, survival, events, { stopCurrent, ordinaryBusy: () => {
    try { tasks.assertIdle(); gather.assertIdle(); survival.assertIdle(); } catch { return true; }
    return body.isBusy?.() === true || body.pendingOperations().length > 0 || !!companion && !['idle', 'paused', 'stopped', 'blocked'].includes(companion.snapshot().state);
  } }) : undefined);
  if (survival && reflexes) gather.useSurvival(survival, () => reflexes.read());
  const readTools = new Set(['get-status', 'get-position', 'list-inventory', 'find-entity', 'read-chat', 'get-block', 'get-container', 'get-operation', 'get-companion-mode', 'wait-for-events', 'discover-resources', 'discover-containers', 'get-survival-state', 'assess-tool', 'send-chat', 'stop-action', 'set-reflexes', 'defend-self']);
  const publicOperation = (operation: import('./body.js').Operation) => {
    if (!operation.result || typeof operation.result !== 'object' || !('targetToken' in operation.result)) return operation;
    const { targetToken: _private, ...result } = operation.result as Record<string, unknown>;
    return { ...operation, result };
  };
  const operationResult = (operation: import('./body.js').Operation) => { events.deliverOperation(operation); const visible = publicOperation(operation); return serverObserved ? summarizeOperation(visible) : visible; };
  const observed = serverObserved ? 'server-observed' : 'client-observed';
  const navigation = body.hello.capabilities.includes('navigation-3d') ? 'loaded safe terrain including slabs, stairs, one-block jumps and bounded safe drops' : 'loaded safe level ground';
  const prediction = serverObserved ? ' Values come from the server authority.' : ' Values may include client prediction.';
  const completeComponents = z.record(z.unknown()).describe('Copy the complete components JSON object from the current observed stack; empty stack uses {}. Never omit or summarize fields.');
  const serverBlockGuard: ZodRawShape = serverObserved ? { expectedProperties: z.record(z.unknown()).describe('Copy the complete current block.properties object from get-block.') } : {};
  const serverStackGuard: ZodRawShape = serverObserved ? { expectedCount: z.number().int().nonnegative(), expectedComponents: completeComponents } : {};
  const serverRevision: ZodRawShape = serverObserved ? { expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('Current container.revision from get-container details:true; reobserve after every mutation.') } : {};
  const serverSlotComponents: ZodRawShape = serverObserved ? { expectedComponents: completeComponents, expectedCarriedComponents: completeComponents } : {};
  let eventCursor = 0;
  const currentChat = (chat: Observation['chat']) => options.chatFloor === undefined ? chat : chat.filter(line => line.seq > options.chatFloor!);
  const register = (name: string, description: string, shape: ZodRawShape, handler: (args: any) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: shape }, async args => {
      try {
        if (name === 'companion-mode' && args.mining) {
          if (!body.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '身体未声明持续陪挖保护，未降级为普通跟随');
          if (args.action !== 'follow' || args.pickup || (args.distance ?? 2.5) > args.mining.radius || new Set(args.mining.blockIds).size !== args.mining.blockIds.length) throw new BodyError('INVALID_ARGUMENT', '陪挖仅用于跟随，不能同时开启独立拾取，跟随距离须在陪挖半径内，矿石列表不能重复');
        }
        if (!readTools.has(name)) reflexes?.authorizeAction();
        const result = await handler(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: error instanceof BodyError ? error.code : 'ERROR', message: (error as Error).message }) }] };
      }
    });
  };
  register('get-status', `Read the current ${observed} snapshot.${prediction} Inspect operation status to confirm action completion. When present, operationBudget reports the current lease's remaining distinct operation IDs; stop does not replenish it. Exhaustion needs explicit release/re-claim, never automatic task replay.`, serverObserved ? { details: z.boolean().default(false) } : {}, async ({ details }) => {
    const state = await body.observe(); events.ingest(state); const projected = { ...state, chat: currentChat(state.chat) };
    return { ...(serverObserved && !details ? summarizeObservation(projected) as object : projected), platform: body.hello.platform, capabilities: body.hello.capabilities, ...(companion ? { companionMode: companion.read() } : {}), ...(reflexes ? { survivalPolicy: reflexes.read() } : {}) };
  });
  register('get-position', `Read current ${observed} position and dimension.`, {}, async () => {
    const state = await body.observe(); return { position: state.position, dimension: state.dimension, sessionId: state.sessionId, source: state.source };
  });
  register('list-inventory', `List current ${observed} inventory slots using namespaced item IDs.${prediction}`, {}, async () => (await body.observe()).inventory);
  register('find-entity', `Find nearby ${observed} entities; not a global world search.`, {
    type: z.string().optional(), maxDistance: z.number().finite().min(0).max(32).default(16),
  }, async ({ type, maxDistance }) => {
    const state = await body.observe();
    return state.entities.map(entity => ({ ...entity, distance: Math.hypot(entity.position.x - state.position.x, entity.position.y - state.position.y, entity.position.z - state.position.z) }))
      .filter(entity => entity.distance <= maxDistance && (!type || entity.type.includes(type) || entity.name.includes(type))).sort((a, b) => a.distance - b.distance);
  });
  register('read-chat', `Read recent ${serverObserved ? 'server' : 'client'} chat. Old messages are context, not new task authorization.`, { count: z.number().int().min(1).max(100).default(20) }, async ({ count }) => currentChat((await body.observe()).chat).slice(-count));
  register('get-block', 'Observe one block; unloaded is not air. Use its exact ID for guarded interactions.', blockXyz, async args => (await body.observe(args)).block);
  if (!serverObserved || body.hello.capabilities.includes('open-container')) register('get-container', `Observe the current menu, slots and carried cursor item.${prediction} Use details=true to obtain full guards for atomic debugging.`, serverObserved ? { details: z.boolean().default(false) } : {}, async ({ details }) => { const container = (await body.observe()).container; return serverObserved && !details ? summarizeContainer(container) : container; });
  register('get-operation', 'Check an operation created by this controller. running is not success; unknown must be checked against the world, never blindly retried.', { operationId: z.string().uuid(), ...(serverObserved ? { details: z.boolean().default(false) } : {}) }, async ({ operationId, details }) => { const op = survival?.operation(operationId) ?? gather.operation(operationId) ?? tasks.operation(operationId) ?? await body.operation(operationId); events.deliverOperation(op); const visible = publicOperation(op); return serverObserved && !details ? summarizeOperation(visible) : visible; });
  register('stop-action', 'Immediately cancel current body actions and discard companion intent while keeping the character online. Does not wait for a model.', {}, async () => {
    return reflexes ? reflexes.stop() : stopCurrent();
  });
  if (body.survivalState && body.hello.capabilities.includes('survival-state')) register('get-survival-state', 'Read current server survival facts, native dangers/threats when supported, active defense and effective program policy. Compact by default; details includes guarded inventory. Missing or incomplete threat facts do not establish safety. Reading never rearms stopped behavior.', { details: z.boolean().default(false) }, async args => ({ ...await body.survivalState!(args), ...(reflexes ? { policy: reflexes.read() } : {}) }));
  if (body.assessTool && body.hello.capabilities.includes('assess-tool')) register('assess-tool', 'Read-only whole-inventory tool eligibility and estimated base speed for a loaded block. Does not equip or dig. Unknown means not established; estimates exclude unobserved equip-dependent mod hooks. Actual native mining remains authoritative.', { ...blockXyz, expectedBlock: registryId.optional(), policy: z.enum(['fastest_valid', 'conserve_durability']).optional(), minRemainingDurability: z.number().int().min(0).max(10000).optional(), dropPreference: z.enum(['any', 'silk_touch', 'no_silk_touch']).default('any') }, async args => {
    const state = reflexes?.read(); const assessment = await body.assessTool!({ policy: state?.toolPolicy, minRemainingDurability: state?.minRemainingDurability, ...args });
    return { ...assessment, candidates: assessment.candidates.map(({ components: _components, ...candidate }) => ({ ...candidate, componentsOmitted: candidate.componentsComplete !== false })) };
  });
  if (survival) {
    register('prepare-item', 'Guardedly prepare the item currently in inventory slot 0..35 for use. Whole-stack native swap into hotbar, then select. Defaults to an empty hotbar slot; targetSlot explicitly permits swapping an occupied hotbar slot. Never discards or silently restores items.', { slot: z.number().int().min(0).max(35), targetSlot: z.number().int().min(0).max(8).optional() }, async args => operationResult(await survival.prepareItem(args)));
    register('eat-food', 'Consume exactly one safe food using native use duration and authoritative consumption confirmation. Optional slot refers to whole main inventory; otherwise choose food by hunger, saturation and protection policy. Unknown never retries. Auto food does not consume protected precious items.', { slot: z.number().int().min(0).max(35).optional(), timeoutMs }, async args => operationResult(await survival.eat({ ...args, policy: reflexes?.read() })));
  }
  if (reflexes && body.hello.capabilities.includes('defend-entity')) register('defend-self', 'One finite native defense using the same threat selection, policy, preparation and shared writer as automatic defense. Optional entityId restricts the current eligible hostile target; players, friendly, neutral and unknown targets are excluded. Stops ordinary work first, never pursues or resumes it. Low health and explosion preparation require safe retreat. Unknown remains blocked.', { entityId: z.string().uuid().optional() }, async ({ entityId }) => operationResult(await reflexes.defendSelf(entityId)));
  if (reflexes) register('set-reflexes', 'Change effective program policy with the current policy revision from get-survival-state. autoEat and supported autoDefend default on. armed:false disarms automatic behavior; armed:true explicitly rearms it. Hard stop disarms too. Reconfiguration first stops active tasks, so old policy cannot keep writing; it does not resume them. Defense takes priority over meals; each native action is bounded.', {
    expectedRevision: z.number().int().positive(), autoEat: z.boolean().optional(), armed: z.boolean().optional(), urgentFood: z.number().int().min(0).max(20).optional(), protectedItems: z.array(registryId).max(64).optional(), toolPolicy: z.enum(['fastest_valid', 'conserve_durability']).optional(), minRemainingDurability: z.number().int().min(0).max(10000).optional(),
    ...(body.hello.capabilities.includes('defend-entity') ? { autoDefend: z.boolean().optional(), defenseRadius: z.number().finite().min(1).max(3).optional(), lowHealth: z.number().finite().min(1).max(20).optional(), excludedEntityIds: z.array(z.string().uuid()).max(64).optional(), maxAttacks: z.number().int().min(1).max(3).optional(), defenseTimeoutMs: z.number().int().min(500).max(5000).optional() } : {}),
  }, args => reflexes.configure(args));
  if (companion) {
    register('companion-mode', `Start persistent follow of an explicitly named visible player on ${navigation}, or wait in place. Optional pickup only pursues listed drops. Optional mining requires companion-mining capability (${body.hello.capabilities.includes('companion-mining') ? 'available' : 'unavailable on this body'}): explicitly authorize a subset of six coal/iron/copper ores and a finite candidate-attempt budget. Each selected visible block is guarded against live player proximity and competing player mining, then mined and picked up before following resumes. No tunnels, support digging, arbitrary ores or automatic budget renewal. pickup and mining are mutually exclusive. maxBlocks caps attempted block candidates, not an item quantity promise; report confirmed mined blocks and native picked items separately, without claiming per-block drop provenance. Expiry/exhaustion disables mining but keeps following. pause/resume preserves used budget and the original deadline; unknown or blocked does not retry. Chat remains available. wait clears both options; stop-action discards intent. Only follow accepts player/distance/pickup/mining.`, {
      action: z.enum(['follow', 'wait', 'pause', 'resume']), player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(),
      distance: z.number().finite().min(1.5).max(6).optional(), say: z.string().min(1).max(256).optional(),
      ...(body.hello.capabilities.includes('companion-pickup') ? { pickup: z.object({ items: z.array(registryId).min(1).max(8), radius: z.number().finite().min(1.5).max(4).default(3) }).optional() } : {}),
      mining: z.object({
        blockIds: z.array(z.enum(['minecraft:coal_ore', 'minecraft:deepslate_coal_ore', 'minecraft:iron_ore', 'minecraft:deepslate_iron_ore', 'minecraft:copper_ore', 'minecraft:deepslate_copper_ore'])).min(1).max(6),
        maxBlocks: z.number().int().min(1).max(32).describe('Required finite candidate-attempt cap, chosen by the Agent and explained to the player. Not a target item count.'),
        radius: z.number().int().min(3).max(4).default(4), durationMs: z.number().int().min(10000).max(600000).default(300000),
      }).strict().optional(),
    }, async args => {
      if (args.mining && !body.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '身体未声明持续陪挖保护，未降级为普通跟随');
      tasks.assertIdle(); return companion.request(args);
    });
    register('get-companion-mode', 'Read the current persistent companion mode without starting, resuming or stopping any action.', {}, async () => companion.read());
  }
  register('wait-for-events', 'Read new chat and lifecycle events. Hosted agents should use timeoutSeconds 0 and end their turn when idle.', {
    timeoutSeconds: z.number().min(0).max(30).default(0), types: z.array(z.string()).optional(),
    ...(body.hello.capabilities.includes('send-chat') ? { say: z.string().min(1).max(256).optional() } : {}),
  }, async ({ timeoutSeconds, types, say }) => {
    const sent = say ? await body.act('send-chat', { message: say }) : undefined;
    eventCursor = Math.max(eventCursor, events.deliveredSeq());
    const found = await events.wait(eventCursor, timeoutSeconds * 1000, types);
    if (found.length) { eventCursor = found[found.length - 1].seq; events.markConsumed(eventCursor); }
    return { events: found, ...(sent ? { sent } : {}) };
  });
  const actions: Array<{ name: ActionName; description: string; schema: ZodRawShape }> = [
    { name: 'send-chat', description: `Send normal single-line chat, no slash commands. Success means ${serverObserved ? 'broadcast by the server' : 'handed to the client connection'}.`, schema: { message: z.string().min(1).max(256) } },
    { name: 'look-at', description: 'Turn toward a world position.', schema: xyz },
    { name: 'move-to-position', description: `Limited ordinary movement on ${navigation}, without teleporting or digging. Obstacles/hazards/timeouts fail. running means still moving; poll get-operation.`, schema: { ...xyz, tolerance: z.number().min(0.25).max(3).optional(), timeoutMs } },
    { name: 'follow-player', description: 'Follow a visible player for a finite time, using ordinary movement. running lasts until stopped, failed or timed out.', schema: { player: z.string().min(1).max(16), distance: z.number().min(1).max(8).optional(), timeoutMs } },
    { name: 'approach-player', description: 'Walk to a named nearby player using bounded safe routes on loaded level ground. expectedEntityId binds the UUID; a moved or missing recipient stops movement. running requires polling get-operation.', schema: { player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/), expectedEntityId: z.string().uuid().optional(), distance: z.number().min(1).max(1.5).optional(), timeoutMs } },
    { name: 'dig-block', description: `Dig exactly one authorized block in reach, after checking its exact state and line of sight. ${serverObserved ? 'Uses current selected tool with native survival timing and protection events; select-slot first when needed.' : 'unknown means server confirmation could not be established.'}`, schema: { ...blockXyz, expectedBlock: registryId, ...serverBlockGuard, timeoutMs } },
    { name: 'place-block', description: 'Use a hotbar block against the specified support block face. x/y/z identify the SUPPORT; target is its adjacent face. expectedBlock identifies that support, slot must be hotbar 0–8. unknown is not confirmed placement.', schema: { ...blockXyz, face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']), slot: z.number().int().min(0).max(8), expectedItem: registryId, expectedBlock: registryId, ...serverBlockGuard, ...serverStackGuard, timeoutMs } },
    { name: 'open-container', description: serverObserved ? 'Use native interaction to open a standard container in reach after checking full block state and line of sight. Special or remote menus may be unsupported.' : 'Normally interact with a standard container in reach and wait for its menu to open. Requires an empty hotbar slot; custom menus may be unsupported.', schema: { ...blockXyz, expectedBlock: registryId, ...serverBlockGuard, timeoutMs } },
    { name: 'click-slot', description: serverObserved ? 'One ordinary PICKUP click in the current menu; guard its ID, current revision, exact slot and carried item/count/full components from get-container details:true. Empty means minecraft:air, count 0, components {}. Reobserve before each next click. unknown is not confirmed transfer.' : 'One ordinary PICKUP click in the current client menu; guard its ID and exact slot/carried item/count from get-container. Empty means minecraft:air, count 0. unknown is not confirmed transfer.', schema: { containerId: z.string().min(1), ...serverRevision, ...serverSlotComponents, slot: z.number().int().min(0), expectedItem: registryId, expectedCount: z.number().int().min(0), expectedCarriedItem: registryId, expectedCarriedCount: z.number().int().min(0), button: z.union([z.literal(0), z.literal(1)]).optional() } },
    { name: 'close-container', description: serverObserved ? 'Close the currently matching menu after checking its current revision.' : 'Close the currently matching client menu.', schema: { containerId: z.string().min(1), ...serverRevision } },
    { name: 'select-slot', description: 'Select one hotbar slot 0–8 after verifying its complete current item/count/components. Does not move inventory items.', schema: { slot: z.number().int().min(0).max(8), expectedItem: registryId, expectedCount: z.number().int().nonnegative(), expectedComponents: completeComponents, expectedMaxStackSize: z.number().int().positive().optional() } },
    { name: 'drop-item', description: 'Drop an explicitly authorized count (1–64) from the CURRENT SELECTED hotbar slot through native drop actions. Verify item/count/full components from current inventory; count cannot exceed expectedCount. Dropped items remain physical world entities.', schema: { slot: z.number().int().min(0).max(8), expectedItem: registryId, expectedCount: z.number().int().nonnegative(), expectedComponents: completeComponents, expectedMaxStackSize: z.number().int().positive().optional(), count: z.number().int().min(1).max(64) } },
  ];
  const quantity = { item: registryId, count: z.number().int().min(1).max(256).optional().describe('Exactly one of count/stacks is required. Agent selects an explicit finite goal when user omitted it.'), stacks: z.number().int().min(1).max(256).optional().describe('Resolve from an actual selected stack maxStackSize; unknown does not mean 64. Maximum resolved goal 256, never truncated.'),
    say: z.string().min(1).max(256).optional(), maxSteps: z.number().int().min(1).max(256).default(64), timeoutMs: z.number().int().min(1000).max(120000).default(60000) };
  if (serverObserved && body.hello.capabilities.includes('pickup-item')) {
    register('collect-items', 'Finite pickup of the named item from currently observed ground entities within the fixed radius; never digs or expands the frozen UUID set. Native pickup receipts determine newly picked count, including honest overage. Chat remains available. Fails on receipt gaps, component/max changes or insufficient candidates; no automatic retry.', { ...quantity, radius: z.number().int().min(1).max(6).default(4) }, async args => { tasks.assertIdle(); return operationResult(await gather.start('collect-items', args)); });
    if (['nearby-resources', 'approach-resource', 'dig-block', 'select-slot'].every(cap => body.hello.capabilities.includes(cap))) {
      register('discover-resources', 'Freeze a finite loaded visible catalog of explicitly authorized vanilla stone/log blocks, plus coal_ore, iron_ore, copper_ore and their deepslate variants. Does not distinguish buildings from natural terrain; Agent must choose the authorized area. No arbitrary mod ores. One resourceRef represents this candidate set; no automatic rescan.', { blockIds: z.array(registryId).min(1).max(8), radius: z.number().int().min(1).max(6).default(4), maxResults: z.number().int().min(1).max(64).default(32) }, args => gather.discover(args));
      register('gather-resources', 'Finite newly picked item goal on one discovered candidate set: collect matching ground items in the authorized area, guarded select/approach/dig, then collect native drops. Coal/iron/copper ores target coal/raw_iron/raw_copper respectively; ore gathering requires a verified non-Silk-Touch tool. Fortune may produce honest overage. Actual picked count is distinct from blocks mined. No rescan beyond initial candidates. Requires exactly count or stacks; stacks binds an actual variant/max, possibly from the first authorized native drop. Chat continues; stop cancels, unknown never retries.', { ...quantity, resourceRef: z.string().uuid() }, async args => { tasks.assertIdle(); return operationResult(await gather.start('gather-resources', args)); });
    }
  }
  if (serverObserved && body.hello.capabilities.includes('nearby-blocks')) {
    if (body.hello.capabilities.includes('approach-container')) register('approach-container', 'Walk to a discovered container using its short-lived local reference and bounded safe routes on loaded level ground. Replacement or expiration fails. running requires polling get-operation.', { containerRef: z.string().uuid(), timeoutMs }, async ({ containerRef, timeoutMs }) => operationResult(await tasks.approachContainer(containerRef, timeoutMs)));
    register('discover-containers', 'Find bounded nearby loaded containers centered on the named player, or the bot when omitted. Contents are not read. Use the returned short-lived containerRef; ask when candidates are ambiguous.', {
      centerPlayer: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), radius: z.number().int().min(1).max(8).default(4), maxResults: z.number().int().min(1).max(16).default(8),
    }, args => tasks.discover(args));
    const target = { containerRef: z.string().uuid() };
    const itemCount = { item: registryId, count: z.number().int().min(1).max(256).optional().describe('Exactly one of count/stacks must be explicit. Individual item goal, maximum 256.'), stacks: z.number().int().min(1).max(256).optional().describe('Resolve using the selected actual stack maxStackSize; never assume 64. Goal still must fit one actual source/destination stack and at most 256 items.') };
    const recipient = { player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) };
    const say = { say: z.string().min(1).max(256).optional().describe('Your own natural single-line response, sent before starting the task.') };
    for (const task of [
      { name: 'container-list' as const, schema: { ...target, ...say }, description: 'Approach a referenced container when supported, open, list ONLY container items grouped by exact component variant, then close. Older bodies require reach and only guard block state. No NBT copying required.' },
      { name: 'container-withdraw' as const, schema: { ...target, ...itemCount, ...say }, description: 'Approach when supported, withdraw a count from one sufficient container stack into an empty hotbar slot and close. Reject component ambiguity. Routes are bounded loaded level ground; older bodies require reach with state-only guards.' },
      { name: 'give-item' as const, schema: { ...recipient, ...itemCount, ...say }, description: 'Bind the named player identity, approach when supported, look, select and drop from one sufficient hotbar stack. Older bodies require recipient within 2 blocks. Reject component ambiguity. Result means dropped; pickup remains unconfirmed.' },
      { name: 'fetch-and-give' as const, schema: { ...target, ...recipient, ...itemCount, ...say }, description: 'Approach container, guarded open/withdraw/close, return to the same recipient, look/select/drop in one task when approach capabilities exist. Routes are bounded loaded level ground. Older bodies require reach and only guard block state. Partial changes remain, unknown never retries, pickup remains unconfirmed.' },
    ]) {
      const required: ActionName[] = task.name === 'container-list' ? ['open-container', 'close-container'] : task.name === 'container-withdraw' ? ['open-container', 'click-slot', 'close-container'] : task.name === 'give-item' ? ['look-at', 'select-slot', 'drop-item'] : ['open-container', 'click-slot', 'close-container', 'look-at', 'select-slot', 'drop-item'];
      if (required.every(capability => body.hello.capabilities.includes(capability))) register(task.name, `${task.description} The whole task has a 90-second deadline including reads and actions; expiry stops further work and reports last confirmed progress. A complete source stack can move into a verified empty hotbar slot with ordinary pickup clicks; partial requests remain bounded.`, task.schema, async args => operationResult(await tasks.run(task.name, args)));
    }
  }
  const interactionIds = body.hello.interactions ?? [];
  if (serverObserved && body.hello.capabilities.includes('use-item-on-block') && interactionIds.length) register('interact-block', `Right-click one block in reach through a registered interaction: ${interactionIds.join(', ')}. Give exactly one of item (must be in hotbar; use prepare-item first) or emptyHand when the interaction requires it. Unregistered blocks or items are refused before any action. unknown is never retried; observe again.`, {
    ...blockXyz, interaction: z.enum(interactionIds as [string, ...string[]]), item: registryId.optional(), emptyHand: z.literal(true).optional(),
    face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional(), timeoutMs,
  }, async args => { tasks.assertIdle(); return operationResult(await interactBlock(body, args)); });
  for (const action of actions) {
    if (body.hello.capabilities.includes(action.name)) register(action.name, action.description, action.schema, async args => { if (action.name !== 'send-chat') tasks.assertIdle(); return operationResult(await body.act(action.name, args as ActionArguments[ActionName])); });
  }
  return server;
}
