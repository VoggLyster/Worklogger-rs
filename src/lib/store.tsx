import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  errorMessage,
  type IssueRow,
  type LinkResult,
  type PrRow,
  type Project,
  type SearchIssue,
  type SearchPr,
  type Settings,
  type SettingKey,
  type Status,
  type Task,
  type TaskPatch,
} from "./api";
import { groupByTask, isGithubRef, parseHiddenRepos } from "./pr";
import { needsPark } from "./meta";
import { parseCapture } from "./parseCapture";
import { startOfDay } from "./time";

export type View = "focus" | "journal";

export interface RecapWindow {
  from: number;
  to: number;
  lastAt: number;
}

interface Store {
  tasks: Task[];
  projects: Project[];
  projectById: Map<number, Project>;
  settings: Settings;
  loaded: boolean;
  /** Bumped after every mutation so views showing activity can refetch. */
  version: number;

  view: View;
  setView(v: View): void;
  selectedId: number | null;
  setSelectedId(id: number | null): void;
  drawerId: number | null;
  openDrawer(id: number | null): void;
  parkRequest: { task: Task; status: Status } | null;
  requestPark(task: Task, status?: Status): void;
  closePark(): void;
  recap: RecapWindow | null;
  recapOpen: boolean;
  setRecapOpen(open: boolean): void;
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  helpOpen: boolean;
  setHelpOpen(open: boolean): void;
  projectFilter: number | null;
  setProjectFilter(id: number | null): void;
  search: string;
  setSearch(s: string): void;
  /** Timestamps of the last "focus capture / search" request; fields focus when one is fresh. */
  captureSignal: number;
  focusCapture(): void;
  searchSignal: number;
  focusSearch(): void;

  error: string | null;
  setError(e: string | null): void;

  prs: PrRow[];
  prsByTask: Map<number, PrRow[]>;
  issues: IssueRow[];
  issuesByTask: Map<number, IssueRow[]>;
  githubSync: { at: number | null; busy: boolean; error: string | null };
  refreshGithub(taskId?: number): Promise<void>;
  /** Link a PR or issue (URL or owner/repo#123). */
  linkGithub(taskId: number, input: string): Promise<boolean>;
  unlinkPr(id: number): Promise<void>;
  unlinkIssue(id: number): Promise<void>;
  /** Issue picker; `taskId` set when opened to link issues to that task. */
  issuePicker: { taskId: number | null } | null;
  openIssuePicker(taskId?: number | null): void;
  closeIssuePicker(): void;
  createTaskFromIssue(issue: SearchIssue): Promise<void>;
  /** Lower-cased "owner/repo" hidden from the PR inbox and issue picker. */
  hiddenRepos: Set<string>;
  setRepoHidden(repo: string, hidden: boolean): Promise<void>;
  /** The user's open PRs not linked to a task (null until loaded). */
  untracked: SearchPr[] | null;
  untrackedError: string | null;
  createTaskFromPr(pr: SearchPr): Promise<void>;

  capture(text: string): Promise<Task | null>;
  update(id: number, patch: TaskPatch): Promise<void>;
  changeStatus(task: Task, status: Status): Promise<void>;
  park(id: number, nextStep: string, status?: Status): Promise<void>;
  reorder(ids: number[], priorityChange?: { id: number; priority: number }): Promise<void>;
  archive(id: number): Promise<void>;
  saveSetting(key: SettingKey, value: string): Promise<void>;
  refresh(): Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const [view, setView] = useState<View>("focus");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [parkRequest, setParkRequest] = useState<Store["parkRequest"]>(null);
  const [recap, setRecap] = useState<RecapWindow | null>(null);
  const [recapOpen, setRecapOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [captureSignal, setCaptureSignal] = useState(0);
  const [searchSignal, setSearchSignal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [prs, setPrs] = useState<PrRow[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [issuePicker, setIssuePicker] = useState<Store["issuePicker"]>(null);
  const [githubSync, setGithubSync] = useState<Store["githubSync"]>({ at: null, busy: false, error: null });
  const [untracked, setUntracked] = useState<SearchPr[] | null>(null);
  const [untrackedError, setUntrackedError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [t, p] = await Promise.all([api.listTasks(startOfDay()), api.listProjects()]);
    setTasks(t);
    setProjects(p);
    setVersion((v) => v + 1);
  }, []);

  // Wrap every mutation: run, refresh, surface errors.
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        const r = await fn();
        await refresh();
        return r;
      } catch (e) {
        setError(errorMessage(e));
        return null;
      }
    },
    [refresh],
  );

  const loadUntracked = useCallback(async () => {
    try {
      setUntracked(await api.untrackedPrs());
      setUntrackedError(null);
    } catch (e) {
      setUntrackedError(errorMessage(e));
    }
  }, []);

  const refreshGithub = useCallback(
    async (taskId?: number) => {
      setGithubSync((p) => ({ ...p, busy: true }));
      try {
        const r = await api.refreshGithub(taskId);
        setPrs(r.prs);
        setIssues(r.issues);
        if (r.skipped) setGithubSync((p) => ({ ...p, busy: false }));
        else setGithubSync({ at: Date.now(), busy: false, error: r.error });
        // PR events land in the activity log and may have completed tasks.
        await refresh();
      } catch (e) {
        setGithubSync({ at: Date.now(), busy: false, error: errorMessage(e) });
      }
      if (taskId == null) void loadUntracked();
    },
    [refresh, loadUntracked],
  );

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const recapOpenRef = useRef(recapOpen);
  recapOpenRef.current = recapOpen;
  const githubSyncRef = useRef(githubSync);
  githubSyncRef.current = githubSync;

  /** Set the recap window, and open it if the user has been away longer than the configured gap. */
  const checkWelcomeBack = useCallback((lastAt: number | null) => {
    if (lastAt == null) return;
    const now = Date.now();
    setRecap({ from: startOfDay(lastAt), to: now, lastAt });
    const gapHours = Number(settingsRef.current.welcome_gap_hours ?? 8);
    if (now - lastAt >= gapHours * 3_600_000) setRecapOpen(true);
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      let lastAt: number | null = null;
      try {
        const [s, last, cachedPrs, cachedIssues] = await Promise.all([
          api.getSettings(),
          api.lastActivityAt(),
          api.listPrs(),
          api.listIssues(),
        ]);
        settingsRef.current = s;
        setSettings(s);
        setPrs(cachedPrs);
        setIssues(cachedIssues);
        lastAt = last;
        await refresh();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoaded(true);
      }
      // Let PR changes from while you were away reach the activity log before the recap is written.
      await Promise.race([refreshGithub(), new Promise((r) => setTimeout(r, 6000))]);
      checkWelcomeBack(lastAt);
    })();
  }, [refresh, refreshGithub, checkWelcomeBack]);

  // Keep PRs fresh: on window focus (at most once a minute) and every 5 minutes while visible.
  // Returning to a window that was left open also counts as "welcome back".
  useEffect(() => {
    const stale = (ms: number) => Date.now() - (githubSyncRef.current.at ?? 0) > ms;
    const onFocus = async () => {
      if (stale(60_000)) void refreshGithub();
      if (!recapOpenRef.current) {
        try {
          checkWelcomeBack(await api.lastActivityAt());
        } catch {
          /* ignore */
        }
      }
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && stale(4.5 * 60_000)) void refreshGithub();
    }, 60_000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [refreshGithub, checkWelcomeBack]);

  const linkGithubRaw = useCallback(
    async (taskId: number, input: string): Promise<LinkResult | null> => {
      try {
        const res = await api.linkGithub(taskId, input);
        const [p, i] = await Promise.all([api.listPrs(), api.listIssues()]);
        setPrs(p);
        setIssues(i);
        if (res.kind === "pr") void loadUntracked();
        return res;
      } catch (e) {
        setError(errorMessage(e));
        return null;
      }
    },
    [loadUntracked],
  );

  const store = useMemo<Store>(() => {
    const projectById = new Map(projects.map((p) => [p.id, p]));
    return {
      tasks,
      projects,
      projectById,
      settings,
      loaded,
      version,
      view,
      setView,
      selectedId,
      setSelectedId,
      drawerId,
      openDrawer: setDrawerId,
      parkRequest,
      requestPark: (task, status) => setParkRequest({ task, status: status ?? task.status }),
      closePark: () => setParkRequest(null),
      recap,
      recapOpen,
      setRecapOpen,
      settingsOpen,
      setSettingsOpen,
      helpOpen,
      setHelpOpen,
      projectFilter,
      setProjectFilter,
      search,
      setSearch,
      captureSignal,
      focusCapture: () => {
        setView("focus");
        setCaptureSignal(Date.now());
      },
      searchSignal,
      focusSearch: () => {
        setView("focus");
        setSearchSignal(Date.now());
      },
      error,
      setError,

      prs,
      prsByTask: groupByTask(prs),
      githubSync,
      refreshGithub,
      issues,
      issuesByTask: groupByTask(issues),
      linkGithub: async (taskId, input) => {
        const res = await linkGithubRaw(taskId, input);
        await refresh();
        return res != null;
      },
      unlinkIssue: async (id) => {
        await run(() => api.unlinkIssue(id));
        setIssues(await api.listIssues());
      },
      issuePicker,
      openIssuePicker: (taskId = null) => setIssuePicker({ taskId }),
      closeIssuePicker: () => setIssuePicker(null),
      createTaskFromIssue: async (issue) => {
        const t = await run(() => api.createTask({ title: issue.title, project_id: projectFilter }));
        if (!t) return;
        await linkGithubRaw(t.id, issue.url);
        await refresh();
        setSelectedId(t.id);
      },
      hiddenRepos: parseHiddenRepos(settings),
      setRepoHidden: async (repo, hidden) => {
        const set = parseHiddenRepos(settings);
        if (hidden) set.add(repo.toLowerCase());
        else set.delete(repo.toLowerCase());
        try {
          const value = JSON.stringify([...set].sort());
          await api.setSetting("hidden_repos", value);
          setSettings((s) => ({ ...s, hidden_repos: value }));
        } catch (e) {
          setError(errorMessage(e));
        }
      },
      unlinkPr: async (id) => {
        await run(() => api.unlinkPr(id));
        setPrs(await api.listPrs());
        void loadUntracked();
      },
      untracked,
      untrackedError,
      createTaskFromPr: async (pr) => {
        const status: Status = pr.is_draft ? "in_progress" : "in_review";
        const t = await run(() => api.createTask({ title: pr.title, status, project_id: projectFilter }));
        if (!t) return;
        await linkGithubRaw(t.id, pr.url);
        await refresh();
        setSelectedId(t.id);
      },

      capture: async (text) => {
        const input = parseCapture(text);
        const ghLink = input.link && isGithubRef(input.link) ? input.link : null;
        // A pasted PR or issue link on its own becomes a task named after it.
        const titleFromGh = !input.title && ghLink != null;
        if (!input.title && !ghLink) return null;
        if (titleFromGh) input.title = ghLink!;
        if (!input.project_name && projectFilter != null) input.project_id = projectFilter;
        const t = await run(() => api.createTask(input));
        if (!t) return null;
        setSelectedId(t.id);
        if (ghLink) {
          const res = await linkGithubRaw(t.id, ghLink);
          const pr = res?.pr?.data;
          const issue = res?.issue?.data;
          if (titleFromGh && (pr || issue)) {
            const patch: TaskPatch = { title: (pr ?? issue)!.title };
            if (!input.status && pr) patch.status = pr.is_draft ? "in_progress" : "in_review";
            await api.updateTask(t.id, patch);
          }
          await refresh();
        }
        return t;
      },
      update: async (id, patch) => {
        await run(() => api.updateTask(id, patch));
      },
      changeStatus: async (task, status) => {
        if (status === task.status) return;
        if (needsPark(task.status, status)) {
          setParkRequest({ task, status });
          return;
        }
        await run(() => api.updateTask(task.id, { status }));
      },
      park: async (id, nextStep, status) => {
        await run(() => api.parkTask(id, nextStep, status));
      },
      reorder: async (ids, priorityChange) => {
        // Optimistic: reflect the new order immediately to avoid a flicker after drop.
        setTasks((prev) => {
          const order = new Map(ids.map((id, i) => [id, i]));
          return prev.map((t) => {
            const next = { ...t };
            if (order.has(t.id)) next.sort_order = order.get(t.id)!;
            if (priorityChange?.id === t.id) next.priority = priorityChange.priority;
            return next;
          });
        });
        await run(async () => {
          if (priorityChange) await api.updateTask(priorityChange.id, { priority: priorityChange.priority });
          await api.reorderTasks(ids);
        });
      },
      archive: async (id) => {
        await run(() => api.archiveTask(id));
        if (drawerId === id) setDrawerId(null);
      },
      saveSetting: async (key, value) => {
        try {
          await api.setSetting(key, value);
          setSettings((s) => ({ ...s, [key]: value }));
        } catch (e) {
          setError(errorMessage(e));
        }
      },
      refresh,
    };
  }, [
    tasks, projects, settings, loaded, version, view, selectedId, drawerId, parkRequest, recap, recapOpen,
    settingsOpen, helpOpen, projectFilter, search, captureSignal, searchSignal, error, run, refresh,
    prs, issues, issuePicker, githubSync, refreshGithub, linkGithubRaw, untracked, untrackedError, loadUntracked,
  ]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
