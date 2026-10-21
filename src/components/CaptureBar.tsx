import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Plus } from "lucide-react";
import { useStore } from "../lib/store";
import { parseCapture } from "../lib/parseCapture";
import { PRIORITY, STATUS } from "../lib/meta";
import { isPrRef } from "../lib/pr";

export function CaptureBar() {
  const { capture, captureSignal, projectFilter, projectById } = useStore();
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (Date.now() - captureSignal < 1000) ref.current?.focus();
  }, [captureSignal]);

  const parsed = useMemo(() => parseCapture(text), [text]);
  const filterProject = projectFilter != null ? projectById.get(projectFilter) : undefined;
  const chips: string[] = [];
  if (parsed.priority !== undefined) chips.push(PRIORITY[parsed.priority].label);
  if (parsed.status) chips.push(STATUS[parsed.status].label);
  if (parsed.project_name) chips.push(`#${parsed.project_name}`);
  else if (filterProject && text.trim()) chips.push(`#${filterProject.name}`);
  if (parsed.agent) chips.push(`@${parsed.agent}`);
  if (parsed.link) chips.push(isPrRef(parsed.link) ? "pull request" : "link");
  if (parsed.next_step) chips.push(`next: ${parsed.next_step}`);

  const submit = async () => {
    if (!parsed.title && !(parsed.link && isPrRef(parsed.link))) return;
    const t = await capture(text);
    if (t) setText("");
  };

  return (
    <div className="rounded-xl border border-line bg-surface shadow-sm focus-within:border-accent">
      <div className="flex items-center gap-2 px-3">
        <Plus size={16} className="shrink-0 text-faint" />
        <input
          ref={ref}
          data-capture
          className="h-11 w-full bg-transparent text-[15px] outline-none placeholder:text-faint"
          placeholder="Capture a task…   !1  #project  @agent  ^now/^wait/^later   > next step"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              setText("");
              ref.current?.blur();
            }
          }}
        />
        {text.trim() && (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-faint">
            <CornerDownLeft size={12} /> add
          </span>
        )}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-1.5">
          {chips.map((c) => (
            <span key={c} className="max-w-80 truncate rounded bg-surface-2 px-1.5 py-0.5 text-[12px] text-muted">
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
