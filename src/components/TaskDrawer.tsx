import { useEffect, useRef, useState } from "react";
import { Archive, Bookmark, ExternalLink, X } from "lucide-react";
import { openExternal } from "../lib/open";
import { api, errorMessage, type Activity, type Task, type TaskPatch } from "../lib/api";
import { submitShortcutLabel } from "../lib/hotkeys";
import { PRIORITY, STATUS, STATUS_ORDER } from "../lib/meta";
import { useStore } from "../lib/store";
import { fmtDayTime } from "../lib/time";
import { ActivityTimeline } from "./ActivityTimeline";
import { PrPanel } from "./PullRequests";

export function TaskDrawer() {
  const { drawerId, openDrawer, tasks } = useStore();
  const [fallback, setFallback] = useState<Task | null>(null);
  const fromList = tasks.find((t) => t.id === drawerId);

  // Tasks done before today aren't in the list; fetch them directly (e.g. opened from the Journal).
  useEffect(() => {
    setFallback(null);
    if (drawerId == null || fromList) return;
    api.getTask(drawerId).then(setFallback, () => setFallback(null));
  }, [drawerId, fromList]);

  const task = fromList ?? fallback;
  if (drawerId == null || !task) return null;
  return <DrawerBody key={task.id} task={task} onClose={() => openDrawer(null)} />;
}

function DrawerBody({ task, onClose }: { task: Task; onClose(): void }) {
  const { update, changeStatus, requestPark, archive, projects, version, setError } = useStore();
  const [activity, setActivity] = useState<Activity[]>([]);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.taskActivity(task.id).then(setActivity).catch((e) => setError(errorMessage(e)));
  }, [task.id, version, setError]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[data-modal]")) {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) el.blur();
        else onClose();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const save = (patch: TaskPatch) => void update(task.id, patch);

  const addNote = async () => {
    const body = note.trim();
    if (!body) return;
    try {
      await api.addNote(task.id, body);
      setNote("");
      setActivity(await api.taskActivity(task.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-30 flex w-[min(460px,100vw)] flex-col border-l border-line bg-surface shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-[12px] text-faint">#{task.id} · created {fmtDayTime(task.created_at)}</span>
        <div className="ml-auto flex items-center gap-1">
          {task.status !== "done" && (
            <button className="btn btn-ghost px-2" title="Park (P)" onClick={() => requestPark(task)}>
              <Bookmark size={14} /> Park
            </button>
          )}
          <button
            className="btn btn-ghost px-2"
            title="Archive (hides it everywhere except the journal)"
            onClick={() => void archive(task.id)}
          >
            <Archive size={14} />
          </button>
          <button className="btn btn-ghost px-1.5" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <BlurInput
          className="w-full bg-transparent text-[17px] font-semibold outline-none"
          value={task.title}
          onCommit={(title) => title.trim() && save({ title })}
        />

        <div className="mt-3 grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
          <Label>Status</Label>
          <select
            className="field py-1"
            value={task.status}
            onChange={(e) => void changeStatus(task, e.target.value as Task["status"])}
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS[s].label}
              </option>
            ))}
          </select>

          <Label>Priority</Label>
          <div className="flex gap-1">
            {PRIORITY.map((p, i) => (
              <button
                key={p.label}
                className={`h-7 flex-1 rounded-md border font-mono text-[12px] font-semibold ${
                  task.priority === i ? "border-current" : "border-line text-faint hover:text-fg"
                }`}
                style={task.priority === i ? { color: p.color } : undefined}
                onClick={() => save({ priority: i })}
                title={p.name}
              >
                {p.label}
              </button>
            ))}
          </div>

          <Label>Project</Label>
          <ProjectSelect value={task.project_id} onChange={(project_id) => save({ project_id })} projects={projects} />

          <Label>Agent</Label>
          <BlurInput
            className="field py-1"
            placeholder="e.g. Claude Code · worktree feat-x"
            value={task.agent}
            onCommit={(agent) => save({ agent })}
          />

          <Label>Link</Label>
          <div className="flex gap-1">
            <BlurInput
              className="field py-1"
              placeholder="PR, branch, path…"
              value={task.link}
              onCommit={(link) => save({ link })}
            />
            {/^https?:\/\//.test(task.link) && (
              <button className="btn px-2" title="Open" onClick={() => openExternal(task.link)}>
                <ExternalLink size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="mt-4">
          <PrPanel taskId={task.id} />
        </div>

        <div className="mt-4">
          <Label>Where I left off / next step</Label>
          <BlurTextarea
            className="field mt-1 min-h-16 border-accent/40 bg-accent-soft/40"
            placeholder="The very next concrete thing to do when you come back to this…"
            value={task.next_step}
            onCommit={(next_step) => save({ next_step })}
          />
        </div>

        <div className="mt-3">
          <Label>Description</Label>
          <BlurTextarea
            className="field mt-1 min-h-20"
            placeholder="Context, acceptance criteria, links…"
            value={task.description}
            onCommit={(description) => save({ description })}
          />
        </div>

        <div className="mt-5">
          <Label>Progress log</Label>
          <div className="mt-1 rounded-lg border border-line focus-within:border-accent">
            <textarea
              ref={noteRef}
              data-note
              className="block min-h-14 w-full resize-y bg-transparent px-2.5 py-2 text-[13px] outline-none placeholder:text-faint"
              placeholder={`Log progress, a decision, what the agent did…   (${submitShortcutLabel})`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void addNote();
                }
              }}
            />
            {note.trim() && (
              <div className="flex justify-end border-t border-line px-2 py-1.5">
                <button className="btn btn-primary py-1" onClick={() => void addNote()}>
                  Add note
                </button>
              </div>
            )}
          </div>
          <div className="mt-3">
            <ActivityTimeline
              activity={activity}
              onDeleteNote={async (id) => {
                await api.deleteNote(id);
                setActivity(await api.taskActivity(task.id));
              }}
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-medium text-muted">{children}</div>;
}

function ProjectSelect({
  value,
  onChange,
  projects,
}: {
  value: number | null;
  onChange(id: number | null): void;
  projects: { id: number; name: string }[];
}) {
  const { setError, refresh } = useStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const create = async () => {
    setCreating(false);
    if (!name.trim()) return;
    try {
      const p = await api.ensureProject(name);
      await refresh();
      onChange(p.id);
    } catch (err) {
      setError(errorMessage(err));
    }
    setName("");
  };

  if (creating)
    return (
      <input
        autoFocus
        className="field py-1"
        placeholder="New project name, Enter to create"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void create()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create();
          if (e.key === "Escape") {
            e.stopPropagation();
            setName("");
            setCreating(false);
          }
        }}
      />
    );

  return (
    <select
      className="field py-1"
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "__new") setCreating(true);
        else onChange(v === "" ? null : Number(v));
      }}
    >
      <option value="">No project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
      <option value="__new">+ New project…</option>
    </select>
  );
}

/** Input that keeps local state while focused and commits on blur / Enter. */
function BlurInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit(v: string): void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      {...rest}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(value);
      }}
    />
  );
}

function BlurTextarea({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit(v: string): void } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea
      {...rest}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}
