import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "./api";
import { STATUS_ORDER } from "./meta";
import { useStore } from "./store";
import { visibleTaskIds } from "./sections";

export const isMac =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || "") || /Mac OS X/i.test(navigator.userAgent || ""));

/** Platform-friendly label for the default global hotkey. */
export const defaultGlobalHotkeyLabel = isMac ? "⌘⌥N" : "Ctrl+Alt+N";
/** Platform-friendly label for the "submit textarea" shortcut. */
export const submitShortcutLabel = isMac ? "⌘+Enter" : "Ctrl+Enter";

export const SHORTCUTS: [string, string][] = [
  ["N", "New task (focus capture bar)"],
  ["/", "Search"],
  ["J / K", "Next / previous task"],
  ["Enter", "Open task"],
  ["1 – 4", "Set priority P0 – P3"],
  ["S", "Cycle status"],
  ["P", "Park: note where you left it"],
  ["D", "Toggle done"],
  ["G then F", "Go to Focus"],
  ["G then J", "Go to Journal"],
  ["R", "Welcome-back recap"],
  ["← / →", "Previous / next day (Journal)"],
  ["Esc", "Close / clear"],
  ["?", "This help"],
  [defaultGlobalHotkeyLabel, "Global: bring WorkLogger up and capture (configurable)"],
];

function isField(el: EventTarget | Element | null): boolean {
  const h = el as HTMLElement | null;
  return !!h && (h.tagName === "INPUT" || h.tagName === "TEXTAREA" || h.tagName === "SELECT" || h.isContentEditable);
}

/** True while typing — checks the event target too, since a field may blur itself during the same keydown. */
function typing(e: KeyboardEvent): boolean {
  return isField(e.target) || isField(document.activeElement);
}

export function useHotkeys() {
  const s = useStore();
  const ref = useRef(s);
  ref.current = s;
  const gPending = useRef(0);

  // Global OS-level shortcut is registered in Rust; it emits this event.
  useEffect(() => {
    if (!inTauri) return;
    const un = listen("quick-capture", () => ref.current.focusCapture());
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = ref.current;
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      if (document.querySelector("[data-modal]")) return;
      const key = e.key;

      if (Date.now() - gPending.current < 1200) {
        gPending.current = 0;
        if (key === "j") st.setView("journal");
        if (key === "f") st.setView("focus");
        e.preventDefault();
        return;
      }

      const selected = st.tasks.find((t) => t.id === st.selectedId);
      const move = (delta: number) => {
        const ids = visibleTaskIds(st.tasks, st.projectFilter, st.search);
        if (!ids.length) return;
        const i = st.selectedId != null ? ids.indexOf(st.selectedId) : -1;
        const next = ids[i < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, i + delta))];
        st.setSelectedId(next);
        if (st.drawerId != null) st.openDrawer(next);
        requestAnimationFrame(() =>
          document.querySelector(`[data-task-id="${next}"]`)?.scrollIntoView({ block: "nearest" }),
        );
      };

      let handled = true;
      switch (key) {
        case "n":
          st.focusCapture();
          break;
        case "/":
          st.focusSearch();
          break;
        case "g":
          gPending.current = Date.now();
          break;
        case "?":
          st.setHelpOpen(true);
          break;
        case "r":
          st.setRecapOpen(true);
          break;
        case "j":
        case "ArrowDown":
          if (st.view !== "focus") handled = false;
          else move(1);
          break;
        case "k":
        case "ArrowUp":
          if (st.view !== "focus") handled = false;
          else move(-1);
          break;
        case "Enter":
          if (selected) st.openDrawer(selected.id);
          break;
        case "Escape":
          if (st.drawerId == null) st.setSelectedId(null);
          handled = false;
          break;
        case "1":
        case "2":
        case "3":
        case "4":
          if (selected) void st.update(selected.id, { priority: Number(key) - 1 });
          break;
        case "s":
          if (selected) {
            const i = STATUS_ORDER.indexOf(selected.status);
            void st.changeStatus(selected, STATUS_ORDER[(i + 1) % STATUS_ORDER.length]);
          }
          break;
        case "p":
          if (selected && selected.status !== "done") st.requestPark(selected);
          break;
        case "d":
          if (selected) void st.changeStatus(selected, selected.status === "done" ? "todo" : "done");
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
