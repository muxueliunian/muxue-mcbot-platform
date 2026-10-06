import { BodyError, type Body, type Operation, type Position } from './body.js';

export type Face = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
export interface InteractBlockRequest extends Position { interaction: string; item?: string; emptyHand?: boolean; face?: Face; timeoutMs?: number }

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
