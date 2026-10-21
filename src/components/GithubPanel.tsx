import { useState } from "react";
import { CircleDot, Link2, RefreshCw } from "lucide-react";
import { useStore } from "../lib/store";
import { ago } from "../lib/time";
import { IssueCard } from "./Issues";
import { PrCard } from "./PullRequests";
import { Spinner } from "./ui";

/** Drawer section: PRs and issues linked to a task, plus linking new ones. */
export function GithubPanel({ taskId }: { taskId: number }) {
  const { prsByTask, issuesByTask, linkGithub, refreshGithub, githubSync, openIssuePicker } = useStore();
  const prs = prsByTask.get(taskId) ?? [];
  const issues = issuesByTask.get(taskId) ?? [];
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const link = async () => {
    if (!input.trim()) return;
    setBusy(true);
    if (await linkGithub(taskId, input)) setInput("");
    setBusy(false);
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="text-[12px] font-medium text-muted">GitHub</div>
        {prs.length + issues.length > 0 && (
          <button
            className="ml-auto flex items-center gap-1 text-[12px] text-faint hover:text-fg"
            title="Refresh from GitHub"
            onClick={() => void refreshGithub(taskId)}
            disabled={githubSync.busy}
          >
            {githubSync.busy ? <Spinner size={11} /> : <RefreshCw size={12} />}
            {githubSync.at ? `updated ${ago(githubSync.at)}` : "refresh"}
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-col gap-2">
        {prs.map((r) => (
          <PrCard key={`pr-${r.id}`} row={r} />
        ))}
        {issues.map((r) => (
          <IssueCard key={`issue-${r.id}`} row={r} taskId={taskId} />
        ))}
        <div className="flex gap-1">
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-accent">
            <Link2 size={13} className="shrink-0 text-faint" />
            <input
              className="h-8 w-full bg-transparent text-[13px] outline-none placeholder:text-faint"
              placeholder="Paste a PR or issue link, or owner/repo#123"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void link()}
            />
          </div>
          {input.trim() ? (
            <button className="btn" onClick={() => void link()} disabled={busy}>
              {busy ? <Spinner size={12} /> : "Link"}
            </button>
          ) : (
            <button className="btn" onClick={() => openIssuePicker(taskId)} title="Find an issue to link">
              <CircleDot size={13} /> Browse issues
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
