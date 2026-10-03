/** The shared Body contract deliberately has no game-library or Agent types. */
export interface Position { x: number; y: number; z: number }
export type Components = Record<string, unknown>;
export interface ItemValue { id: string; count: number; components?: Components; maxStackSize?: number }
export interface ItemStack extends ItemValue { slot: number; source?: 'container' | 'player' | 'unknown'; playerSlot?: number; active?: boolean; mayPickup?: boolean }
export interface GroundItem { entityId: string; position: Position; stack: ItemValue; onGround?: boolean; visible?: boolean | null; visibility: 'visible' | 'occluded' | 'unknown' }
export interface CompanionGuard { player: string; expectedEntityId: string; maxDistance: number }
export interface PickupReceipt { seq: number; entityId: string; position: Position; stack: ItemValue; pickedUpCount: number; sessionId: string; controlGeneration: number; dimension: string }
export interface NearbyResources {
  instanceId: string; sessionId: string; worldId: string; dimension: string; controlGeneration: number; center: Position;
  candidates: Array<{ position: Position; id: string; properties: Components; targetToken: string; distance: number; visible: boolean; requiresCorrectTool: boolean; suitableToolSlots: number[]; recommendedToolSlot?: number }>;
  truncated?: boolean; budget?: unknown;
}
export interface NearbyBlocks {
  instanceId: string; sessionId: string; worldId: string; dimension: string; controlGeneration: number;
  center: { player: string; position: Position };
  candidates: Array<{ position: Position; id: string; properties: Components; targetToken?: string; distance: number; visibility: 'visible' | 'occluded' | 'unknown'; visible?: boolean | null }>;
  truncated?: boolean; budget?: unknown;
}
export interface Entity { id: string; type: string; name: string; position: Position }
export interface ChatLine { seq: number; time: number; username?: string; message: string }
export interface Container { id: string; type: string; revision?: number; slots: ItemStack[]; carried: ItemValue }
export interface BlockObservation { position: Position; state: 'loaded' | 'unloaded'; id?: string; properties?: Record<string, unknown> }
export interface Observation {
  sessionId: string; worldId: string; connected: boolean; username: string; dimension: string;
  health: number; food: number; position: Position; yaw: number; pitch: number;
  inventory: ItemStack[]; entities: Entity[]; chat: ChatLine[]; chatCursor: number;
  container: Container | null; block?: BlockObservation; source: 'client-observed' | 'server-observed';
  instanceId?: string; controlGeneration?: number; selectedSlot?: number;
  groundItems?: GroundItem[]; groundItemsTruncated?: boolean; pickupCursor?: number; pickupOldestCursor?: number; pickupReceipts?: PickupReceipt[];
}
export interface BodyHello {
  protocol: 1 | 2; backend?: 'client' | 'server'; instanceId?: string; worldId?: string;
  platform: { minecraft: string; loader: string; loaderVersion: string };
  capabilities: string[]; connected: boolean; username: string | null; sessionId: string | null;
}
export interface ActionArguments {
  'send-chat': { message: string };
  'look-at': Position;
  'move-to-position': Position & { tolerance?: number; timeoutMs?: number };
  'follow-player': { player: string; distance?: number; timeoutMs?: number };
  'follow-companion': { player: string; expectedEntityId: string; distance?: number };
  'approach-container': { targetToken: string; timeoutMs?: number };
  'approach-player': { player: string; expectedEntityId?: string; distance?: number; timeoutMs?: number };
  'approach-resource': { targetToken: string; timeoutMs?: number };
  'pickup-item': { entityId: string; expectedItem: string; expectedCount: number; expectedComponents: Components; expectedMaxStackSize?: number; companionGuard?: CompanionGuard; timeoutMs?: number };
  'dig-block': Position & { expectedBlock: string; expectedProperties?: Components; targetToken?: string; timeoutMs?: number };
  'place-block': Position & { face: 'up' | 'down' | 'north' | 'south' | 'east' | 'west'; slot: number; expectedItem: string; expectedBlock: string; expectedProperties?: Components; expectedCount?: number; expectedComponents?: Components; timeoutMs?: number };
  'open-container': Position & { expectedBlock: string; expectedProperties?: Components; targetToken?: string; timeoutMs?: number };
  'click-slot': { containerId: string; expectedRevision?: number; slot: number; expectedItem: string; expectedCount: number; expectedComponents?: Components; expectedCarriedItem: string; expectedCarriedCount: number; expectedCarriedComponents?: Components; button?: 0 | 1 };
  'close-container': { containerId: string; expectedRevision?: number };
  'select-slot': { slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components; expectedMaxStackSize?: number };
  'drop-item': { slot: number; expectedItem: string; expectedCount: number; expectedComponents: Components; expectedMaxStackSize?: number; count: number; recipient?: string; expectedEntityId?: string };
}
export type ActionName = keyof ActionArguments;
export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface Operation {
  operationId: string; sessionId: string; name: string; status: OperationStatus; summary: string; result?: unknown; controlGeneration?: number;
}
export interface Body {
  readonly hello: BodyHello;
  observe(block?: Position): Promise<Observation>;
  act<N extends ActionName>(name: N, args: ActionArguments[N], taskToken?: string): Promise<Operation>;
  nearbyBlocks?(options: { centerPlayer?: string; radius: number; maxResults: number }): Promise<NearbyBlocks>;
  nearbyResources?(options: { blockIds: string[]; radius: number; maxResults: number; center?: Position }): Promise<NearbyResources>;
  acquireTask?(taskToken: string): void;
  releaseTask?(taskToken: string): void;
  operation(operationId: string): Promise<Operation>;
  pendingOperations(): readonly Operation[];
  stop(): Promise<{ stopped: true }>;
  close(): Promise<void>;
}
export class BodyError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BodyError'; }
}
