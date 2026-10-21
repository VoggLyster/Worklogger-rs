// The single seam between UI and storage. The Tauri backend talks to Rust over IPC;
// a future web export can provide another `Backend` implementation.
import { invoke } from "@tauri-apps/api/core";
import { createMemoryBackend } from "./memoryBackend";

export type Status = "backlog" | "todo" | "in_progress" | "waiting" | "in_review" | "blocked" | "done";

export interface Task {
  id: number;
  title: string;
  description: string;
  status: Status;
  priority: number;
  project_id: number | null;
  parent_id: number | null;
  agent: string;
  link: string;
  next_step: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface Project {
  id: number;
  name: string;
  color: string;
}

export type ActivityKind =
  | "created"
  | "status"
  | "priority"
  | "note"
  | "parked"
  | "completed"
  | "reopened"
  | "edited"
  | "next_step"
  | "pr";

export interface Activity {
  id: number;
  task_id: number;
  kind: ActivityKind;
  body: string;
  meta: Record<string, unknown>;
  created_at: number;
}

export interface Summary {
  id: number;
  scope: "day" | "since";
  from_ts: number;
  to_ts: number;
  content_md: string;
  created_at: number;
}

export interface NewTask {
  title: string;
  description?: string;
  status?: Status;
  priority?: number;
  project_id?: number | null;
  project_name?: string;
  agent?: string;
  link?: string;
  next_step?: string;
}

export type TaskPatch = Partial<
  Pick<Task, "title" | "description" | "status" | "priority" | "project_id" | "agent" | "link" | "next_step">
>;

export type Settings = Partial<Record<SettingKey, string>>;
export type SettingKey = "claude_path" | "model" | "welcome_gap_hours" | "auto_recap" | "hotkey" | "gh_path";

export interface PrComment {
  author: string;
  body: string;
  created_at: string;
  url: string;
}

export interface PrSnapshot {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  is_draft: boolean;
  author: string;
  head: string;
  base: string;
  additions: number;
  deletions: number;
  updated_at: string;
  merged_at: string | null;
  review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  checks_state: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | null;
  checks: { name: string; result: string; url: string }[];
  comment_count: number;
  comments: PrComment[];
  reviews: { author: string; state: string; body: string; submitted_at: string; url: string }[];
  threads: { path: string; line: number | null; resolved: boolean; outdated: boolean; comments: PrComment[] }[];
  review_requests: string[];
  viewer: string;
}

export interface PrRow {
  id: number;
  task_id: number;
  repo: string;
  number: number;
  url: string;
  data: PrSnapshot | null;
  fetched_at: number | null;
  fetch_error: string | null;
}

export interface SearchPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  is_draft: boolean;
  updated_at: string;
}

export interface RefreshResult {
  prs: PrRow[];
  completed: number[];
  error: string | null;
  skipped: boolean;
}

export interface Backend {
  listTasks(doneSince: number): Promise<Task[]>;
  getTask(id: number): Promise<Task>;
  createTask(input: NewTask): Promise<Task>;
  updateTask(id: number, patch: TaskPatch): Promise<Task>;
  parkTask(id: number, nextStep: string, status?: Status): Promise<Task>;
  reorderTasks(ids: number[]): Promise<void>;
  archiveTask(id: number): Promise<void>;
  addNote(taskId: number, body: string): Promise<Activity>;
  deleteNote(id: number): Promise<void>;
  taskActivity(taskId: number): Promise<Activity[]>;
  activityRange(from: number, to: number): Promise<{ activity: Activity[]; tasks: Task[] }>;
  lastActivityAt(): Promise<number | null>;
  listProjects(): Promise<Project[]>;
  ensureProject(name: string): Promise<Project>;
  updateProject(id: number, name?: string, color?: string): Promise<void>;
  archiveProject(id: number): Promise<void>;
  getSettings(): Promise<Settings>;
  setSetting(key: SettingKey, value: string): Promise<void>;
  getSummary(scope: Summary["scope"], from: number): Promise<Summary | null>;
  summarize(scope: Summary["scope"], from: number, to: number, label: string): Promise<Summary>;
  testClaude(): Promise<string>;
  hotkeyStatus(): Promise<HotkeyStatus>;
  listPrs(): Promise<PrRow[]>;
  linkPr(taskId: number, input: string): Promise<PrRow>;
  unlinkPr(id: number): Promise<void>;
  refreshPrs(taskId?: number): Promise<RefreshResult>;
  untrackedPrs(): Promise<SearchPr[]>;
  testGh(): Promise<string>;
  setHotkey(combo: string): Promise<HotkeyStatus>;
}

export interface HotkeyStatus {
  combo: string;
  error: string | null;
}

const tauriBackend: Backend = {
  listTasks: (doneSince) => invoke("list_tasks", { doneSince }),
  getTask: (id) => invoke("get_task", { id }),
  createTask: (input) => invoke("create_task", { input }),
  updateTask: (id, patch) => invoke("update_task", { id, patch }),
  parkTask: (id, nextStep, status) => invoke("park_task", { id, nextStep, status: status ?? null }),
  reorderTasks: (ids) => invoke("reorder_tasks", { ids }),
  archiveTask: (id) => invoke("archive_task", { id }),
  addNote: (taskId, body) => invoke("add_note", { taskId, body }),
  deleteNote: (id) => invoke("delete_note", { id }),
  taskActivity: (taskId) => invoke("task_activity", { taskId }),
  activityRange: (from, to) => invoke("activity_range", { from, to }),
  lastActivityAt: () => invoke("last_activity_at"),
  listProjects: () => invoke("list_projects"),
  ensureProject: (name) => invoke("ensure_project", { name }),
  updateProject: (id, name, color) => invoke("update_project", { id, name: name ?? null, color: color ?? null }),
  archiveProject: (id) => invoke("archive_project", { id }),
  getSettings: () => invoke("get_settings"),
  setSetting: (key, value) => invoke("set_setting", { key, value }),
  getSummary: (scope, from) => invoke("get_summary", { scope, from }),
  summarize: (scope, from, to, label) => invoke("summarize", { scope, from, to, label }),
  testClaude: () => invoke("test_claude"),
  hotkeyStatus: () => invoke("hotkey_status"),
  listPrs: () => invoke("list_prs"),
  linkPr: (taskId, input) => invoke("link_pr", { taskId, input }),
  unlinkPr: (id) => invoke("unlink_pr", { id }),
  refreshPrs: (taskId) => invoke("refresh_prs", { taskId: taskId ?? null }),
  untrackedPrs: () => invoke("untracked_prs"),
  testGh: () => invoke("test_gh"),
  setHotkey: (combo) => invoke("set_hotkey", { combo }),
};

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const api: Backend = inTauri ? tauriBackend : createMemoryBackend();

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
