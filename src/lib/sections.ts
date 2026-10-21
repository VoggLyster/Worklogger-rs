import type { Status, Task } from "./api";
import { ACTIVE_SECTIONS, QUEUE_SECTIONS } from "./meta";

export const COLLAPSE_KEY = "worklogger.collapsed";

export function loadCollapsed(): Status[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '["backlog"]');
  } catch {
    return ["backlog"];
  }
}

/** Tasks for one Focus section, honouring filter and search, in display order. */
export function sectionTasks(tasks: Task[], status: Status, projectFilter: number | null, search: string): Task[] {
  const q = search.trim().toLowerCase();
  return tasks
    .filter((t) => t.status === status)
    .filter((t) => projectFilter == null || t.project_id === projectFilter)
    .filter(
      (t) =>
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.next_step.toLowerCase().includes(q) ||
        t.agent.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    )
    .sort((a, b) =>
      status === "done"
        ? (b.completed_at ?? 0) - (a.completed_at ?? 0)
        : a.priority - b.priority || a.sort_order - b.sort_order || a.id - b.id,
    );
}

/** Visual order of task ids, used for J/K navigation. */
export function visibleTaskIds(tasks: Task[], projectFilter: number | null, search: string): number[] {
  const collapsed = loadCollapsed();
  return [...ACTIVE_SECTIONS, ...QUEUE_SECTIONS]
    .filter((s) => !collapsed.includes(s))
    .flatMap((s) => sectionTasks(tasks, s, projectFilter, search).map((t) => t.id));
}
