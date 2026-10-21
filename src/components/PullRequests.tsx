import { useState } from "react";
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  FileCode,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  MessageSquare,
  Plus,
  RefreshCw,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PrComment, PrRow, PrSnapshot, SearchPr } from "../lib/api";
import { openExternal } from "../lib/open";
import { TONE_COLOR, TONE_LABEL, checksTone, prAttention, prTone, type PrTone } from "../lib/pr";
import { useStore } from "../lib/store";
import { ago } from "../lib/time";
import { Md } from "./Md";
import { Spinner } from "./ui";

const TONE_ICON: Record<PrTone, LucideIcon> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  unknown: GitPullRequest,
};

function PrIcon({ data, size = 14 }: { data: PrSnapshot | null; size?: number }) {
  const tone = prTone(data);
  const Icon = TONE_ICON[tone];
  return <Icon size={size} style={{ color: TONE_COLOR[tone] }} className="shrink-0" aria-label={TONE_LABEL[tone]} />;
}

function ChecksIcon({ data, size = 13 }: { data: PrSnapshot | null; size?: number }) {
  const t = checksTone(data);
  if (!t || data?.state !== "OPEN") return null;
  if (t === "pass") return <CircleCheck size={size} style={{ color: "var(--pr-open)" }} aria-label="Checks passing" />;
  if (t === "fail") return <CircleX size={size} style={{ color: "var(--st-blocked)" }} aria-label="Checks failing" />;
  return <CircleDashed size={size} style={{ color: "var(--warn)" }} aria-label="Checks running" />;
}

// ---------------------------------------------------------------- card chips

/** Compact PR state for task cards. Clicking a chip opens the PR on GitHub. */
export function PrChips({ rows }: { rows: PrRow[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {rows.map((r) => {
        const attention = prAttention(r.data);
        return (
          <button
            key={r.id}
            className="inline-flex h-[22px] max-w-full items-center gap-1 rounded-md border border-line px-1.5 text-[12px] text-muted hover:border-faint hover:text-fg"
            title={`${r.repo}#${r.number}${r.data ? ` · ${r.data.title}` : ""} · ${TONE_LABEL[prTone(r.data)]}`}
            onClick={(e) => {
              e.stopPropagation();
              openExternal(r.url);
            }}
          >
            <PrIcon data={r.data} size={13} />
            <span className="font-mono text-[11px]">#{r.number}</span>
            <ChecksIcon data={r.data} size={12} />
            {r.data?.review_decision === "APPROVED" && r.data.state === "OPEN" && (
              <span style={{ color: "var(--pr-open)" }}>approved</span>
            )}
            {attention && <span style={{ color: "var(--st-blocked)" }}>{attention}</span>}
            {r.fetch_error && <TriangleAlert size={12} style={{ color: "var(--warn)" }} />}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- drawer panel

export function PrPanel({ taskId }: { taskId: number }) {
  const { prsByTask, linkPr, refreshPrs, prSync } = useStore();
  const rows = prsByTask.get(taskId) ?? [];
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const link = async () => {
    if (!input.trim()) return;
    setBusy(true);
    if (await linkPr(taskId, input)) setInput("");
    setBusy(false);
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="text-[12px] font-medium text-muted">Pull requests</div>
        {rows.length > 0 && (
          <button
            className="ml-auto flex items-center gap-1 text-[12px] text-faint hover:text-fg"
            title="Refresh from GitHub"
            onClick={() => void refreshPrs(taskId)}
            disabled={prSync.busy}
          >
            {prSync.busy ? <Spinner size={11} /> : <RefreshCw size={12} />}
            {prSync.at ? `updated ${ago(prSync.at)}` : "refresh"}
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-col gap-2">
        {rows.map((r) => (
          <PrCard key={r.id} row={r} />
        ))}
        <div className="flex gap-1">
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-accent">
            <Link2 size={13} className="shrink-0 text-faint" />
            <input
              className="h-8 w-full bg-transparent text-[13px] outline-none placeholder:text-faint"
              placeholder="Paste a PR link or owner/repo#123"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void link()}
            />
          </div>
          {input.trim() && (
            <button className="btn" onClick={() => void link()} disabled={busy}>
              {busy ? <Spinner size={12} /> : "Link"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PrCard({ row }: { row: PrRow }) {
  const { unlinkPr } = useStore();
  const d = row.data;
  const tone = prTone(d);
  const [open, setOpen] = useState(tone === "open" || tone === "draft");
  const unresolved = d ? d.threads.filter((t) => !t.resolved) : [];
  const failed = d ? d.checks.filter((c) => c.result === "FAILURE" || c.result === "TIMED_OUT" || c.result === "CANCELLED") : [];
  const pending = d ? d.checks.filter((c) => c.result === "PENDING").length : 0;
  const passed = d ? d.checks.length - failed.length - pending : 0;

  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-start gap-2 px-2.5 py-2">
        <button className="mt-[1px] text-faint hover:text-fg" onClick={() => setOpen((o) => !o)} aria-label="Toggle details">
          <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <PrIcon data={d} size={15} />
        <div className="min-w-0 flex-1">
          <button className="block w-full text-left text-[13px] font-medium leading-snug hover:underline" onClick={() => openExternal(row.url)}>
            {d?.title ?? row.url}
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
            <span className="font-mono">
              {row.repo}#{row.number}
            </span>
            <span style={{ color: TONE_COLOR[tone] }}>{TONE_LABEL[tone]}</span>
            {d && (
              <>
                <span className="font-mono">
                  {d.head} → {d.base}
                </span>
                <span>
                  <span style={{ color: "var(--pr-open)" }}>+{d.additions}</span>{" "}
                  <span style={{ color: "var(--st-blocked)" }}>−{d.deletions}</span>
                </span>
              </>
            )}
            {row.fetched_at && <span>synced {ago(row.fetched_at)}</span>}
          </div>
        </div>
        <button className="text-faint hover:text-fg" title="Open on GitHub" onClick={() => openExternal(row.url)}>
          <ExternalLink size={13} />
        </button>
        <button className="text-faint hover:text-fg" title="Unlink from this task" onClick={() => void unlinkPr(row.id)}>
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
          {/* Status line */}
          {d.state === "OPEN" && (
            <div className="flex flex-wrap gap-1.5">
              <ReviewBadge decision={d.review_decision} />
              {d.review_requests.length > 0 && <Pill>Waiting on {d.review_requests.join(", ")}</Pill>}
              {d.mergeable === "CONFLICTING" && <Pill tone="bad">Merge conflicts</Pill>}
            </div>
          )}

          {d.checks.length > 0 && d.state === "OPEN" && (
            <div>
              <div className="flex items-center gap-1.5 text-muted">
                <ChecksIcon data={d} />
                {d.checks.length} checks: {passed} passed
                {failed.length > 0 && `, ${failed.length} failed`}
                {pending > 0 && `, ${pending} running`}
              </div>
              {failed.map((c) => (
                <button
                  key={c.name}
                  className="ml-5 mt-0.5 flex items-center gap-1 hover:underline"
                  style={{ color: "var(--st-blocked)" }}
                  onClick={() => c.url && openExternal(c.url)}
                >
                  <CircleX size={11} /> {c.name}
                </button>
              ))}
            </div>
          )}

          {unresolved.length > 0 && (
            <Section title={`Unresolved review threads (${unresolved.length})`} defaultOpen>
              {unresolved.map((t, i) => (
                <ThreadView key={i} path={t.path} line={t.line} outdated={t.outdated} comments={t.comments} />
              ))}
            </Section>
          )}

          <Conversation d={d} />
        </div>
      )}
    </div>
  );
}

function ReviewBadge({ decision }: { decision: PrSnapshot["review_decision"] }) {
  if (decision === "APPROVED") return <Pill tone="good">Approved</Pill>;
  if (decision === "CHANGES_REQUESTED") return <Pill tone="bad">Changes requested</Pill>;
  if (decision === "REVIEW_REQUIRED") return <Pill>Review required</Pill>;
  return null;
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "var(--pr-open)" : tone === "bad" ? "var(--st-blocked)" : "var(--muted)";
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
    >
      {children}
    </span>
  );
}

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="flex items-center gap-1 font-medium text-muted hover:text-fg" onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {title}
      </button>
      {open && <div className="mt-1.5 flex flex-col gap-2 pl-4">{children}</div>}
    </div>
  );
}

function ThreadView({ path, line, outdated, comments }: { path: string; line: number | null; outdated: boolean; comments: PrComment[] }) {
  const [all, setAll] = useState(false);
  const [first, ...replies] = comments;
  const shown = all ? replies : replies.slice(-1);
  return (
    <div className="rounded-md bg-surface-2/60 px-2.5 py-2">
      <button
        className="mb-1 flex items-center gap-1 font-mono text-[11px] text-faint hover:text-fg"
        onClick={() => first?.url && openExternal(first.url)}
        title="Open thread on GitHub"
      >
        <FileCode size={11} />
        {path}
        {line != null && `:${line}`}
        {outdated && <span className="font-sans">(outdated)</span>}
      </button>
      {first && <CommentView c={first} />}
      {replies.length > 1 && !all && (
        <button className="mt-1 text-[11px] text-accent hover:underline" onClick={() => setAll(true)}>
          {replies.length - 1} more {replies.length - 1 === 1 ? "reply" : "replies"}
        </button>
      )}
      {shown.map((c) => (
        <div key={c.url} className="mt-1.5 border-l-2 border-line pl-2">
          <CommentView c={c} />
        </div>
      ))}
    </div>
  );
}

function CommentView({ c, prefix }: { c: PrComment; prefix?: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = c.body.length > 420;
  const body = long && !expanded ? `${c.body.slice(0, 420).trimEnd()}…` : c.body;
  const author = c.author.replace(/-pull-request-reviewer$/, "");
  return (
    <div>
      <div className="flex items-baseline gap-1.5 text-[11px]">
        <span className="font-semibold text-fg">{author}</span>
        {prefix && <span className="text-muted">{prefix}</span>}
        {c.created_at && <span className="text-faint">{ago(Date.parse(c.created_at))}</span>}
      </div>
      {body.trim() && <Md className="mt-0.5 text-[12.5px] leading-normal">{body}</Md>}
      {long && (
        <button className="text-[11px] text-accent hover:underline" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** Review summaries and top-level comments, newest last. */
function Conversation({ d }: { d: PrSnapshot }) {
  const items: (PrComment & { prefix?: string })[] = [
    ...d.reviews
      .filter((r) => r.body.trim())
      .map((r) => ({
        author: r.author,
        body: r.body,
        created_at: r.submitted_at,
        url: r.url,
        prefix: r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "requested changes" : "reviewed",
      })),
    ...d.comments,
  ].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (!items.length) return null;
  const others = items.filter((c) => c.author !== d.viewer).length;
  return (
    <Section title={`Conversation (${items.length}${others !== items.length ? `, ${others} from others` : ""})`}>
      {items.slice(-8).map((c) => (
        <div key={c.url} className="flex gap-1.5">
          <MessageSquare size={12} className="mt-[3px] shrink-0 text-faint" />
          <div className="min-w-0 flex-1">
            <CommentView c={c} prefix={c.prefix} />
          </div>
        </div>
      ))}
      {items.length > 8 && <div className="text-faint">Older comments are on GitHub.</div>}
    </Section>
  );
}

// ---------------------------------------------------------------- inbox

/** Your open PRs that no task tracks yet. */
export function PrInbox() {
  const { untracked, untrackedError, createTaskFromPr, linkPr, selectedId, tasks } = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (untrackedError) {
    return (
      <div className="rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-faint">
        PR inbox unavailable: <span className="selectable">{untrackedError}</span>
      </div>
    );
  }
  if (!untracked?.length) return null;
  const selected = tasks.find((t) => t.id === selectedId);

  const act = async (pr: SearchPr, fn: () => Promise<unknown>) => {
    setBusy(pr.url);
    await fn();
    setBusy(null);
  };

  return (
    <section>
      <button className="mb-1.5 flex w-full items-center gap-2 px-1 text-left" onClick={() => setCollapsed((c) => !c)}>
        <ChevronRight size={14} className={`text-faint transition-transform ${collapsed ? "" : "rotate-90"}`} />
        <GitPullRequest size={14} style={{ color: "var(--pr-open)" }} />
        <span className="text-[13px] font-semibold">Untracked PRs</span>
        <span className="text-[12px] text-faint">{untracked.length}</span>
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-1">
          {untracked.map((pr) => (
            <div key={pr.url} className="group flex items-center gap-2 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-[13px]">
              {pr.is_draft ? (
                <GitPullRequestDraft size={14} className="shrink-0 text-faint" />
              ) : (
                <GitPullRequest size={14} className="shrink-0" style={{ color: "var(--pr-open)" }} />
              )}
              <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => openExternal(pr.url)} title={pr.url}>
                {pr.title}
              </button>
              <span className="shrink-0 font-mono text-[11px] text-faint group-hover:hidden">
                {pr.repo.split("/")[1]}#{pr.number}
              </span>
              <div className="hidden shrink-0 gap-1 group-hover:flex">
                {busy === pr.url ? (
                  <Spinner size={12} />
                ) : (
                  <>
                    {selected && selected.status !== "done" && (
                      <button
                        className="btn px-2 py-0.5 text-[12px]"
                        title={`Link to "${selected.title}"`}
                        onClick={() => void act(pr, () => linkPr(selected.id, pr.url))}
                      >
                        <Link2 size={12} /> Link to selected
                      </button>
                    )}
                    <button className="btn px-2 py-0.5 text-[12px]" onClick={() => void act(pr, () => createTaskFromPr(pr))}>
                      <Plus size={12} /> Task
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
