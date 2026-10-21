// In-memory Backend used when the UI runs in a plain browser (vite dev without Tauri).
// Mirrors the Rust logic closely enough to preview and test the UI; seeded with demo data.
import type {
  Activity,
  ActivityKind,
  Backend,
  NewTask,
  PrRow,
  PrSnapshot,
  Project,
  SearchPr,
  Settings,
  Status,
  Summary,
  Task,
  TaskPatch,
} from "./api";
import { isMac } from "./hotkeys";

/** Fake snapshot so the PR UI can be previewed without GitHub. */
function demoSnapshot(repo: string, number: number, title: string, extra: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    repo, number, title, url: `https://github.com/${repo}/pull/${number}`, state: "OPEN", is_draft: false,
    author: "you", head: `feat/${number}`, base: "main", additions: 120, deletions: 30,
    updated_at: new Date().toISOString(), merged_at: null, review_decision: "REVIEW_REQUIRED", mergeable: "MERGEABLE",
    checks_state: "SUCCESS", checks: [{ name: "build", result: "SUCCESS", url: "" }], comment_count: 0, comments: [],
    reviews: [], threads: [], review_requests: [], viewer: "you", ...extra,
  };
}

export function createMemoryBackend(): Backend {
  let seq = 1;
  const id = () => seq++;
  const projects: Project[] = [];
  const tasks: (Task & { archived?: boolean })[] = [];
  const activity: Activity[] = [];
  const summaries: Summary[] = [];
  const prs: PrRow[] = [];
  const inbox: SearchPr[] = [];
  const settings: Settings = {};
  const defaultHotkey = isMac ? "cmd+alt+n" : "ctrl+alt+n";

  const log = (task_id: number, kind: ActivityKind, body = "", meta: Record<string, unknown> = {}, at = Date.now()) => {
    const a = { id: id(), task_id, kind, body, meta, created_at: at };
    activity.push(a);
    return a;
  };
  const find = (tid: number) => {
    const t = tasks.find((x) => x.id === tid);
    if (!t) throw new Error(`task ${tid} not found`);
    return t;
  };
  const ensureProject = (name: string): Project => {
    const p = projects.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (p) return p;
    const colors = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899"];
    const np = { id: id(), name: name.trim(), color: colors[projects.length % colors.length] };
    projects.push(np);
    return np;
  };
  const setStatus = (t: Task, to: Status, now: number) => {
    t.status = to;
    t.completed_at = to === "done" ? now : null;
  };
  const clone = <T,>(v: T): T => structuredClone(v);

  const backend: Backend = {
    async listTasks(doneSince) {
      return clone(
        tasks
          .filter((t) => !t.archived && (t.status !== "done" || (t.completed_at ?? 0) >= doneSince))
          .sort((a, b) => a.priority - b.priority || a.sort_order - b.sort_order),
      );
    },
    async getTask(tid) {
      return clone(find(tid));
    },
    async createTask(input: NewTask) {
      const now = Date.now();
      const status = input.status ?? "todo";
      const t: Task = {
        id: id(),
        title: input.title.trim(),
        description: input.description ?? "",
        status,
        priority: input.priority ?? 2,
        project_id: input.project_id ?? (input.project_name ? ensureProject(input.project_name).id : null),
        parent_id: null,
        agent: input.agent ?? "",
        link: input.link ?? "",
        next_step: input.next_step ?? "",
        sort_order: Math.min(0, ...tasks.map((x) => x.sort_order)) - 1,
        created_at: now,
        updated_at: now,
        completed_at: status === "done" ? now : null,
      };
      tasks.push(t);
      log(t.id, "created", t.title, { status, priority: t.priority });
      return clone(t);
    },
    async updateTask(tid, patch: TaskPatch) {
      const t = find(tid);
      const now = Date.now();
      const edited: string[] = [];
      for (const k of ["title", "description", "agent", "link"] as const) {
        if (patch[k] !== undefined && patch[k] !== t[k]) {
          t[k] = patch[k]!;
          edited.push(k);
        }
      }
      if (patch.project_id !== undefined && patch.project_id !== t.project_id) {
        t.project_id = patch.project_id;
        edited.push("project");
      }
      if (edited.length) log(tid, "edited", "", { fields: edited }, now);
      if (patch.next_step !== undefined && patch.next_step !== t.next_step) {
        t.next_step = patch.next_step.trim();
        if (t.next_step) log(tid, "next_step", t.next_step, {}, now);
      }
      if (patch.priority !== undefined && patch.priority !== t.priority) {
        log(tid, "priority", "", { from: t.priority, to: patch.priority }, now);
        t.priority = patch.priority;
      }
      if (patch.status && patch.status !== t.status) {
        const from = t.status;
        setStatus(t, patch.status, now);
        log(tid, patch.status === "done" ? "completed" : from === "done" ? "reopened" : "status", "", { from, to: patch.status }, now);
      }
      t.updated_at = now;
      return clone(t);
    },
    async parkTask(tid, nextStep, status) {
      const t = find(tid);
      const now = Date.now();
      const from = t.status;
      const to = status ?? from;
      if (to !== from) setStatus(t, to, now);
      t.next_step = nextStep.trim();
      t.updated_at = now;
      log(tid, to === "done" ? "completed" : "parked", t.next_step, { from, to }, now);
      return clone(t);
    },
    async reorderTasks(ids) {
      ids.forEach((tid, i) => (find(tid).sort_order = i));
    },
    async archiveTask(tid) {
      find(tid).archived = true;
    },
    async addNote(taskId, body) {
      find(taskId).updated_at = Date.now();
      return clone(log(taskId, "note", body.trim()));
    },
    async deleteNote(aid) {
      const i = activity.findIndex((a) => a.id === aid && a.kind === "note");
      if (i >= 0) activity.splice(i, 1);
    },
    async taskActivity(taskId) {
      return clone(activity.filter((a) => a.task_id === taskId).sort((a, b) => b.created_at - a.created_at || b.id - a.id));
    },
    async activityRange(from, to) {
      const acts = activity.filter((a) => a.created_at >= from && a.created_at < to).sort((a, b) => a.created_at - b.created_at);
      const ids = new Set(acts.map((a) => a.task_id));
      return clone({ activity: acts, tasks: tasks.filter((t) => ids.has(t.id)) });
    },
    async lastActivityAt() {
      return activity.length ? Math.max(...activity.map((a) => a.created_at)) : null;
    },
    async listProjects() {
      return clone(projects);
    },
    async ensureProject(name) {
      return clone(ensureProject(name));
    },
    async updateProject(pid, name, color) {
      const p = projects.find((x) => x.id === pid);
      if (!p) return;
      if (name) p.name = name;
      if (color) p.color = color;
    },
    async archiveProject(pid) {
      const i = projects.findIndex((x) => x.id === pid);
      if (i >= 0) projects.splice(i, 1);
      tasks.forEach((t) => t.project_id === pid && (t.project_id = null));
    },
    async getSettings() {
      return clone(settings);
    },
    async setSetting(key, value) {
      settings[key] = value;
    },
    async getSummary(scope, from) {
      return clone(summaries.filter((s) => s.scope === scope && s.from_ts === from).at(-1) ?? null);
    },
    async summarize(scope, from, to) {
      await new Promise((r) => setTimeout(r, 600));
      const s: Summary = {
        id: id(),
        scope,
        from_ts: from,
        to_ts: to,
        content_md:
          "Preview mode: summaries need the desktop app.\n\n### Where you left off\n- **Fix OAuth refresh** (waiting, claude) - review the agent's PR\n\n### Suggested first moves\n- Check the waiting agent first",
        created_at: Date.now(),
      };
      summaries.push(s);
      return clone(s);
    },
    async listPrs() {
      return clone(prs.filter((p) => !find(p.task_id).archived));
    },
    async linkPr(taskId, input) {
      const m = input.trim().match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) ?? input.trim().match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
      if (!m) throw new Error(`'${input.trim()}' isn't a GitHub pull request link`);
      const [repo, number] = [m[1], Number(m[2])];
      let row = prs.find((p) => p.task_id === taskId && p.repo === repo && p.number === number);
      if (!row) {
        const fromInbox = inbox.find((p) => p.repo === repo && p.number === number);
        row = {
          id: id(), task_id: taskId, repo, number, url: `https://github.com/${repo}/pull/${number}`,
          data: demoSnapshot(repo, number, fromInbox?.title ?? `Demo PR ${number}`, { is_draft: fromInbox?.is_draft ?? false }),
          fetched_at: Date.now(), fetch_error: null,
        };
        prs.push(row);
        log(taskId, "pr", `${repo}#${number}: linked`, { repo, number, event: "linked" });
      }
      return clone(row);
    },
    async unlinkPr(pid) {
      const i = prs.findIndex((p) => p.id === pid);
      if (i >= 0) prs.splice(i, 1);
    },
    async refreshPrs() {
      prs.forEach((p) => (p.fetched_at = Date.now()));
      return { prs: clone(prs), completed: [], error: null, skipped: false };
    },
    async untrackedPrs() {
      return clone(inbox.filter((i) => !prs.some((p) => p.repo === i.repo && p.number === i.number)));
    },
    async testGh() {
      throw new Error("Not available in browser preview");
    },
    async testClaude() {
      throw new Error("Not available in browser preview");
    },
    async hotkeyStatus() {
      return { combo: settings.hotkey || defaultHotkey, error: "Global hotkeys need the desktop app" };
    },
    async setHotkey(combo) {
      settings.hotkey = combo;
      return { combo: combo || defaultHotkey, error: "Global hotkeys need the desktop app" };
    },
  };

  // Demo data: yesterday's session.
  const H = 3_600_000;
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const y = base.getTime() - 24 * H;
  const web = ensureProject("web");
  const api = ensureProject("api");
  const seed = (title: string, status: Status, priority: number, p: Project | null, extra: Partial<Task>, at: number) => {
    const t: Task = {
      id: id(), title, description: "", status, priority, project_id: p?.id ?? null, parent_id: null,
      agent: "", link: "", next_step: "", sort_order: 0, created_at: at, updated_at: at,
      completed_at: status === "done" ? at + H : null, ...extra,
    };
    tasks.push(t);
    log(t.id, "created", title, {}, at);
    return t;
  };
  const a = seed("Fix OAuth token refresh", "waiting", 0, web, { agent: "claude · wt-auth", next_step: "Review the agent's PR, then run e2e login tests", link: "https://github.com/" }, y + 9 * H);
  log(a.id, "status", "", { from: "todo", to: "in_progress" }, y + 9.2 * H);
  log(a.id, "note", "Root cause: refresh token stored before rotation completes", {}, y + 11 * H);
  log(a.id, "parked", a.next_step, { from: "in_progress", to: "waiting" }, y + 16 * H);
  const b = seed("Product search is slow", "in_progress", 1, api, { next_step: "Profile the search query with 5k products", agent: "codex" }, y + 10 * H);
  log(b.id, "note", "Suspect missing index on vendor", {}, y + 14 * H);
  seed("Write migration guide for v2", "blocked", 2, web, { next_step: "Waiting on API freeze from Alex" }, y + 12 * H);
  seed("Rate limiter for the public API", "in_review", 1, api, { next_step: "Answer review comments from Alex" }, y + 12.5 * H);
  seed("Onboarding email copy", "todo", 1, web, {}, y + 13 * H);
  seed("Dark mode for settings page", "todo", 2, null, {}, y + 13.5 * H);
  seed("Investigate flaky CI on Windows", "backlog", 3, api, {}, y + 14 * H);
  const d = seed("Upgrade to React 19", "done", 2, web, {}, y + 15 * H);
  log(d.id, "completed", "", { from: "in_progress", to: "done" }, y + 17.5 * H);

  const iso = (ms: number) => new Date(ms).toISOString();
  prs.push({
    id: id(), task_id: a.id, repo: "acme/web", number: 412, url: "https://github.com/acme/web/pull/412",
    fetched_at: Date.now(), fetch_error: null,
    data: demoSnapshot("acme/web", 412, "fix(auth): rotate refresh token before persisting", {
      checks_state: "FAILURE",
      checks: [
        { name: "build", result: "SUCCESS", url: "https://github.com" },
        { name: "e2e (windows)", result: "FAILURE", url: "https://github.com" },
        { name: "lint", result: "SUCCESS", url: "https://github.com" },
      ],
      review_decision: "CHANGES_REQUESTED",
      review_requests: ["alex"],
      comment_count: 1,
      comments: [{ author: "alex", body: "Can we add a test for the **concurrent refresh** case?", created_at: iso(y + 15 * H), url: "c1" }],
      reviews: [{ author: "alex", state: "CHANGES_REQUESTED", body: "Close, but the retry loop can spin forever.", submitted_at: iso(y + 15 * H), url: "r1" }],
      threads: [
        { path: "src/auth/refresh.ts", line: 88, resolved: false, outdated: false, comments: [
          { author: "copilot-pull-request-reviewer", body: "This `while (true)` has no backoff or max attempts.", created_at: iso(y + 14 * H), url: "t1" },
          { author: "you", body: "Good catch, will cap it at 3.", created_at: iso(y + 14.5 * H), url: "t2" },
        ] },
        { path: "src/auth/store.ts", line: 12, resolved: false, outdated: false, comments: [
          { author: "alex", body: "Nit: name this `persistRotated`.", created_at: iso(y + 15 * H), url: "t3" },
        ] },
        { path: "src/auth/old.ts", line: null, resolved: true, outdated: true, comments: [] },
      ],
    }),
  });
  prs.push({
    id: id(), task_id: b.id, repo: "acme/api", number: 88, url: "https://github.com/acme/api/pull/88",
    fetched_at: Date.now(), fetch_error: null,
    data: demoSnapshot("acme/api", 88, "perf: add an index for product search", { is_draft: true, checks_state: "PENDING", review_decision: null }),
  });
  log(a.id, "pr", "acme/web#412: Checks failing: e2e (windows)", { event: "checks_failed" }, y + 16.5 * H);
  inbox.push(
    { repo: "acme/web", number: 415, title: "chore: bump vite to 8.3", url: "https://github.com/acme/web/pull/415", is_draft: false, updated_at: iso(y + 12 * H) },
    { repo: "acme/e2e-tests", number: 9, title: "Add a Safari smoke scenario", url: "https://github.com/acme/e2e-tests/pull/9", is_draft: true, updated_at: iso(y + 10 * H) },
  );

  return backend;
}
