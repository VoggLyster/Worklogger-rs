import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Project, Status } from "../lib/api";
import { PRIORITY, STATUS, STATUS_ORDER } from "../lib/meta";

export function Modal({
  title,
  onClose,
  children,
  width = 520,
}: {
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[10vh] backdrop-blur-[1px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      data-modal
    >
      <div
        className="flex max-h-[80vh] w-full flex-col rounded-xl border border-line bg-surface shadow-2xl"
        style={{ maxWidth: width }}
        role="dialog"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="font-semibold">{title}</div>
          <button className="btn btn-ghost px-1.5" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/** Small dropdown anchored to its trigger. */
export function Menu({
  trigger,
  children,
  align = "left",
}: {
  trigger: (toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", h);
    window.addEventListener("keydown", k, true);
    return () => {
      document.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k, true);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref} onClick={(e) => e.stopPropagation()}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div
          className={`absolute top-full z-40 mt-1 min-w-44 rounded-lg border border-line bg-surface p-1 shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, children, active }: { onClick(): void; children: ReactNode; active?: boolean }) {
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 ${
        active ? "font-semibold" : ""
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function StatusIcon({ status, size = 16 }: { status: Status; size?: number }) {
  const m = STATUS[status];
  const Icon = m.icon;
  return <Icon size={size} style={{ color: m.color }} aria-label={m.label} />;
}

export function StatusMenu({ status, onChange }: { status: Status; onChange(s: Status): void }) {
  return (
    <Menu
      trigger={(toggle) => (
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-surface-2"
          onClick={toggle}
          title={`${STATUS[status].label} — change status (S)`}
        >
          <StatusIcon status={status} />
        </button>
      )}
    >
      {(close) =>
        STATUS_ORDER.map((s) => (
          <MenuItem
            key={s}
            active={s === status}
            onClick={() => {
              close();
              onChange(s);
            }}
          >
            <StatusIcon status={s} size={14} />
            {STATUS[s].label}
          </MenuItem>
        ))
      }
    </Menu>
  );
}

export function PriorityBadge({ priority, onClick }: { priority: number; onClick?(): void }) {
  const p = PRIORITY[priority] ?? PRIORITY[2];
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded px-1 font-mono text-[11px] font-semibold"
      style={{ color: p.color, background: `color-mix(in srgb, ${p.color} 14%, transparent)` }}
      title={`${p.label} · ${p.name}`}
      onClick={onClick}
    >
      {p.label}
    </span>
  );
}

export function ProjectChip({ project }: { project: Project }) {
  return (
    <span className="inline-flex max-w-36 shrink-0 items-center gap-1 truncate text-[12px] text-muted">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: project.color }} />
      <span className="truncate">{project.name}</span>
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent"
      style={{ width: size, height: size }}
    />
  );
}
