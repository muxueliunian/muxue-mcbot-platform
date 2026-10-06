/** The shared Body contract deliberately has no game-library or Agent types. */
export interface Position { x: number; y: number; z: number }
/** Snapshot of the current lease's distinct operation IDs; stop does not replenish it. */
export interface OperationBudget { used: number; remaining: number; limit: number; exhausted: boolean }
export type Components = Record<string, unknown>;
export interface ItemValue { id: string; count: number; components?: Components; maxStackSize?: number; componentsComplete?: boolean; componentError?: string }
export interface ItemStack extends ItemValue { slot: number; source?: 'container' | 'player' | 'unknown'; playerSlot?: number; active?: boolean; mayPickup?: boolean }
export interface GroundItem { entityId: string; position: Position; stack: ItemValue; onGround?: boolean; visible?: boolean | null; visibility: 'visible' | 'occluded' | 'unknown' }
export interface CompanionGuard { player: string; expectedEntityId: string; maxDistance: number }
export interface ResourceScanOptions { blockIds: string[]; radius: number; maxResults: number; center?: Position; companionMiningGuard?: CompanionGuard }
export interface PickupReceipt { seq: number; entityId: string; position: Position; stack: ItemValue; pickedUpCount: number; sessionId: string; controlGeneration: number; dimension: string; /** A carried mod storage (e.g. a backpack) took the items instead of the inventory. */ storedIn?: string }
export interface NearbyResources {
  instanceId: string; sessionId: string; worldId: string; dimension: string; controlGeneration: number; center: Position;
  candidates: Array<{ position: Position; id: string; properties: Components; targetToken: string; distance: number; visible: boolean; requiresCorrectTool: boolean; suitableToolSlots: number[]; recommendedToolSlot?: number; recommendedInventorySlot?: number }>;
  truncated?: boolean; budget?: unknown;
}
export interface NearbyBlocks {
  instanceId: string; sessionId: string; worldId: string; dimension: string; controlGeneration: number;
  center: { player: string; position: Position };
  candidates: Array<{ position: Position; id: string; properties: Components; targetToken?: string; distance: number; visibility: 'visible' | 'occluded' | 'unknown'; visible?: boolean | null }>;
  truncated?: boolean; budget?: unknown;
}
export interface Entity { id: string; type: string; name: string; position: Position }
export interface FoodCandidate { slot: number; id: string; count: number; nutrition: number; saturationModifier: number; eatDurationTicks: number; safe: boolean; reason?: string }
export interface Threat {
  entityId: string; type: string | null; classification: 'hostile' | 'attacking_self' | 'neutral' | 'friendly' | 'player' | 'unknown';
  hostilitySource: 'vanilla_hostile_allowlist' | 'native_target_self' | 'native_recent_attacker' | 'none' | 'unknown';
  targetingSelf: boolean | null; distance: number | null; lineOfSight: boolean | null; alive: boolean | null; explosionPreparing: boolean | null; defenseEligible: boolean; defenseReason: string | null; factsAvailable?: boolean;
}
export interface SurvivalDangers { onFire: boolean; inLava: boolean; inWater: boolean; air: number; maxAir: number; fallDistance: number; lowHealth: boolean; retreatRecommended: boolean }
export interface SurvivalState {
  instanceId: string; sessionId: string; worldId: string; dimension: string; controlGeneration: number;
  operationBudget?: OperationBudget;
  serverTick: number; observedAt: number; health: number; maxHealth: number; food: number; saturation: number; selectedSlot: number;
  inventory?: ItemStack[]; foods: FoodCandidate[];
  dangers?: SurvivalDangers; threats?: { radius: number; complete: boolean; nearby: Threat[]; serverTick: number };
}
export interface ToolAssessmentOptions extends Position {
  expectedBlock?: string; policy?: 'fastest_valid' | 'conserve_durability'; minRemainingDurability?: number; dropPreference?: 'any' | 'silk_touch' | 'no_silk_touch';
}
export interface ToolCandidate extends ItemStack {
  eligible: boolean | null; nativeEligible?: boolean; eligibilityBasis?: string; baseSpeed: number | null; estimatedTicks: number | null;
  remainingDurability: number | null; reason?: string; estimate: 'native-base' | 'estimated' | 'unknown';
  silkTouch?: number; fortune?: number; dropEffectsKnown?: boolean;
  recommendationEligible?: boolean; recommendationReason?: string;
}
export interface ToolAssessment {
  instanceId: string; sessionId: string; worldId: string; dimension: string; controlGeneration: number;
  position: Position; blockId: string; properties: Components; requiresCorrectTool: boolean; candidates: ToolCandidate[];
  recommendedSlot?: number; notes: string[];
}
export interface ChatLine { seq: number; time: number; username?: string; message: string }
export interface Container { id: string; type: string; revision?: number; slots: ItemStack[]; carried: ItemValue }
export interface BlockObservation { position: Position; state: 'loaded' | 'unloaded'; id?: string; properties?: Record<string, unknown> }
export interface Observation {
  sessionId: string; worldId: string; connected: boolean; username: string; dimension: string;
  health: number; food: number; position: Position; yaw: number; pitch: number;
  inventory: ItemStack[]; entities: Entity[]; chat: ChatLine[]; chatCursor: number;
  container: Container | null; block?: BlockObservation; source: 'client-observed' | 'server-observed';
  instanceId?: string; controlGeneration?: number; selectedSlot?: number;
  operationBudget?: OperationBudget;
  groundItems?: GroundItem[]; groundItemsTruncated?: boolean; pickupCursor?: number; pickupOldestCursor?: number; pickupReceipts?: PickupReceipt[];
}
export interface BodyHello {
  protocol: 1 | 2; backend?: 'client' | 'server'; instanceId?: string; worldId?: string;
  platform: { minecraft: string; loader: string; loaderVersion: string };
  capabilities: string[]; connected: boolean; username: string | null; sessionId: string | null;
  /** Registered held-item interaction IDs; only these may be sent with use-item-on-block / use-item. */
  interactions?: string[];
  /** The subset of interactions used in the air (use-item), e.g. opening a held backpack; the rest are block right-clicks. */
  itemInteractions?: string[];
  /** Mod container adapters the server has installed (e.g. ironfurnaces:iron_furnace); informational. */
  adapters?: string[];
}
export interface ActionArguments {
  'send-chat': { message: string };
  'look-at': Position;
  'move-to-position': Position & { tolerance?: number; timeoutMs?: number };
  'follow-player': { player: string; distance?: number; timeoutMs?: number };
  'follow-companion': { player: string; expectedEntityId: string; distance?: number; wander?: boolean };
  'approach-container': { targetToken: string; timeoutMs?: number };
  'approach-player': { player: string; expectedEntityId?: string; distance?: number; timeoutMs?: number };
  'approach-resource': { targetToken: string; timeoutMs?: number };
  'pickup-item': { entityId: string; expectedItem: string; expectedCount: number; expectedComponents: Components; expectedMaxStackSize?: number; companionGuard?: CompanionGuard; resourceTargetToken?: string; timeoutMs?: number };
  'dig-block': Position & { expectedBlock: string; expectedProperties?: Components; targetToken?: string; timeoutMs?: number };
  'place-block': Position & { face: 'up' | 'down' | 'north' | 'south' | 'east' | 'west'; slot: number; expectedItem: string; expectedBlock: string; expectedProperties?: Components; expectedCount?: number; expectedComponents?: Components; timeoutMs?: number };
  'open-container': Position & { expectedBlock: string; expectedProperties?: Components; targetToken?: string; timeoutMs?: number };
  'click-slot': { containerId: string; expectedRevision?: number; slot: number; expectedItem: string; expectedCount: number; expectedComponents?: Components; expectedCarriedItem: string; expectedCarriedCount: number; expectedCarriedComponents?: Components; button?: 0 | 1 };
  'close-container': { containerId: string; expectedRevision?: number };
  'select-slot': { slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components; expectedMaxStackSize?: number };
  'drop-item': { slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components; expectedMaxStackSize?: number; count: number; recipient?: string; expectedEntityId?: string };
  'swap-inventory': { sourceSlot: number; hotbarSlot: number; expectedSource: ItemValue; expectedTarget: ItemValue };
  'eat-item': { slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components; expectedMaxStackSize?: number; timeoutMs?: number };
  'defend-entity': { entityId: string; expectedDimension: string; maxDistance: number; minHealth: number; maxAttacks: number; timeoutMs: number; slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components; expectedMaxStackSize?: number };
  'retreat-from-entity': { entityId: string; expectedDimension: string; distance?: number; timeoutMs?: number };
  'use-item-on-block': Position & { interaction: string; expectedBlock: string; expectedProperties: Components; face?: 'up' | 'down' | 'north' | 'south' | 'east' | 'west'; timeoutMs?: number }
    & ({ emptyHand: true } | { slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components });
  'use-item': { interaction: string; slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components; timeoutMs?: number };
  'pillar-up': { slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components };
}
export type ActionName = keyof ActionArguments;
export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface Operation {
  operationId: string; sessionId: string; name: string; status: OperationStatus; summary: string; result?: unknown; controlGeneration?: number;
  operationBudget?: OperationBudget;
}
export interface Body {
  readonly hello: BodyHello;
  observe(block?: Position): Promise<Observation>;
  act<N extends ActionName>(name: N, args: ActionArguments[N], taskToken?: string): Promise<Operation>;
  nearbyBlocks?(options: { centerPlayer?: string; radius: number; maxResults: number }): Promise<NearbyBlocks>;
  nearbyResources?(options: ResourceScanOptions): Promise<NearbyResources>;
  lookAround?(options?: { radius?: number }): Promise<Record<string, unknown>>;
  survivalState?(options?: { details?: boolean }): Promise<SurvivalState>;
  assessTool?(options: ToolAssessmentOptions): Promise<ToolAssessment>;
  acquireTask?(taskToken: string): void;
  releaseTask?(taskToken: string): void;
  operation(operationId: string): Promise<Operation>;
  pendingOperations(): readonly Operation[];
  isBusy?(): boolean;
  stop(): Promise<{ stopped: true }>;
  close(): Promise<void>;
}
export class BodyError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BodyError'; }
}
