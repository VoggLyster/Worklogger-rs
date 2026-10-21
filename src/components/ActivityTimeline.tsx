import { Bookmark, CheckCircle2, CircleDot, CornerDownRight, GitPullRequest, MessageSquare, Pencil, Plus, RotateCcw, Signal, Trash2, Waypoints } from "lucide-react";
import type { Activity, ActivityKind } from "../lib/api";
import { describeActivity } from "../lib/meta";
import { fmtDayTime, fmtTime } from "../lib/time";

const ICONS: Record<ActivityKind, typeof Plus> = {
  created: Plus,
  status: Waypoints,
  priority: Signal,
  note: MessageSquare,
  parked: Bookmark,
  completed: CheckCircle2,
  reopened: RotateCcw,
  edited: Pencil,
  next_step: CornerDownRight,
  pr: GitPullRequest,
  issue: CircleDot,
};

export function ActivityTimeline({
  activity,
  timeOnly,
  onDeleteNote,
}: {
  activity: Activity[];
  timeOnly?: boolean;
  onDeleteNote?(id: number): void;
}) {
  if (!activity.length) return <div className="text-[13px] text-faint">No activity yet.</div>;
  return (
    <ol className="flex flex-col">
      {activity.map((a) => {
        const Icon = ICONS[a.kind] ?? Pencil;
        const hasBody = a.body && a.kind !== "created";
        const prominent = a.kind === "note" || a.kind === "parked" || a.kind === "next_step";
        const isPr = a.kind === "pr" || a.kind === "issue";
        return (
          <li key={a.id} className="group relative flex gap-2.5 py-1.5">
            <Icon size={14} className={`mt-[3px] shrink-0 ${prominent ? "text-accent" : "text-faint"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className={prominent ? "font-medium text-fg" : "text-muted"}>{describeActivity(a)}</span>
                <span className="text-faint">{timeOnly ? fmtTime(a.created_at) : fmtDayTime(a.created_at)}</span>
                {a.kind === "note" && onDeleteNote && (
                  <button
                    className="ml-auto hidden text-faint hover:text-fg group-hover:block"
                    title="Delete note"
                    onClick={() => onDeleteNote(a.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              {hasBody && !isPr && <div className="selectable mt-0.5 whitespace-pre-wrap text-[13px]">{a.body}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
