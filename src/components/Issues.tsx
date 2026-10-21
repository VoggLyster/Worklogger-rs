import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleSlash,
  ExternalLink,
  EyeOff,
  GitPullRequest,
  Link2,
  MessageSquare,
  Plus,
  Search,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, errorMessage, type IssueRow, type IssueScope, type IssueSnapshot, type SearchIssue } from "../lib/api";
import { openExternal } from "../lib/open";
import { ISSUE_TONE_COLOR, ISSUE_TONE_LABEL, isAssignedToViewer, issueTone, labelStyle, type IssueTone } from "../lib/pr";
import { useStore } from "../lib/store";
import { ago } from "../lib/time";
import { Md } from "./Md";
import { CommentView, Pill, Section } from "./PullRequests";
import { Modal, Spinner } from "./ui";

const TONE_ICON: Record<IssueTone, LucideIcon> = {
  open: CircleDot,
  done: CircleCheck,
  not_planned: CircleSlash,
  unknown: CircleDot,
};

export function IssueIcon({ data, size = 14, open }: { data: IssueSnapshot | null; size?: number; open?: boolean }) {
  const tone = open ? "open" : issueTone(data);
  const Icon = TONE_ICON[tone];
  return <Icon size={size} style={{ color: ISSUE_TONE_COLOR[tone] }} className="shrink-0" aria-label={ISSUE_TONE_LABEL[tone]} />;
}

export function LabelChips({ labels, max = 4 }: { labels: { name: string; color: string }[]; max?: number }) {
  if (!labels.length) return null;
  return (
    <>
      {labels.slice(0, max).map((l) => (
        <span key={l.name} className="max-w-28 truncate rounded-full border px-1.5 text-[11px] leading-[16px]" style={labelStyle(l.color)}>
          {l.name}
        </span>
      ))}
      {labels.length > max && <span className="text-[11px] text-faint">+{labels.length - max}</span>}
    </>
  );
}

// ---------------------------------------------------------------- card chips

/** Compact issue state for task cards. Clicking a chip opens the issue on GitHub. */
export function IssueChips({ rows }: { rows: IssueRow[] }) {
  return (
    <>
      {rows.map((r) => (
        <button
          key={r.id}
          className="inline-flex h-[22px] max-w-full items-center gap-1 rounded-md border border-line px-1.5 text-[12px] text-muted hover:border-faint hover:text-fg"
          title={`${r.repo}#${r.number}${r.data ? ` · ${r.data.title}` : ""} · ${ISSUE_TONE_LABEL[issueTone(r.data)]}`}
          onClick={(e) => {
            e.stopPropagation();
            openExternal(r.url);
          }}
        >
          <IssueIcon data={r.data} size={13} />
          <span className="font-mono text-[11px]">#{r.number}</span>
          {r.data && r.data.comment_count > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px]">
              <MessageSquare size={11} /> {r.data.comment_count}
            </span>
          )}
          {isAssignedToViewer(r.data) && r.data?.state === "OPEN" && <span style={{ color: "var(--pr-open)" }}>yours</span>}
          {r.fetch_error && <TriangleAlert size={12} style={{ color: "var(--warn)" }} />}
        </button>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- drawer card

export function IssueCard({ row, taskId }: { row: IssueRow; taskId: number }) {
  const { unlinkIssue, linkGithub, prsByTask } = useStore();
  const d = row.data;
  const tone = issueTone(d);
  const [open, setOpen] = useState(tone === "open");
  const [bodyOpen, setBodyOpen] = useState(false);
  const linkedPrs = new Set((prsByTask.get(taskId) ?? []).map((p) => `${p.repo}#${p.number}`.toLowerCase()));
  const body = d?.body.trim() ?? "";
  const longBody = body.length > 500;

  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-start gap-2 px-2.5 py-2">
        <button className="mt-[1px] text-faint hover:text-fg" onClick={() => setOpen((o) => !o)} aria-label="Toggle details">
          <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <IssueIcon data={d} size={15} />
        <div className="min-w-0 flex-1">
          <button className="block w-full text-left text-[13px] font-medium leading-snug hover:underline" onClick={() => openExternal(row.url)}>
            {d?.title ?? row.url}
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
            <span className="font-mono">
              {row.repo}#{row.number}
            </span>
            <span style={{ color: ISSUE_TONE_COLOR[tone] }}>{ISSUE_TONE_LABEL[tone]}</span>
            {d && <LabelChips labels={d.labels} />}
            {row.fetched_at && <span>synced {ago(row.fetched_at)}</span>}
          </div>
        </div>
        <button className="text-faint hover:text-fg" title="Open on GitHub" onClick={() => openExternal(row.url)}>
          <ExternalLink size={13} />
        </button>
        <button className="text-faint hover:text-fg" title="Unlink from this task" onClick={() => void unlinkIssue(row.id)}>
          <X size={14} />
        </button>
      </div>

      {row.fetch_error && (
        <div className="mx-2.5 mb-2 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[12px]" style={{ background: "color-mix(in srgb, var(--warn) 12%, transparent)" }}>
          <TriangleAlert size={13} className="mt-[2px] shrink-0" style={{ color: "var(--warn)" }} />
          <span className="selectable">{row.fetch_error}</span>
        </div>
      )}

      {open && d && (
        <div className="flex flex-col gap-2.5 border-t border-line px-3 py-2.5 text-[12px]">
          <div className="flex flex-wrap gap-1.5">
            {d.assignees.length > 0 ? (
              <Pill tone={isAssignedToViewer(d) ? "good" : undefined}>Assigned: {d.assignees.join(", ")}</Pill>
            ) : (
              <Pill>Unassigned</Pill>
            )}
            {d.milestone && <Pill>Milestone: {d.milestone}</Pill>}
            <Pill>Opened by {d.author}</Pill>
          </div>

          {d.closing_prs.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-muted">Pull requests that close it</div>
              {d.closing_prs.map((p) => {
                const key = `${p.repo}#${p.number}`;
                const linked = linkedPrs.has(key.toLowerCase());
                return (
                  <div key={key} className="flex items-center gap-1.5">
                    <GitPullRequest size={12} style={{ color: p.state === "MERGED" ? "var(--pr-merged)" : p.state === "OPEN" ? "var(--pr-open)" : "var(--faint)" }} />
                    <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => openExternal(p.url)} title={key}>
                      {p.title} <span className="font-mono text-faint">#{p.number}</span>
                    </button>
                    {linked ? (
                      <span className="text-faint">linked</span>
                    ) : (
                      <button className="text-accent hover:underline" onClick={() => void linkGithub(taskId, p.url)}>
                        Link PR
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {body && (
            <div>
              <Md className="text-[12.5px] leading-normal">{longBody && !bodyOpen ? `${body.slice(0, 500).trimEnd()}…` : body}</Md>
              {longBody && (
                <button className="text-[11px] text-accent hover:underline" onClick={() => setBodyOpen((o) => !o)}>
                  {bodyOpen ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}

          {d.comments.length > 0 && (
            <Section title={`Comments (${d.comment_count})`}>
              {d.comments.slice(-8).map((c) => (
                <div key={c.url} className="flex gap-1.5">
                  <MessageSquare size={12} className="mt-[3px] shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <CommentView c={c} />
                  </div>
                </div>
              ))}
              {d.comment_count > 8 && <div className="text-faint">Older comments are on GitHub.</div>}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- picker

const SCOPES: { id: IssueScope; label: string }[] = [
  { id: "involves", label: "Involving me" },
  { id: "assigned", label: "Assigned" },
  { id: "created", label: "Created" },
  { id: "mentioned", label: "Mentioned" },
  { id: "repo", label: "Browse repo" },
];

/** All open issues across your repos: link one to a task, or start a task from it. */
export function IssuePicker() {
  const { issuePicker } = useStore();
  if (!issuePicker) return null;
  return <PickerBody taskId={issuePicker.taskId} />;
}

function PickerBody({ taskId }: { taskId: number | null }) {
  const {
    closeIssuePicker, tasks, issues, prs, untracked, hiddenRepos, setRepoHidden, linkGithub, createTaskFromIssue, selectedId,
  } = useStore();
  const [scope, setScope] = useState<IssueScope>("involves");
  const [repo, setRepo] = useState("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [repoFilter, setRepoFilter] = useState<string>("");
  const [showHidden, setShowHidden] = useState(false);
  const [results, setResults] = useState<SearchIssue[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const target = taskId != null ? tasks.find((t) => t.id === taskId) : tasks.find((t) => t.id === selectedId && t.status !== "done");
  const linkedTo = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of issues) m.set(`${i.repo}#${i.number}`.toLowerCase(), i.task_id);
    return m;
  }, [issues]);

  // Repos you've touched, for "Browse repo".
  const knownRepos = useMemo(() => {
    const set = new Set<string>();
    for (const r of [...prs, ...issues]) set.add(r.repo);
    for (const r of untracked ?? []) set.add(r.repo);
    for (const r of results ?? []) set.add(r.repo);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [prs, issues, untracked, results]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 400);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (scope === "repo" && !repo.includes("/")) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .searchIssues(scope, scope === "repo" ? repo.trim() : null, debounced)
      .then((r) => !cancelled && setResults(r))
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope, repo, debounced]);

  useEffect(() => searchRef.current?.focus(), []);

  const visible = (results ?? []).filter((i) => showHidden || scope === "repo" || !hiddenRepos.has(i.repo.toLowerCase()));
  const hiddenCount = (results ?? []).length - visible.length;
  const resultRepos = [...new Set(visible.map((i) => i.repo))].sort((a, b) => a.localeCompare(b));
  const shown = repoFilter ? visible.filter((i) => i.repo === repoFilter) : visible;

  const act = async (issue: SearchIssue, fn: () => Promise<unknown>) => {
    setBusy(issue.url);
    await fn();
    setBusy(null);
  };

  return (
    <Modal
      onClose={closeIssuePicker}
      width={820}
      title={
        <span className="flex items-center gap-2">
          <CircleDot size={16} style={{ color: "var(--pr-open)" }} />
          {target && taskId != null ? `Link issues to "${target.title}"` : "GitHub issues"}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[12px] ${
                scope === s.id ? "border-accent bg-accent-soft text-fg" : "border-line text-muted hover:text-fg"
              }`}
              onClick={() => {
                setScope(s.id);
                setRepoFilter("");
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {scope === "repo" && (
            <>
              <input
                className="field w-64 py-1"
                list="known-repos"
                placeholder="owner/repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
              <datalist id="known-repos">
                {knownRepos.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </>
          )}
          <div className="flex h-[30px] min-w-48 flex-1 items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-accent">
            <Search size={13} className="text-faint" />
            <input
              ref={searchRef}
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-faint"
              placeholder="Search titles and bodies…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {scope !== "repo" && resultRepos.length > 1 && (
            <select className="field w-52 py-1" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
              <option value="">All repos ({visible.length})</option>
              {resultRepos.map((r) => (
                <option key={r} value={r}>
                  {r} ({visible.filter((i) => i.repo === r).length})
                </option>
              ))}
            </select>
          )}
        </div>

        {error && <div className="rounded-md bg-[color-mix(in_srgb,var(--st-blocked)_12%,transparent)] px-3 py-2 text-[13px]">{error}</div>}

        <div className="flex min-h-40 flex-col gap-1">
          {loading && !results && (
            <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
              <Spinner /> Searching GitHub…
            </div>
          )}
          {scope === "repo" && !repo.includes("/") && <div className="py-6 text-[13px] text-faint">Pick a repository to list its open issues.</div>}
          {results && shown.length === 0 && !loading && <div className="py-6 text-[13px] text-faint">No open issues here.</div>}
          {shown.map((i) => {
            const key = `${i.repo}#${i.number}`;
            const linkedTask = linkedTo.get(key.toLowerCase());
            const linkedTitle = linkedTask != null ? tasks.find((t) => t.id === linkedTask)?.title : undefined;
            const linkedHere = linkedTask != null && linkedTask === target?.id;
            return (
              <div key={i.url} className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-surface-2 ${loading ? "opacity-60" : ""}`}>
                <IssueIcon data={null} open size={14} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <button className="truncate text-left text-[13px] hover:underline" onClick={() => openExternal(i.url)} title={key}>
                      {i.title}
                    </button>
                    <LabelChips labels={i.labels} max={3} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
                    <span className="font-mono">{key}</span>
                    {i.assignees.length > 0 && <span>→ {i.assignees.join(", ")}</span>}
                    {i.comment_count > 0 && (
                      <span className="inline-flex items-center gap-0.5">
                        <MessageSquare size={10} /> {i.comment_count}
                      </span>
                    )}
                    <span>updated {ago(Date.parse(i.updated_at))}</span>
                    {linkedTitle && <span className="text-accent">linked to "{linkedTitle}"</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {busy === i.url ? (
                    <Spinner size={12} />
                  ) : (
                    <>
                      <button
                        className="hidden text-faint hover:text-fg group-hover:block"
                        title={hiddenRepos.has(i.repo.toLowerCase()) ? `Show ${i.repo} again` : `Hide everything from ${i.repo}`}
                        onClick={() => void setRepoHidden(i.repo, !hiddenRepos.has(i.repo.toLowerCase()))}
                      >
                        <EyeOff size={13} />
                      </button>
                      {target && !linkedHere && (
                        <button
                          className={`btn px-2 py-0.5 text-[12px] ${taskId != null ? "btn-primary" : ""}`}
                          title={`Link to "${target.title}"`}
                          onClick={() => void act(i, () => linkGithub(target.id, i.url))}
                        >
                          <Link2 size={12} /> {taskId != null ? "Link" : "Link to selected"}
                        </button>
                      )}
                      {linkedHere && <span className="text-[12px] text-faint">linked</span>}
                      {taskId == null && (
                        <button className="btn px-2 py-0.5 text-[12px]" onClick={() => void act(i, () => createTaskFromIssue(i))}>
                          <Plus size={12} /> Task
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-line pt-2 text-[12px] text-faint">
          <span>
            {results ? `${shown.length} open issue${shown.length === 1 ? "" : "s"}` : ""}
            {loading && results ? " · refreshing…" : ""}
          </span>
          {hiddenCount > 0 || showHidden ? (
            <button className="hover:text-fg" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? "Hide hidden repos" : `${hiddenCount} from hidden repos · show`}
            </button>
          ) : (
            <span>Hover a row and click the eye to hide a repo</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
