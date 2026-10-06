import { BodyError, type Body, type Operation, type Position } from './body.js';

export type Face = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
export interface InteractBlockRequest extends Position { interaction: string; item?: string; emptyHand?: boolean; face?: Face; timeoutMs?: number }
/** Repeat the same interaction until the adapter summary field reaches a value (e.g. a pot's stirsLeft = 0). */
export interface RepeatUntil { field: string; equals: string | number | boolean; max: number; intervalMs: number }
export interface RepeatOutcome { attempts: number; reached: boolean; field: string; value: unknown }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = new Set(['succeeded', 'failed', 'unknown', 'cancelled']);

/**
 * Timing-sensitive repetition stays in the program instead of one model turn per click. Every attempt is a full
 * guarded interaction; the loop stops at the first receipt that is not succeeded, so unknown is never retried.
 */
export async function interactBlockRepeated(body: Body, request: InteractBlockRequest, repeat: RepeatUntil, taskToken?: string): Promise<{ operation: Operation; repeat: RepeatOutcome }> {
  let operation: Operation | undefined, value: unknown;
  for (let attempt = 1; attempt <= repeat.max; attempt++) {
    operation = await settle(body, await interactBlock(body, request, taskToken));
    const summary = (operation.result as { summary?: Record<string, unknown> } | undefined)?.summary;
    value = summary?.[repeat.field];
    if (operation.status !== 'succeeded') return { operation, repeat: { attempts: attempt, reached: false, field: repeat.field, value } };
    if (value !== undefined && String(value) === String(repeat.equals)) return { operation, repeat: { attempts: attempt, reached: true, field: repeat.field, value } };
    if (attempt < repeat.max) await sleep(repeat.intervalMs);
  }
  return { operation: operation!, repeat: { attempts: repeat.max, reached: false, field: repeat.field, value } };
}

async function settle(body: Body, operation: Operation): Promise<Operation> {
  const deadline = Date.now() + 10000;
  while (!TERMINAL.has(operation.status)) {
    if (Date.now() > deadline) return operation;
    await sleep(100);
    operation = await body.operation(operation.operationId);
  }
  return operation;
}

/**
 * One registered right-click on a block. Guards come from a fresh server observation; the model never
 * computes slots or copies components. The server still re-checks everything and decides the receipt.
 */
export async function interactBlock(body: Body, request: InteractBlockRequest, taskToken?: string): Promise<Operation> {
  if (!body.hello.capabilities.includes('use-item-on-block')) throw new BodyError('UNSUPPORTED', '身体没有声明手持物品使用能力');
  if (!body.hello.interactions?.includes(request.interaction)) throw new BodyError('UNSUPPORTED', `服务端没有登记交互 ${request.interaction}`);
  if ((request.item === undefined) === (request.emptyHand !== true)) throw new BodyError('INVALID_ARGUMENT', 'item 和 emptyHand 必须且只能给一个');
  const { x, y, z } = request;
  const state = await body.observe({ x, y, z });
  const block = state.block;
  if (!block || block.state !== 'loaded' || !block.id) throw new BodyError('UNLOADED', '目标方块所在区块没有加载');
  const target = { x, y, z, interaction: request.interaction, expectedBlock: block.id, expectedProperties: block.properties ?? {}, ...(request.face ? { face: request.face } : {}), ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}) };
  if (request.emptyHand) return body.act('use-item-on-block', { ...target, emptyHand: true }, taskToken);
  const matches = state.inventory.filter(stack => stack.id === request.item && stack.count > 0);
  const hotbar = matches.filter(stack => stack.slot >= 0 && stack.slot <= 8);
  if (!hotbar.length) throw new BodyError(matches.length ? 'NOT_IN_HOTBAR' : 'MISSING_ITEM', matches.length ? `${request.item} 不在快捷栏，先用 prepare-item 放到快捷栏` : `背包里没有 ${request.item}`);
  const chosen = hotbar.find(stack => stack.slot === state.selectedSlot) ?? hotbar[0];
  if (chosen.componentsComplete === false || !chosen.components) throw new BodyError('INCOMPLETE_GUARD', '这个物品的组件读不完整，不能安全使用');
  return body.act('use-item-on-block', { ...target, slot: chosen.slot, expectedItem: chosen.id, expectedCount: chosen.count, expectedComponents: chosen.components }, taskToken);
}
