const DAY = 86_400_000;

export function startOfDay(ms: number = Date.now()): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Start of the next local day (DST-safe, unlike adding 24h). */
export function addDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function fmtDay(ms: number, opts: { year?: boolean } = {}): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(opts.year ? { year: "numeric" } : {}),
  });
}

export function fmtDayTime(ms: number): string {
  const today = startOfDay();
  if (ms >= today) return `today ${fmtTime(ms)}`;
  if (ms >= addDays(today, -1)) return `yesterday ${fmtTime(ms)}`;
  return `${fmtDay(ms)} ${fmtTime(ms)}`;
}

export function ago(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round((now - ms) / DAY);
  if (d < 14) return `${d}d ago`;
  return fmtDay(ms);
}

export function toDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromDateInput(v: string): number | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}
