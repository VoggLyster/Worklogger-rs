import { CalendarDays, CircleDot, History, Keyboard, LayoutList, Settings, X } from "lucide-react";
import { SHORTCUTS, useHotkeys } from "./lib/hotkeys";
import { StoreProvider, useStore, type View } from "./lib/store";
import { FocusView } from "./views/FocusView";
import { JournalView } from "./views/JournalView";
import { WelcomeBack } from "./views/WelcomeBack";
import { SettingsDialog } from "./views/SettingsDialog";
import { TaskDrawer } from "./components/TaskDrawer";
import { ParkDialog } from "./components/ParkDialog";
import { Modal } from "./components/ui";
import { IssuePicker } from "./components/Issues";

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  useHotkeys();
  const { view, loaded, error, setError, helpOpen, setHelpOpen } = useStore();

  return (
    <div className="flex h-full flex-col">
      <Header />
      {error && (
        <div className="flex items-start gap-2 border-b border-line bg-[color-mix(in_srgb,var(--st-blocked)_12%,var(--surface))] px-5 py-2 text-[13px]">
          <span className="selectable flex-1">{error}</span>
          <button className="text-muted hover:text-fg" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      <main className="flex-1 overflow-y-auto">{loaded && (view === "focus" ? <FocusView /> : <JournalView />)}</main>
      <TaskDrawer />
      <ParkDialog />
      <WelcomeBack />
      <SettingsDialog />
      <IssuePicker />
      {helpOpen && (
        <Modal title="Keyboard shortcuts" onClose={() => setHelpOpen(false)} width={440}>
          <table className="w-full text-[13px]">
            <tbody>
              {SHORTCUTS.map(([k, d]) => (
                <tr key={k}>
                  <td className="w-36 py-1 pr-3">
                    <kbd>{k}</kbd>
                  </td>
                  <td className="py-1 text-muted">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}

function Header() {
  const { view, setView, setRecapOpen, setSettingsOpen, setHelpOpen, openIssuePicker, tasks } = useStore();
  const counts = {
    active: tasks.filter((t) => t.status === "in_progress").length,
    waiting: tasks.filter((t) => t.status === "waiting").length,
    review: tasks.filter((t) => t.status === "in_review").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
      <div className="mr-3 flex items-center gap-2 pl-1">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-white">
          W
        </div>
        <span className="font-semibold">WorkLogger</span>
      </div>
      <Tab view="focus" current={view} onClick={setView} icon={<LayoutList size={15} />} label="Focus" />
      <Tab view="journal" current={view} onClick={setView} icon={<CalendarDays size={15} />} label="Journal" />

      <div className="ml-auto flex items-center gap-3 pr-1 text-[12px] text-muted">
        <span title="In progress">
          <b className="text-[var(--st-progress)]">{counts.active}</b> active
        </span>
        <span title="Waiting on an agent">
          <b className="text-[var(--st-waiting)]">{counts.waiting}</b> waiting
        </span>
        <span title="In review">
          <b className="text-[var(--st-review)]">{counts.review}</b> in review
        </span>
        {counts.blocked > 0 && (
          <span title="Blocked">
            <b className="text-[var(--st-blocked)]">{counts.blocked}</b> blocked
          </span>
        )}
      </div>
      <button className="btn btn-ghost ml-2" onClick={() => openIssuePicker()} title="GitHub issues across your repos (I)">
        <CircleDot size={15} /> Issues
      </button>
      <button className="btn btn-ghost" onClick={() => setRecapOpen(true)} title="Where did I leave off? (R)">
        <History size={15} /> Recap
      </button>
      <button className="btn btn-ghost px-2" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)">
        <Keyboard size={15} />
      </button>
      <button className="btn btn-ghost px-2" onClick={() => setSettingsOpen(true)} title="Settings">
        <Settings size={15} />
      </button>
    </header>
  );
}

function Tab({
  view,
  current,
  onClick,
  icon,
  label,
}: {
  view: View;
  current: View;
  onClick(v: View): void;
  icon: React.ReactNode;
  label: string;
}) {
  const active = view === current;
  return (
    <button
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] ${
        active ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg"
      }`}
      onClick={() => onClick(view)}
    >
      {icon}
      {label}
    </button>
  );
}
