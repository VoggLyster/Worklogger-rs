import { useState } from "react";
import { Bookmark } from "lucide-react";
import type { Status } from "../lib/api";
import { STATUS } from "../lib/meta";
import { useStore } from "../lib/store";
import { Modal, StatusIcon } from "./ui";

const TARGETS: Status[] = ["waiting", "in_review", "blocked", "todo", "backlog", "in_progress"];

/** The context-switch ritual: write down where you are leaving a task before moving on. */
export function ParkDialog() {
  const { parkRequest, closePark, park, update } = useStore();
  if (!parkRequest) return null;
  return <ParkBody key={parkRequest.task.id} {...parkRequest} onClose={closePark} park={park} update={update} />;
}

function ParkBody({
  task,
  status,
  onClose,
  park,
  update,
}: {
  task: { id: number; title: string; status: Status; next_step: string };
  status: Status;
  onClose(): void;
  park(id: number, nextStep: string, status?: Status): Promise<void>;
  update(id: number, patch: { status: Status }): Promise<void>;
}) {
  const initial = status === task.status && task.status === "in_progress" ? "waiting" : status;
  const [target, setTarget] = useState<Status>(initial);
  const [text, setText] = useState(task.next_step);

  const submit = async () => {
    onClose();
    await park(task.id, text, target);
  };
  const skip = async () => {
    onClose();
    if (target !== task.status) await update(task.id, { status: target });
  };

  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Bookmark size={16} className="text-accent" /> Where are you leaving this?
        </span>
      }
    >
      <div className="mb-3 truncate text-[13px] text-muted">{task.title}</div>
      <textarea
        autoFocus
        className="field min-h-24 text-[14px]"
        placeholder="e.g. Agent is refactoring the auth middleware in worktree feat-auth. Next: review its diff, then run the e2e tests."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="mt-3 flex flex-wrap gap-1.5">
        {TARGETS.map((s) => (
          <button
            key={s}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] ${
              target === s ? "border-accent bg-accent-soft" : "border-line text-muted hover:text-fg"
            }`}
            onClick={() => setTarget(s)}
          >
            <StatusIcon status={s} size={13} />
            {s === task.status ? `Keep ${STATUS[s].label.toLowerCase()}` : STATUS[s].label}
          </button>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="text-[12px] text-faint">
          <kbd>Enter</kbd> save · <kbd>Shift+Enter</kbd> newline
        </span>
        <div className="flex gap-2">
          <button className="btn" onClick={() => void skip()}>
            Skip note
          </button>
          <button className="btn btn-primary" onClick={() => void submit()}>
            Park
          </button>
        </div>
      </div>
    </Modal>
  );
}
