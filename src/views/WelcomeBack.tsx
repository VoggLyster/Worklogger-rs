import { CornerDownRight, Bot } from "lucide-react";
import type { Status } from "../lib/api";
import { STATUS } from "../lib/meta";
import { useStore } from "../lib/store";
import { ago, fmtDay, fmtDayTime } from "../lib/time";
import { SummaryPanel } from "../components/SummaryPanel";
import { Modal, PriorityBadge, StatusIcon } from "../components/ui";
import { PrChips } from "../components/PullRequests";
import { IssueChips } from "../components/Issues";

const OPEN: Status[] = ["in_progress", "waiting", "in_review", "blocked"];

/** "Where did I leave everything?" — shown on launch after a break, or from the header. */
export function WelcomeBack() {
  const { recap, recapOpen, setRecapOpen, tasks, settings, openDrawer, setSelectedId, prsByTask, issuesByTask } = useStore();
  if (!recapOpen) return null;

  const open = tasks
    .filter((t) => OPEN.includes(t.status))
    .sort((a, b) => OPEN.indexOf(a.status) - OPEN.indexOf(b.status) || a.priority - b.priority);
  const close = () => setRecapOpen(false);

  return (
    <Modal title="Welcome back" onClose={close} width={760}>
      {recap ? (
        <div className="mb-3 text-[13px] text-muted">
          Last activity {fmtDayTime(recap.lastAt)} ({ago(recap.lastAt)}).
        </div>
      ) : (
        <div className="mb-3 text-[13px] text-muted">No activity logged yet. Capture a task to get started.</div>
      )}

      {recap && (
        <SummaryPanel
          scope="since"
          from={recap.from}
          to={recap.to}
          label={`${fmtDay(recap.from)} until ${fmtDayTime(recap.lastAt)}; now ${fmtDayTime(recap.to)}`}
          auto={settings.auto_recap !== "false"}
        />
      )}

      <div className="mt-4">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Open threads</div>
        {open.length === 0 ? (
          <div className="text-[13px] text-faint">Nothing in progress, waiting, in review or blocked.</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {open.map((t) => (
              <li key={t.id}>
                <div
                  role="button"
                  tabIndex={0}
                  className="w-full rounded-lg border border-line px-3 py-2 text-left hover:bg-surface-2"
                  onClick={() => {
                    close();
                    setSelectedId(t.id);
                    openDrawer(t.id);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <StatusIcon status={t.status} />
                    <PriorityBadge priority={t.priority} />
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    {t.agent && (
                      <span className="inline-flex items-center gap-1 text-[12px] text-muted">
                        <Bot size={12} /> {t.agent}
                      </span>
                    )}
                    <span className="text-[11px] text-faint">{STATUS[t.status].label}</span>
                  </div>
                  <div className="mt-1 flex items-start gap-1.5 pl-7 text-[13px] text-muted">
                    <CornerDownRight size={13} className="mt-[3px] shrink-0 text-faint" />
                    {t.next_step || <span className="italic text-faint">No next step written down</span>}
                  </div>
                  {(prsByTask.get(t.id) || issuesByTask.get(t.id)) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7">
                      {prsByTask.get(t.id) && <PrChips rows={prsByTask.get(t.id)!} />}
                      {issuesByTask.get(t.id) && <IssueChips rows={issuesByTask.get(t.id)!} />}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <button className="btn btn-primary" onClick={close}>
          Let's go
        </button>
      </div>
    </Modal>
  );
}
