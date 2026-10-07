import type { Container, ItemStack, Observation, Operation } from './body.js';

/** Model projections never replace the authoritative snapshots used by action guards. */
function stackSummary(stack: ItemStack | Container['carried']) {
  const components = stack.components ?? {};
  return {
    ...('slot' in stack ? { slot: stack.slot } : {}), id: stack.id, count: stack.count,
    ...(stack.count > 0 && stack.maxStackSize !== undefined ? { maxStackSize: stack.maxStackSize } : {}),
    ...('mayPickup' in stack && stack.mayPickup === false ? { mayPickup: false } : {}),
    ...(stack.componentsComplete === false ? { componentsComplete: false, actionable: false, componentError: stack.componentError } : {}),
    hasComponents: Object.keys(components).length > 0,
    // Preserve a warning that stacks with the same registry ID need not be interchangeable.
    ...(Object.keys(components).length ? { componentsOmitted: true } : {}),
  };
}
export function summarizeContainer(container: Container | null) {
  if (!container) return null;
  const groups: Record<string, unknown[]> = { container: [], player: [], unknown: [] };
  for (const slot of container.slots) {
    if (!slot.count || ('active' in slot && slot.active === false)) continue;
    const provenance = slot as ItemStack & { source?: string; playerSlot?: number };
    const source = provenance.source === 'container' || provenance.source === 'player' ? provenance.source : 'unknown';
    groups[source].push({ ...stackSummary(slot), ...(provenance.playerSlot !== undefined ? { playerSlot: provenance.playerSlot } : {}) });
  }
  return { id: container.id, type: container.type, revision: container.revision, ...groups, cursor: stackSummary(container.carried) };
}
export function summarizeObservation(state: Observation) {
  return {
    sessionId: state.sessionId, worldId: state.worldId, instanceId: state.instanceId,
    controlGeneration: state.controlGeneration, source: state.source, connected: state.connected,
    ...(state.operationBudget ? { operationBudget: { ...state.operationBudget } } : {}),
    username: state.username, dimension: state.dimension, health: state.health, food: state.food,
    position: state.position, yaw: state.yaw, pitch: state.pitch, selectedSlot: state.selectedSlot,
    inventory: state.inventory.filter(stack => stack.count > 0).map(stackSummary),
    entities: state.entities.slice(0, 16), entitiesTruncated: state.entities.length > 16,
    ...(state.groundItems ? { groundItems: state.groundItems.map(item => ({ entityId: item.entityId, position: item.position, visibility: item.visibility, ...(item.onGround !== undefined ? { onGround: item.onGround } : {}), stack: stackSummary(item.stack) })), groundItemsTruncated: state.groundItemsTruncated } : {}),
    chat: state.chat.slice(-10), chatCursor: state.chatCursor,
    container: summarizeContainer(state.container), ...(state.block ? { block: state.block } : {}),
    ...(state.sleeping !== undefined ? { sleeping: state.sleeping } : {}), ...(state.time ? { time: state.time } : {}),
    details: 'Compact view. Exact guarded snapshots remain available from list-inventory/get-container or get-status details:true.',
  };
}
export function summarizeOperation(operation: Operation) {
  const result = operation.result && typeof operation.result === 'object' ? operation.result as Record<string, unknown> : undefined;
  const compact: Record<string, unknown> = {};
  if (result) {
    // Never copy an entire inventory, menu or component payload into every completion wake.
    for (const [key, value] of Object.entries(result)) {
      if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) && key !== 'components' && key !== 'targetToken') compact[key] = value;
    }
    if (result.block) compact.block = result.block;
    // Interaction receipts: the adapter's own facts (e.g. a pot's status) and what was gained are what the model acts on next.
    if (result.summary && typeof result.summary === 'object' && !Array.isArray(result.summary) && JSON.stringify(result.summary).length <= 2000) compact.summary = result.summary;
    if (Array.isArray(result.gained)) compact.gained = result.gained.slice(0, 16);
    // Workstation and travel receipts: what is missing, what changed, where the table/furnace is, where the body got to.
    for (const key of ['missing', 'inventoryChange', 'table', 'placedTable', 'furnace', 'skipped', 'position', 'station', 'subject', 'result', 'options', 'stages', 'levels', 'harvested', 'notPlanted', 'skippedWhy', 'crops', 'center', 'foodHeld', 'buckets'])
      if (result[key] && typeof result[key] === 'object' && JSON.stringify(result[key]).length <= 2000) compact[key] = result[key];
    // workstation-options answers: stations nearby, ways to make an item, item refs for modify-item.
    for (const key of ['stations', 'ways', 'subjects'])
      if (Array.isArray(result[key]) && JSON.stringify(result[key]).length <= 6000) compact[key] = result[key];
    if (result.container) compact.container = summarizeContainer(result.container as Container);
    if (Array.isArray(result.inventory)) compact.inventoryChanged = true;
    if (Array.isArray(result.items)) compact.items = result.items.slice(0, 64).map(value => {
      const item = value as Record<string, unknown>;
      return { item: item.item, count: item.count, variant: item.variant, ...(item.maxStackSize !== undefined ? { maxStackSize: item.maxStackSize } : {}) };
    });
    if (Array.isArray(result.items) && result.items.length > 64) compact.itemsTruncated = true;
  }
  return { operationId: operation.operationId, sessionId: operation.sessionId, controlGeneration: operation.controlGeneration,
    ...(operation.operationBudget ? { operationBudget: { ...operation.operationBudget } } : {}),
    name: operation.name, status: operation.status, summary: operation.summary,
    ...(result ? { result: compact, detailsAvailable: true } : {}) };
}
