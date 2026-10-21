import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, GitPullRequest, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import type { Status, Task } from "../lib/api";
import { ACTIVE_SECTIONS, QUEUE_SECTIONS, STATUS } from "../lib/meta";
import { useStore } from "../lib/store";
import { COLLAPSE_KEY, loadCollapsed, sectionTasks } from "../lib/sections";
import { CaptureBar } from "../components/CaptureBar";
import { TaskCard } from "../components/TaskCard";
import { Spinner, StatusIcon } from "../components/ui";
import { PrInbox } from "../components/PullRequests";
import { ago } from "../lib/time";

const ALWAYS_SHOWN: Status[] = ["in_progress", "todo", "backlog"];

export function FocusView() {
  const { tasks, projectFilter, search } = useStore();
  const [collapsed, setCollapsed] = useState<Status[]>(loadCollapsed);
  const toggle = (s: Status) =>
    setCollapsed((c) => {
      const next = c.includes(s) ? c.filter((x) => x !== s) : [...c, s];
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });

  const column = (sections: Status[]) =>
    sections.map((s) => {
      const list = sectionTasks(tasks, s, projectFilter, search);
      if (!list.length && !ALWAYS_SHOWN.includes(s)) return null;
      return <Section key={s} status={s} tasks={list} collapsed={collapsed.includes(s)} onToggle={() => toggle(s)} />;
    });

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-5 pb-10 pt-4">
      <CaptureBar />
      <FilterBar />
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">{column(ACTIVE_SECTIONS)}</div>
        <div className="flex min-w-0 flex-col gap-4">
          {column(QUEUE_SECTIONS.slice(0, 1))}
          <PrInbox />
          {column(QUEUE_SECTIONS.slice(1))}
        </div>
      </div>
    </div>
  );
}

function FilterBar() {
  const { projects, projectFilter, setProjectFilter, search, setSearch, searchSignal } = useStore();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (Date.now() - searchSignal < 1000) ref.current?.focus();
  }, [searchSignal]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 focus-within:border-accent">
        <Search size={14} className="text-faint" />
        <input
          ref={ref}
          className="w-44 bg-transparent text-[13px] outline-none placeholder:text-faint"
          placeholder="Search  /"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearch("");
              ref.current?.blur();
            }
          }}
        />
        {search && (
          <button className="text-faint hover:text-fg" onClick={() => setSearch("")}>
            <X size={13} />
          </button>
        )}
      </div>
      <Chip active={projectFilter == null} onClick={() => setProjectFilter(null)}>
        All
      </Chip>
      {projects.map((p) => (
        <Chip key={p.id} active={projectFilter === p.id} onClick={() => setProjectFilter(projectFilter === p.id ? null : p.id)}>
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          {p.name}
        </Chip>
      ))}
      <GithubSync />
    </div>
  );
}

function GithubSync() {
  const { githubSync, refreshGithub, prs, issues } = useStore();
  if (!prs.length && !issues.length && !githubSync.error) return null;
  return (
    <button
      className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted hover:text-fg"
      onClick={() => void refreshGithub()}
      disabled={githubSync.busy}
      title={githubSync.error ?? "Refresh pull requests and issues from GitHub"}
    >
      {githubSync.error ? <TriangleAlert size={13} style={{ color: "var(--warn)" }} /> : <GitPullRequest size={13} />}
      {githubSync.busy ? <Spinner size={11} /> : <RefreshCw size={12} />}
      {githubSync.error ? "GitHub sync failed" : githubSync.at ? `GitHub synced ${ago(githubSync.at)}` : "Sync GitHub"}
    </button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] ${
        active ? "border-accent bg-accent-soft text-fg" : "border-line text-muted hover:text-fg"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Section({
  status,
  tasks,
  collapsed,
  onToggle,
}: {
  status: Status;
  tasks: Task[];
  collapsed: boolean;
  onToggle(): void;
}) {
  const { reorder, selectedId } = useStore();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const sortable = status !== "done";
  const meta = STATUS[status];

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = tasks.map((t) => t.id);
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    const moved = tasks[from];
    const target = tasks[to];
    // Sections sort by priority first, so dropping into another priority band adopts that priority.
    const priorityChange = moved.priority !== target.priority ? { id: moved.id, priority: target.priority } : undefined;
    void reorder(arrayMove(ids, from, to), priorityChange);
  };

  return (
    <section>
      <button className="mb-1.5 flex w-full items-center gap-2 px-1 text-left" onClick={onToggle}>
        <ChevronRight size={14} className={`text-faint transition-transform ${collapsed ? "" : "rotate-90"}`} />
        <StatusIcon status={status} size={14} />
        <span className="text-[13px] font-semibold">{meta.section}</span>
        <span className="text-[12px] text-faint">{tasks.length}</span>
      </button>
      {!collapsed &&
        (tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-3 py-3 text-[13px] text-faint">
            {status === "in_progress" ? "Nothing in progress. Pick something from Up next." : "Empty"}
          </div>
        ) : sortable ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1.5">
                {tasks.map((t) => (
                  <SortableCard key={t.id} task={t} selected={t.id === selectedId} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tasks.map((t) => (
              <TaskCard key={t.id} task={t} selected={t.id === selectedId} />
            ))}
          </div>
        ))}
    </section>
  );
}

function SortableCard({ task, selected }: { task: Task; selected: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <TaskCard
      ref={setNodeRef}
      task={task}
      selected={selected}
      dragging={isDragging}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      tabIndex={-1}
    />
  );
}
