import { forwardRef, type CSSProperties, type HTMLAttributes } from "react";
import { Bookmark, Bot, Check, CornerDownRight, ExternalLink, RotateCcw } from "lucide-react";
import { openExternal } from "../lib/open";
import type { Task } from "../lib/api";
import { useStore } from "../lib/store";
import { ago } from "../lib/time";
import { PriorityBadge, ProjectChip, StatusMenu } from "./ui";
import { PrChips } from "./PullRequests";
import { IssueChips } from "./Issues";

interface Props extends HTMLAttributes<HTMLDivElement> {
  task: Task;
  selected: boolean;
  dragging?: boolean;
  style?: CSSProperties;
}

export const TaskCard = forwardRef<HTMLDivElement, Props>(function TaskCard(
  { task, selected, dragging, style, ...rest },
  ref,
) {
  const { projectById, changeStatus, requestPark, openDrawer, setSelectedId, prsByTask, issuesByTask } = useStore();
  const prs = prsByTask.get(task.id);
  const issues = issuesByTask.get(task.id);
  const project = task.project_id != null ? projectById.get(task.project_id) : undefined;
  const done = task.status === "done";

  return (
    <div
      ref={ref}
      style={style}
      data-task-id={task.id}
      className={`group relative rounded-lg border bg-surface px-2.5 py-2 transition-shadow ${
        selected ? "border-accent shadow-[0_0_0_1px_var(--accent)]" : "border-line hover:border-faint/60"
      } ${dragging ? "z-10 opacity-90 shadow-lg" : ""}`}
      onClick={() => {
        setSelectedId(task.id);
        openDrawer(task.id);
      }}
      {...rest}
    >
      <div className="flex items-center gap-2">
        <StatusMenu status={task.status} onChange={(s) => void changeStatus(task, s)} />
        <PriorityBadge priority={task.priority} />
        <div className={`min-w-0 flex-1 truncate ${done ? "text-muted line-through decoration-faint" : ""}`}>
          {task.title}
        </div>

        {/* Hover actions */}
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
          {task.link && /^https?:\/\//.test(task.link) && (
            <IconBtn title="Open link" onClick={() => openExternal(task.link)}>
              <ExternalLink size={14} />
            </IconBtn>
          )}
          {!done && (
            <IconBtn title="Park — note where you left it (P)" onClick={() => requestPark(task)}>
              <Bookmark size={14} />
            </IconBtn>
          )}
          {done ? (
            <IconBtn title="Reopen" onClick={() => void changeStatus(task, "todo")}>
              <RotateCcw size={14} />
            </IconBtn>
          ) : (
            <IconBtn title="Done (D)" onClick={() => void changeStatus(task, "done")}>
              <Check size={14} />
            </IconBtn>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5 group-hover:hidden">
          {task.agent && (
            <span className="inline-flex max-w-36 items-center gap-1 truncate text-[12px] text-muted">
              <Bot size={12} className="shrink-0" />
              <span className="truncate">{task.agent}</span>
            </span>
          )}
          {project && <ProjectChip project={project} />}
          <span className="w-14 text-right text-[11px] text-faint" title="Last updated">
            {ago(done && task.completed_at ? task.completed_at : task.updated_at)}
          </span>
        </div>
      </div>
      {(prs?.length || issues?.length) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-8">
          {prs && <PrChips rows={prs} />}
          {issues && <IssueChips rows={issues} />}
        </div>
      )}
      {task.next_step && !done && (
        <div className="mt-1 flex items-start gap-1.5 pl-8 text-[13px] text-muted">
          <CornerDownRight size={13} className="mt-[3px] shrink-0 text-faint" />
          <span className="line-clamp-2">{task.next_step}</span>
        </div>
      )}
    </div>
  );
});

function IconBtn({ title, onClick, children }: { title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
