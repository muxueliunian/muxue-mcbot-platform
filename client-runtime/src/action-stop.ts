import { BodyError, type Body } from './body.js';
import type { ContainerTasks } from './tasks.js';
import type { GatherTasks } from './gather-tasks.js';
import type { CompanionMode } from './companion-mode.js';
import type { SurvivalTasks } from './survival-tasks.js';

/** Shared stop barrier for explicit stops and program preemption; never resumes old intent. */
export function createActionStop(body: Body, tasks: ContainerTasks, gather: GatherTasks, companion?: CompanionMode, survival?: SurvivalTasks) {
  let revision = 0;
  return async (): Promise<{ stopped: true }> => {
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
  };
}
