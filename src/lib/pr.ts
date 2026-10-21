import type { PrRow, PrSnapshot } from "./api";

/** Matches what the Rust side accepts: a github.com PR URL or `owner/repo#123`. */
export function isPrRef(s: string): boolean {
  return /^(https?:\/\/)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(s.trim()) || /^[\w.-]+\/[\w.-]+#\d+$/.test(s.trim());
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

export function groupByTask(prs: PrRow[]): Map<number, PrRow[]> {
  const m = new Map<number, PrRow[]>();
  for (const p of prs) {
    if (!m.has(p.task_id)) m.set(p.task_id, []);
    m.get(p.task_id)!.push(p);
  }
  return m;
}
