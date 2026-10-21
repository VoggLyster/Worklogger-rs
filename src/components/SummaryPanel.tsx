import { useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw, Sparkles } from "lucide-react";
import { api, errorMessage, type Summary } from "../lib/api";
import { fmtDayTime } from "../lib/time";
import { Spinner } from "./ui";
import { Md } from "./Md";

/**
 * Cached AI summary for a time window. Generates via the local Claude Code CLI on demand,
 * or automatically when `auto` is set and nothing is cached yet.
 */
export function SummaryPanel({
  scope,
  from,
  to,
  label,
  auto = false,
  empty = false,
}: {
  scope: Summary["scope"];
  from: number;
  to: number;
  label: string;
  auto?: boolean;
  /** No activity in range: don't offer to summarize. */
  empty?: boolean;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const autoTried = useRef(false);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      setSummary(await api.summarize(scope, from, to, label));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSummary(null);
    setError(null);
    autoTried.current = false;
    api
      .getSummary(scope, from)
      .then((s) => !cancelled && setSummary(s))
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope, from]);

  useEffect(() => {
    if (auto && !loading && !summary && !empty && !autoTried.current) {
      autoTried.current = true;
      void generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, loading, summary, empty]);

  const copy = async () => {
    if (!summary) return;
    await navigator.clipboard.writeText(summary.content_md);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Sparkles size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">{scope === "day" ? "Day summary" : "Recap"}</span>
        {summary && !busy && (
          <span className="text-[12px] text-faint">generated {fmtDayTime(summary.created_at)}</span>
        )}
        <div className="ml-auto flex gap-1">
          {summary && (
            <button className="btn btn-ghost px-2 py-1" onClick={() => void copy()} title="Copy Markdown">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
          {!empty && (
            <button className="btn py-1" disabled={busy} onClick={() => void generate()}>
              {busy ? <Spinner size={12} /> : summary ? <RefreshCw size={13} /> : <Sparkles size={13} />}
              {busy ? "Asking Claude…" : summary ? "Regenerate" : "Summarize"}
            </button>
          )}
        </div>
      </div>
      <div className="px-4 py-3 text-[14px]">
        {error && <div className="mb-2 rounded-md bg-[color-mix(in_srgb,var(--st-blocked)_12%,transparent)] px-3 py-2 text-[13px]">{error}</div>}
        {loading ? (
          <div className="text-[13px] text-faint">Loading…</div>
        ) : summary ? (
          <Md className={busy ? "opacity-50" : ""}>{summary.content_md}</Md>
        ) : busy ? (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> Claude is reading your activity log…
          </div>
        ) : empty ? (
          <div className="text-[13px] text-faint">Nothing logged in this period.</div>
        ) : (
          !error && (
            <div className="text-[13px] text-faint">
              No summary yet. It's generated with your local Claude Code login and cached here.
            </div>
          )
        )}
      </div>
    </div>
  );
}
