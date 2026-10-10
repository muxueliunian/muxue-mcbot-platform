/** The shared Body contract deliberately has no game-library or Agent types. */
export interface Position { x: number; y: number; z: number }
/** Snapshot of the current lease's distinct operation IDs; stop does not replenish it. */
export interface OperationBudget { used: number; remaining: number; limit: number; exhausted: boolean }
export type Components = Record<string, unknown>;
export interface ItemValue { id: string; count: number; components?: Components; maxStackSize?: number; componentsComplete?: boolean; componentError?: string }
export interface ItemStack extends ItemValue { slot: number; source?: 'container' | 'player' | 'unknown'; playerSlot?: number; active?: boolean; mayPickup?: boolean }
export interface GroundItem { entityId: string; position: Position; stack: ItemValue; onGround?: boolean; visible?: boolean | null; visibility: 'visible' | 'occluded' | 'unknown' }
export interface CompanionGuard { player: string; expectedEntityId: string; maxDistance: number }
export interface ResourceScanOptions { blockIds: string[]; radius: number; maxResults: number; center?: Position; wholeTree?: boolean; trees?: number; companionMiningGuard?: CompanionGuard }
export interface PickupReceipt { seq: number; entityId: string; position: Position; stack: ItemValue; pickedUpCount: number; sessionId: string; controlGeneration: number; dimension: string; /** A carried mod storage (e.g. a backpack) took the items instead of the inventory. */ storedIn?: string }
/** What a resource block is, by block tags (modded ones too). */
export type ResourceKind = 'log' | 'ore' | 'stone';
/** One item the block drops on this server (its loot table), whether it needs or forbids silk touch, and the least count per block. */
export interface ResourceDrop { item: string; preference: 'any' | 'silk_touch' | 'no_silk_touch'; least: number }
export interface NearbyResources {
  instanceId: string; sessionId: string; worldId: string; dimension: string; controlGeneration: number; center: Position;
  candidates: Array<{ position: Position; id: string; kind: ResourceKind; drops: ResourceDrop[]; properties: Components; targetToken: string; distance: number; visible: boolean; requiresCorrectTool: boolean; suitableToolSlots: number[]; recommendedToolSlot?: number; recommendedInventorySlot?: number; tree?: number }>;
  truncated?: boolean; budget?: unknown; wholeTree?: boolean;
}
export interface NearbyBlocks {
  instanceId: string; sessionId: string; worldId: string; dimension: string; controlGeneration: number;
  center: { player: string; position: Position };
  candidates: Array<{ position: Position; id: string; properties: Components; targetToken?: string; distance: number; visibility: 'visible' | 'occluded' | 'unknown'; visible?: boolean | null }>;
  truncated?: boolean; budget?: unknown;
}
export interface Entity { id: string; type: string; name: string; position: Position; sleeping?: boolean }
export interface FoodCandidate { slot: number; id: string; count: number; nutrition: number; saturationModifier: number; eatDurationTicks: number; safe: boolean; /** Valuable but safe food (golden apples): eat only when the player agrees or in an emergency. */ precious?: boolean; reason?: string }
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
  /** ServerBody: the body is lying in a bed; time of day (0..23999) and whether beds work now. */
  sleeping?: boolean; time?: { dayTime: number; canSleep: boolean };
  /** ServerBody: whether the sky is overhead (not underground or indoors), and the weather, for scene hints. */
  weather?: { natural: boolean; sky: boolean; raining: boolean; thundering: boolean };
  /** ServerBody: the guard duty, present while it is on. */
  guard?: GuardDutyState;
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
  /** Mods whose machines the server owner opened to generic item-handler access (machine-items); empty or absent = none. */
  itemHandlerMods?: string[];
  /** ServerBody: built-in gestures and add-on animation sources for the emote action. */
  emotes?: { builtin: string[]; sources: Array<{ id: string; hint: string }> };
  /** ServerBody: looks the hosting person can pick (set-appearance), with the choices the server offers. */
  appearances?: Array<{ id: string; choices: string[] }>;
  /** ServerBody: add-on usage notes; after plugin filtering only official plugins that are on (see plugins.ts). */
  hints?: Array<{ id: string; text: string }>;
}
/** What modify-item does to the referenced item; see the MCP tool for the fields each kind takes. */
export type ModifyAction = { kind: 'enchant' | 'anvil' | 'grind' | 'smith' | 'loom' | 'cartography'; option?: number; with?: string; rename?: string; template?: string; addition?: string; dye?: string; pattern?: string; patternItem?: string };
/** Companion guard: fight hostiles within `radius` of the followed player; back off at `lowHealth`. */
export interface GuardOptions { radius?: number; lowHealth?: number; bow?: boolean; shield?: boolean }
/** ServerBody guard duty (capability guard-duty): protecting one player, kept across operations and stops until turned off or the lease ends. */
export interface GuardDutyState {
  enabled: true; player: string; entityId: string; options?: Record<string, unknown>;
  /** Whether the duty can fight for the player right now; reason says why not (PLAYER_AWAY, TOO_FAR, BUSY, NO_CONTROL). */
  covering: boolean; reason?: string; returning?: boolean; busyMs: number;
  state: string; target?: string; targetId?: string; hits: number; kills: number; shots: number; retreats: number; damage: number;
}
export type GuardDutyRequest = { player: string; expectedEntityId: string; options?: GuardOptions } | { off: true };
export interface ActionArguments {
  'send-chat': { message: string };
  'look-at': Position;
  'move-to-position': Position & { tolerance?: number; timeoutMs?: number };
  'follow-player': { player: string; distance?: number; timeoutMs?: number };
  'follow-companion': { player: string; expectedEntityId: string; distance?: number; wander?: boolean; guard?: GuardOptions };
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
  'equip-item': { slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components };
  'sleep-in-bed': { player?: string; timeoutMs?: number };
  'wake-up': Record<string, never>;
  'craft-item': { item: string; count?: number; timeoutMs?: number };
  'smelt-item': { input?: string; count?: number; fuel?: string; wait?: boolean; furnace?: Position; timeoutMs?: number };
  'travel-to': { x: number; y?: number; z: number; tolerance?: number; timeoutMs?: number };
  'workstation-options': { item?: string; potion?: string; count?: number; subjects?: string };
  'produce-item': { item: string; count?: number; potion?: string; wait?: boolean; station?: Position; timeoutMs?: number };
  'modify-item': { subject: string; action: ModifyAction; preview?: boolean; maxLevels?: number; expect?: string; station?: Position; timeoutMs?: number };
  'build': { blocks: { x: number; y: number; z: number; state: string; rotation?: 0 | 90 | 180 | 270 }[]; replace?: 'none' | 'soft' | 'all'; dryRun?: boolean; timeoutMs?: number };
  'tend-crops': { survey?: boolean; player?: string; center?: Position; radius?: number; crops?: string[]; replant?: boolean; plant?: string; boneMeal?: number; till?: number; timeoutMs?: number };
  'use-bucket': Position & { action: 'pour' | 'scoop' };
  'machine-items': Position & { mode: 'list' | 'insert' | 'extract'; side?: 'up' | 'down' | 'north' | 'south' | 'east' | 'west'; item?: string; count?: number; slot?: number; expectedBlock?: string };
  'emote': { name: string; source?: string; player?: string; seconds?: number };
  'set-appearance': { source: string; choice: string };
  'hunt': { type: string; count?: number; survey?: boolean; player?: string; center?: Position; radius?: number; lowHealth?: number; timeoutMs?: number };
  'breed-animals': { animal: string; survey?: boolean; player?: string; center?: Position; radius?: number; food?: string; pairs?: number; timeoutMs?: number };
}
export type ActionName = keyof ActionArguments;
/** machine-status: a loaded machine's contents and progress; unloaded machines do not work (their time stands still). */
export interface MachineStatus {
  position: { x: number; y: number; z: number }; state: 'loaded' | 'unloaded'; id?: string; supported?: boolean; machine?: string;
  inputs?: { item: string; count: number }[]; results?: { item: string; count: number }[]; fuel?: { item: string; count: number } | null;
  working?: boolean; ticksLeft?: number; secondsLeft?: number; fuelTicks?: number; stalled?: boolean;
}
export type OperationStatus ='running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface Operation {
  operationId: string; sessionId: string; name: string; status: OperationStatus; summary: string; result?: unknown; controlGeneration?: number;
  operationBudget?: OperationBudget;
}
export interface StopOptions { clearGuard?: boolean }
export interface Body {
  readonly hello: BodyHello;
  observe(block?: Position): Promise<Observation>;
  act<N extends ActionName>(name: N, args: ActionArguments[N], taskToken?: string): Promise<Operation>;
  nearbyBlocks?(options: { centerPlayer?: string; radius: number; maxResults: number }): Promise<NearbyBlocks>;
  nearbyResources?(options: ResourceScanOptions): Promise<NearbyResources>;
  lookAround?(options?: { radius?: number }): Promise<Record<string, unknown>>;
  survivalState?(options?: { details?: boolean }): Promise<SurvivalState>;
  assessTool?(options: ToolAssessmentOptions): Promise<ToolAssessment>;
  machineStatus?(position: Position): Promise<MachineStatus>;
  /** Turn the standing guard duty on, change it, or off (capability guard-duty). Not an operation; a stop keeps it. */
  setGuard?(request: GuardDutyRequest): Promise<GuardDutyState | { enabled: false }>;
  /** ServerBody: total milliseconds guard duties held the body for fights so far, as of the last observation (only grows). */
  fightMs?(): number;
  acquireTask?(taskToken: string): void;
  releaseTask?(taskToken: string): void;
  operation(operationId: string): Promise<Operation>;
  pendingOperations(): readonly Operation[];
  isBusy?(): boolean;
  stop(options?: StopOptions): Promise<{ stopped: true }>;
  close(): Promise<void>;
}
export class BodyError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BodyError'; }
}
