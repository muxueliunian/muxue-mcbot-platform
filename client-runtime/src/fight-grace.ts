import type { Body } from './body.js';

/**
 * Time the guard duty took the body away from a task the runtime times itself (gathering, container tasks): the task's
 * limit moves back by it, at most its own budget in all, as the server does for its own tasks
 * (docs/companion_state_design.md 5.2, capability guard-duty-tasks). Reads Body.fightMs, so it only grows as fast as
 * observations come in (the runtime monitor observes about twice a second).
 */
export class FightGrace {
  private seen: number;
  private used = 0;
  constructor(private readonly body: Pick<Body, 'fightMs'>, private readonly budget: number) { this.seen = body.fightMs?.() ?? 0; }
  /** Milliseconds to add to the limit since the last call. */
  take(): number {
    const total = this.body.fightMs?.() ?? 0;
    const granted = Math.max(0, Math.min(total - this.seen, this.budget - this.used));
    this.seen = Math.max(this.seen, total); this.used += granted;
    return granted;
  }
}

/** A grace only when the body counts fights on a server that interrupts its tasks for them. */
export function fightGrace(body: Body, budget: number): FightGrace | undefined {
  return body.fightMs && body.hello.capabilities.includes('guard-duty-tasks') ? new FightGrace(body, budget) : undefined;
}
