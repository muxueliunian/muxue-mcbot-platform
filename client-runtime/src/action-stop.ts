import { BodyError, type Body, type StopOptions } from './body.js';
import type { ContainerTasks } from './tasks.js';
import type { GatherTasks } from './gather-tasks.js';
import type { CompanionMode } from './companion-mode.js';
import type { SurvivalTasks } from './survival-tasks.js';

export type StopCurrent = ((options?: StopOptions) => Promise<{ stopped: true }>) & {
  generation?: () => number;
  /** Same barrier for the work in progress, but a follow/wait that is stepping aside keeps its intent (reflex preemption, policy changes). */
  keepCompanion?: () => Promise<{ stopped: true }>;
};
/** Shared stop barrier for explicit stops and program preemption; never resumes old intent. */
export function createActionStop(body: Body, tasks: ContainerTasks, gather: GatherTasks, companion?: CompanionMode, survival?: SurvivalTasks): StopCurrent {
  let revision = 0;
  const barrier = (stopBody: (options?: StopOptions) => Promise<{ stopped: true }>) => async (options?: StopOptions): Promise<{ stopped: true }> => {
    const owner = ++revision;
    const containers = tasks.cancel(), meal = survival?.cancel();
    gather.cancel();
    const result = await stopBody(options);
    if (result.stopped !== true) throw new BodyError('STOP_UNCONFIRMED', '身体停止未确认，保留旧任务锁');
    if (owner === revision) {
      tasks.stopped(containers); gather.stopped();
      if (meal !== undefined) survival!.stopped(meal);
    }
    return result;
  };
  /** generation rises as soon as any stop starts, so tool calls admitted earlier can tell they were stopped. */
  return Object.assign(barrier(options => companion ? companion.stop(undefined, options) : body.stop(options)), { generation: () => revision, keepCompanion: barrier(() => companion ? companion.stopWork() : body.stop()) });
}
/** Reflex hooks around a follow: the server guard owns fighting, and a short reflex steps the follow aside instead of discarding it. */
export function companionReflexHooks(tasks: ContainerTasks, gather: GatherTasks, companion?: CompanionMode, stopWork?: () => Promise<{ stopped: true }>, survival?: SurvivalTasks, bodyBusy?: () => boolean) {
  return {
    guarding: () => companion?.guarding() === true,
    pauseCompanion: async (reason = 'reflex') => {
      if (!companion) return undefined;
      const now = companion.snapshot();
      if (!(['following', 'waiting'].includes(now.state) || (now.state === 'paused' && now.suspendedFor))) return undefined;
      // Work that is still running (a gather or meal while the follow stood aside) must be cancelled first, and the follow outlives that.
      let busy = bodyBusy?.() === true;
      try { tasks.assertIdle(); gather.assertIdle(); survival?.assertIdle(); } catch { busy = true; }
      if (busy && !stopWork) return undefined;
      const lease = await companion.yieldTo(reason);
      if (busy) { try { await stopWork!(); } catch (error) { lease.hold(); throw error; } }
      return Object.assign(() => lease.release(), { hold: () => lease.hold() });
    },
  };
}
