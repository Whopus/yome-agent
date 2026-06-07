// Time-based trigger backed by node-cron.
//
// One node-cron task per registered TaskRecord with kind='cron'. When the
// schedule fires we spawn the runner OUT-OF-PROCESS (a child node process
// running `cli/bin/yome.js __run-task <id>`) so that:
//   - a crashing task can't take down the daemon
//   - we can enforce a wall-time budget by killing the child
//   - the LLM long-poll doesn't block the scheduler from firing other
//     tasks in parallel

import cron, { type ScheduledTask } from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { TaskRecord } from '../taskStore.js';
import { runChildTask } from './childRunner.js';

interface ActiveJob {
  task: TaskRecord;
  job: ScheduledTask;
  schedule: string;
  tz?: string;
}

const active = new Map<string, ActiveJob>();

export function registerCronTask(task: TaskRecord, opts: { yomeBinPath: string }): void {
  if (task.trigger.kind !== 'cron') return;
  if (!task.enabled) return;
  const schedule = task.trigger.schedule;
  const tz = task.trigger.tz;
  if (!cron.validate(schedule)) {
    // eslint-disable-next-line no-console
    console.error(`[cron] task ${task.id}: invalid schedule '${schedule}', skipping`);
    return;
  }

  // Idempotent re-register: tasks.json gets rewritten by recordRun()
  // every time ANY task fires, which triggers fs.watch →
  // reloadAllTasks() → registerCronTask for every cron task. Without
  // this guard each cron reload would tear down the node-cron
  // ScheduledTask (which has its own internal next-fire timer) and
  // build a fresh one, slightly drifting the firing wall-clock and
  // wasting CPU. When schedule + tz are unchanged, leave it alone —
  // node-cron's job already keeps a reference to the latest TaskRecord
  // via the closure, but the prompt/env can change so we update the
  // task pointer without touching the timer.
  const existing = active.get(task.id);
  if (existing && existing.schedule === schedule && existing.tz === tz) {
    existing.task = task;       // refresh prompt/env/allow rules
    return;
  }
  if (existing) {
    unregisterCronTask(task.id);
  }

  const job = cron.schedule(
    schedule,
    () => {
      // Always re-read the latest TaskRecord at fire time so any
      // mid-flight prompt/allow edits land in the spawned child.
      const latest = active.get(task.id)?.task ?? task;
      fireTask(task.id, opts.yomeBinPath, latest);
    },
    tz ? { timezone: tz } : undefined,
  );
  active.set(task.id, { task, job, schedule, tz });
  // eslint-disable-next-line no-console
  console.log(`[cron] registered ${task.id} (schedule="${schedule}", tz=${tz ?? 'local'})`);
}

export function unregisterCronTask(id: string): void {
  const entry = active.get(id);
  if (!entry) return;
  try { entry.job.stop(); } catch { /* noop */ }
  active.delete(id);
}

export function listActive(): string[] {
  return [...active.keys()];
}

export function unregisterAll(): void {
  for (const id of [...active.keys()]) unregisterCronTask(id);
}

/** Manually fire a task by id (used by `yome cron run <id>` and the scheduler). */
export function fireTask(taskId: string, yomeBinPath: string, task: TaskRecord): void {
  runChildTask({
    taskId,
    yomeBinPath,
    task,
    triggerMeta: { triggerKind: 'cron', schedule: (task.trigger as any).schedule },
  });
}

/**
 * Resolve the absolute path to bin/yome.js from this module's location.
 * Works whether the daemon is launched from source (tsx) or built dist/.
 */
export function resolveYomeBinPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist layout: dist/daemon/triggers/cron.js → ../../../bin/yome.js
  // src layout:  src/daemon/triggers/cron.ts  → ../../../bin/yome.js
  return resolve(here, '..', '..', '..', 'bin', 'yome.js');
}
