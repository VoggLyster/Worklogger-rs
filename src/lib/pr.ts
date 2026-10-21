import type { IssueSnapshot, PrSnapshot, Settings } from "./api";

/** Matches what the Rust side accepts: a github.com PR or issue URL, or `owner/repo#123`. */
export function isGithubRef(s: string): boolean {
  const t = s.trim();
  return /^(https?:\/\/)?github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+/.test(t) || /^[\w.-]+\/[\w.-]+#\d+$/.test(t);
}

export function isIssueUrl(s: string): boolean {
  return /github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/.test(s);
}

export type PrTone = "open" | "draft" | "merged" | "closed" | "unknown";

export function prTone(d: PrSnapshot | null): PrTone {
  if (!d) return "unknown";
  if (d.state === "MERGED") return "merged";
  if (d.state === "CLOSED") return "closed";
  return d.is_draft ? "draft" : "open";
}

export const TONE_COLOR: Record<PrTone, string> = {
  open: "var(--pr-open)",
  draft: "var(--faint)",
  merged: "var(--pr-merged)",
  closed: "var(--st-blocked)",
  unknown: "var(--faint)",
};

export const TONE_LABEL: Record<PrTone, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  unknown: "Not fetched yet",
};

export type ChecksTone = "pass" | "fail" | "pending" | null;

export function checksTone(d: PrSnapshot | null): ChecksTone {
  switch (d?.checks_state) {
    case "SUCCESS":
      return "pass";
    case "FAILURE":
    case "ERROR":
      return "fail";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

export function unresolvedThreads(d: PrSnapshot | null): number {
  return d ? d.threads.filter((t) => !t.resolved).length : 0;
}

/** The single most relevant thing to do about a PR, if any (shown on cards). */
export function prAttention(d: PrSnapshot | null): string | null {
  if (!d || d.state !== "OPEN") return null;
  if (d.checks_state === "FAILURE" || d.checks_state === "ERROR") return "checks failing";
  if (d.review_decision === "CHANGES_REQUESTED") return "changes requested";
  if (d.mergeable === "CONFLICTING") return "merge conflicts";
  const u = unresolvedThreads(d);
  if (u > 0) return `${u} unresolved`;
  return null;
}

export function groupByTask<T extends { task_id: number }>(rows: T[]): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    if (!m.has(r.task_id)) m.set(r.task_id, []);
    m.get(r.task_id)!.push(r);
  }
  return m;
}

// ---------------------------------------------------------------- issues

export type IssueTone = "open" | "done" | "not_planned" | "unknown";

export function issueTone(d: IssueSnapshot | null): IssueTone {
  if (!d) return "unknown";
  if (d.state === "OPEN") return "open";
  return d.state_reason === "NOT_PLANNED" || d.state_reason === "DUPLICATE" ? "not_planned" : "done";
}

export const ISSUE_TONE_COLOR: Record<IssueTone, string> = {
  open: "var(--pr-open)",
  done: "var(--pr-merged)",
  not_planned: "var(--faint)",
  unknown: "var(--faint)",
};

export const ISSUE_TONE_LABEL: Record<IssueTone, string> = {
  open: "Open",
  done: "Closed",
  not_planned: "Closed as not planned",
  unknown: "Not fetched yet",
};

export function isAssignedToViewer(d: IssueSnapshot | null): boolean {
  return !!d && !!d.viewer && d.assignees.includes(d.viewer);
}

/** Readable text on a GitHub label colour. */
export function labelStyle(color: string): { background: string; color: string; borderColor: string } {
  const hex = /^[0-9a-f]{6}$/i.test(color) ? color : "8b949e";
  return {
    background: `color-mix(in srgb, #${hex} 18%, transparent)`,
    color: `color-mix(in srgb, #${hex} 70%, var(--fg))`,
    borderColor: `color-mix(in srgb, #${hex} 45%, transparent)`,
  };
}


// ---------------------------------------------------------------- hidden repos

export function parseHiddenRepos(settings: Settings): Set<string> {
  try {
    const v = JSON.parse(settings.hidden_repos ?? "[]");
    return new Set(Array.isArray(v) ? v.map((r) => String(r).toLowerCase()) : []);
  } catch {
    return new Set();
  }
}
