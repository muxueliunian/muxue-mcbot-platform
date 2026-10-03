// 朝向控制权：谁现在可以转头。优先级从高到低：
// combat（本能反击、躲避）> work（正在执行移动/挖/放/脚本等身体动作）> observe > chat（说话时看人）> idle（空闲张望）
// 低优先级的转头在高优先级占用期间直接跳过，不抢视线
import { bodyBusy } from './task-control.js';

export type GazePriority = 'idle' | 'chat' | 'observe' | 'work' | 'combat';
const RANK: Record<GazePriority, number> = { idle: 0, chat: 1, observe: 2, work: 3, combat: 4 };

let holder: { priority: GazePriority; until: number } | null = null;

// 在一段时间内占用视线（例如反击时）
export function claimGaze(priority: GazePriority, ms: number): void {
  const now = Date.now();
  if (holder && holder.until > now && RANK[holder.priority] > RANK[priority]) return;
  holder = { priority, until: now + ms };
}

export function releaseGaze(priority: GazePriority): void {
  if (holder?.priority === priority) holder = null;
}

export function currentGaze(): GazePriority {
  if (holder && holder.until > Date.now()) return holder.priority;
  return bodyBusy() ? 'work' : 'idle';
}

// 这个优先级现在能不能转头
export function mayLook(priority: GazePriority): boolean {
  const now = Date.now();
  if (holder && holder.until > now && RANK[holder.priority] > RANK[priority]) return false;
  if (bodyBusy() && RANK[priority] < RANK.work) return false;
  return true;
}
