import {
  Ban,
  Bot,
  CheckCircle2,
  Circle,
  CircleDashed,
  CirclePlay,
  Eye,
  type LucideIcon,
} from "lucide-react";
import type { Activity, Status } from "./api";

export interface StatusMeta {
  label: string;
  section: string;
  color: string;
  icon: LucideIcon;
}

export const STATUS: Record<Status, StatusMeta> = {
  in_progress: { label: "In progress", section: "In progress", color: "var(--st-progress)", icon: CirclePlay },
  waiting: { label: "Waiting on agent", section: "Waiting on agent", color: "var(--st-waiting)", icon: Bot },
  in_review: { label: "In review", section: "In review", color: "var(--st-review)", icon: Eye },
  blocked: { label: "Blocked", section: "Blocked", color: "var(--st-blocked)", icon: Ban },
  todo: { label: "Up next", section: "Up next", color: "var(--st-todo)", icon: Circle },
  backlog: { label: "Backlog", section: "Backlog", color: "var(--st-backlog)", icon: CircleDashed },
  done: { label: "Done", section: "Done today", color: "var(--st-done)", icon: CheckCircle2 },
};

/** Menu / cycling order. */
export const STATUS_ORDER: Status[] = ["todo", "in_progress", "waiting", "in_review", "blocked", "backlog", "done"];

/** Focus view columns. */
export const ACTIVE_SECTIONS: Status[] = ["in_progress", "waiting", "in_review", "blocked"];
export const QUEUE_SECTIONS: Status[] = ["todo", "backlog", "done"];

export const PRIORITY = [
  { label: "P0", name: "Urgent", color: "var(--p0)" },
  { label: "P1", name: "High", color: "var(--p1)" },
  { label: "P2", name: "Normal", color: "var(--p2)" },
  { label: "P3", name: "Low", color: "var(--p3)" },
];

/** Leaving `in_progress` for anything but done is a context switch: ask where it was left. */
export function needsPark(from: Status, to: Status): boolean {
  return from === "in_progress" && to !== "in_progress" && to !== "done";
}

const statusName = (v: unknown) => (typeof v === "string" && v in STATUS ? STATUS[v as Status].label : String(v));

export function describeActivity(a: Activity): string {
  switch (a.kind) {
    case "created":
      return "Created";
    case "status":
      return `${statusName(a.meta.from)} → ${statusName(a.meta.to)}`;
    case "priority":
      return `Priority P${a.meta.from} → P${a.meta.to}`;
    case "completed":
      return a.body ? `Completed — ${a.body}` : "Completed";
    case "reopened":
      return `Reopened → ${statusName(a.meta.to)}`;
    case "parked":
      return a.meta.from !== a.meta.to ? `Parked → ${statusName(a.meta.to)}` : "Parked";
    case "next_step":
      return "Next step";
    case "note":
      return "Note";
    case "pr":
    case "issue":
      return a.body;
    case "edited": {
      const f = Array.isArray(a.meta.fields) ? (a.meta.fields as string[]).join(", ") : "";
      return `Edited ${f}`;
    }
    default:
      return a.kind;
  }
}
