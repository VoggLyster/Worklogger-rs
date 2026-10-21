import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, errorMessage, type Activity, type Task } from "../lib/api";
import { useStore } from "../lib/store";
import { addDays, fmtDay, fromDateInput, startOfDay, toDateInput } from "../lib/time";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { SummaryPanel } from "../components/SummaryPanel";
import { PriorityBadge, ProjectChip, StatusIcon } from "../components/ui";

export function JournalView() {
  const { version, projectById, openDrawer, setError } = useStore();
  const [day, setDay] = useState(startOfDay);
  const [data, setData] = useState<{ activity: Activity[]; tasks: Task[] } | null>(null);
  const end = addDays(day, 1);
  const isToday = day === startOfDay();

  useEffect(() => {
    api.activityRange(day, end).then(setData).catch((e) => setError(errorMessage(e)));
  }, [day, end, version, setError]);

  // ← / → step through days.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (document.querySelector("[data-modal]")) return;
      if (e.key === "ArrowLeft") setDay((d) => addDays(d, -1));
      if (e.key === "ArrowRight") setDay((d) => Math.min(addDays(d, 1), startOfDay()));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const groups = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.tasks.map((t) => [t.id, t]));
    const map = new Map<number, Activity[]>();
    for (const a of data.activity) {
      if (!map.has(a.task_id)) map.set(a.task_id, []);
      map.get(a.task_id)!.push(a);
    }
    // Most recently touched first.
    return [...map.entries()]
      .map(([id, acts]) => ({ task: byId.get(id)!, acts }))
      .filter((g) => g.task)
      .sort((a, b) => b.acts[b.acts.length - 1].created_at - a.acts[a.acts.length - 1].created_at);
  }, [data]);

  const stats = useMemo(() => {
    const acts = data?.activity ?? [];
    return {
      completed: acts.filter((a) => a.kind === "completed").length,
      touched: groups.length,
      created: acts.filter((a) => a.kind === "created").length,
      notes: acts.filter((a) => a.kind === "note" || a.kind === "parked").length,
    };
  }, [data, groups]);

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-5 pb-10 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn px-2" onClick={() => setDay(addDays(day, -1))} title="Previous day (←)">
          <ChevronLeft size={16} />
        </button>
        <button className="btn px-2" disabled={isToday} onClick={() => setDay(addDays(day, 1))} title="Next day (→)">
          <ChevronRight size={16} />
        </button>
        <h1 className="ml-1 text-[18px] font-semibold">{isToday ? "Today" : fmtDay(day, { year: true })}</h1>
        {!isToday && (
          <button className="btn btn-ghost" onClick={() => setDay(startOfDay())}>
            Jump to today
          </button>
        )}
        <input
          type="date"
          className="field ml-auto w-40 py-1"
          value={toDateInput(day)}
          max={toDateInput(Date.now())}
          onChange={(e) => {
            const v = fromDateInput(e.target.value);
            if (v != null) setDay(v);
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Completed" value={stats.completed} />
        <Stat label="Tasks touched" value={stats.touched} />
        <Stat label="Created" value={stats.created} />
        <Stat label="Notes & parks" value={stats.notes} />
      </div>

      <SummaryPanel
        scope="day"
        from={day}
        to={end}
        label={fmtDay(day, { year: true })}
        empty={data != null && data.activity.length === 0}
      />

      <div className="flex flex-col gap-3">
        {groups.map(({ task, acts }) => {
          const project = task.project_id != null ? projectById.get(task.project_id) : undefined;
          return (
            <div key={task.id} className="rounded-xl border border-line bg-surface px-4 py-3">
              <button className="flex w-full items-center gap-2 text-left" onClick={() => openDrawer(task.id)}>
                <StatusIcon status={task.status} />
                <PriorityBadge priority={task.priority} />
                <span className="min-w-0 flex-1 truncate font-medium hover:underline">{task.title}</span>
                {project && <ProjectChip project={project} />}
              </button>
              <div className="mt-1.5 pl-1">
                <ActivityTimeline activity={acts} timeOnly />
              </div>
            </div>
          );
        })}
        {data && groups.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-faint">
            No activity on this day.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2">
      <div className="text-[20px] font-semibold tabular-nums">{value}</div>
      <div className="text-[12px] text-muted">{label}</div>
    </div>
  );
}
