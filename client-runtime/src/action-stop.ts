import { BodyError, type Body } from './body.js';
import type { ContainerTasks } from './tasks.js';
import type { GatherTasks } from './gather-tasks.js';
import type { CompanionMode } from './companion-mode.js';
import type { SurvivalTasks } from './survival-tasks.js';

export type StopCurrent = (() => Promise<{ stopped: true }>) & { generation?: () => number };
/** Shared stop barrier for explicit stops and program preemption; never resumes old intent. */
export function createActionStop(body: Body, tasks: ContainerTasks, gather: GatherTasks, companion?: CompanionMode, survival?: SurvivalTasks): StopCurrent {
  let revision = 0;
  /** generation rises as soon as any stop starts, so tool calls admitted earlier can tell they were stopped. */
  return Object.assign(async (): Promise<{ stopped: true }> => {
    const owner = ++revision;
    const containers = tasks.cancel(), meal = survival?.cancel();
    gather.cancel();
    const result = await (companion ? companion.stop() : body.stop());
    if (result.stopped !== true) throw new BodyError('STOP_UNCONFIRMED', '身体停止未确认，保留旧任务锁');
    if (owner === revision) {
      tasks.stopped(containers); gather.stopped();
      if (meal !== undefined) survival!.stopped(meal);
    }
    return result;
  }, { generation: () => revision });
}
/** Reflex hooks around a follow: the server guard owns fighting, and a short reflex pauses the follow instead of discarding it. */
export function companionReflexHooks(tasks: ContainerTasks, gather: GatherTasks, companion?: CompanionMode) {
  return {
    guarding: () => companion?.guarding() === true,
    pauseCompanion: async () => {
      if (!companion || !['following', 'waiting'].includes(companion.snapshot().state)) return undefined;
      // Only a plain follow is paused; a container or gathering task still needs the full stop barrier.
      try { tasks.assertIdle(); gather.assertIdle(); } catch { return undefined; }
      await companion.request({ action: 'pause' });
      return async () => { if (companion.snapshot().state === 'paused') await companion.request({ action: 'resume' }); };
    },
  };
}