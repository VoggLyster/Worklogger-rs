import { useEffect, useState } from "react";
import { Archive } from "lucide-react";
import { api, errorMessage, type HotkeyStatus, type SettingKey } from "../lib/api";
import { useStore } from "../lib/store";
import { Modal, Spinner } from "../components/ui";

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useStore();
  if (!settingsOpen) return null;
  return (
    <Modal title="Settings" onClose={() => setSettingsOpen(false)} width={560}>
      <SettingsBody />
    </Modal>
  );
}

function SettingsBody() {
  const { settings, saveSetting, projects, refresh, setError } = useStore();
  const [test, setTest] = useState<{ busy: boolean; result?: string; ok?: boolean }>({ busy: false });

  const [hotkey, setHotkey] = useState<HotkeyStatus | null>(null);
  const [ghTest, setGhTest] = useState<{ busy: boolean; result?: string; ok?: boolean }>({ busy: false });
  useEffect(() => {
    api.hotkeyStatus().then(setHotkey, () => {});
  }, []);

  const field = (key: SettingKey, fallback = "") => settings[key] ?? fallback;

  return (
    <div className="flex flex-col gap-5 text-[13px]">
      <Group title="Claude summaries">
        <Row label="Claude Code CLI" hint="Leave empty to auto-detect (PATH or ~/.local/bin).">
          <input
            className="field"
            placeholder="auto"
            defaultValue={field("claude_path")}
            onBlur={(e) => void saveSetting("claude_path", e.target.value.trim())}
          />
        </Row>
        <Row label="Model">
          <select className="field" value={field("model", "sonnet")} onChange={(e) => void saveSetting("model", e.target.value)}>
            <option value="sonnet">Sonnet (balanced)</option>
            <option value="haiku">Haiku (fastest)</option>
            <option value="opus">Opus (most capable)</option>
          </select>
        </Row>
        <div className="flex items-center gap-2">
          <button
            className="btn"
            disabled={test.busy}
            onClick={async () => {
              setTest({ busy: true });
              try {
                setTest({ busy: false, ok: true, result: await api.testClaude() });
              } catch (e) {
                setTest({ busy: false, ok: false, result: errorMessage(e) });
              }
            }}
          >
            {test.busy && <Spinner size={12} />} Test CLI
          </button>
          {test.result && (
            <span className={test.ok ? "text-muted" : "text-[var(--st-blocked)]"}>{test.result}</span>
          )}
        </div>
      </Group>

      <Group title="GitHub pull requests">
        <Row label="GitHub CLI" hint="Uses your gh auth login. Leave empty to auto-detect.">
          <input
            className="field"
            placeholder="auto"
            defaultValue={field("gh_path")}
            onBlur={(e) => void saveSetting("gh_path", e.target.value.trim())}
          />
        </Row>
        <div className="flex items-center gap-2">
          <button
            className="btn"
            disabled={ghTest.busy}
            onClick={async () => {
              setGhTest({ busy: true });
              try {
                setGhTest({ busy: false, ok: true, result: await api.testGh() });
              } catch (e) {
                setGhTest({ busy: false, ok: false, result: errorMessage(e) });
              }
            }}
          >
            {ghTest.busy && <Spinner size={12} />} Test GitHub CLI
          </button>
          {ghTest.result && <span className={ghTest.ok ? "text-muted" : "text-[var(--st-blocked)]"}>{ghTest.result}</span>}
        </div>
        <div className="text-[12px] text-faint">
          PRs refresh on launch, when the window regains focus, and every 5 minutes. A task is marked done when all its
          linked PRs are merged.
        </div>
      </Group>

      <Group title="Welcome back">
        <Row label="Show after a break of" hint="Hours since your last logged activity.">
          <input
            type="number"
            min={0}
            className="field w-24"
            defaultValue={field("welcome_gap_hours", "8")}
            onBlur={(e) => void saveSetting("welcome_gap_hours", String(Math.max(0, Number(e.target.value) || 0)))}
          />
        </Row>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={field("auto_recap", "true") !== "false"}
            onChange={(e) => void saveSetting("auto_recap", String(e.target.checked))}
          />
          Generate the AI recap automatically
        </label>
      </Group>

      <Group title="Quick capture">
        <Row label="Global hotkey" hint="Brings WorkLogger to the front with the capture bar focused, from any app.">
          <input
            className="field"
            placeholder="ctrl+alt+n"
            defaultValue={field("hotkey")}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            onBlur={async (e) => {
              try {
                setHotkey(await api.setHotkey(e.target.value));
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          />
          {hotkey && (
            <div className={`mt-1 text-[12px] ${hotkey.error ? "text-[var(--st-blocked)]" : "text-muted"}`}>
              {hotkey.error ? `${hotkey.combo}: ${hotkey.error}` : `Active: ${hotkey.combo}`}
            </div>
          )}
        </Row>
      </Group>

      <Group title="Projects">
        {projects.length === 0 && <div className="text-faint">Add one with #name in the capture bar.</div>}
        {projects.map((p) => (
          <div key={p.id} className="flex items-center gap-2">
            <input
              type="color"
              className="h-7 w-8 shrink-0 cursor-pointer rounded border border-line bg-transparent"
              defaultValue={p.color}
              onBlur={async (e) => {
                if (e.target.value === p.color) return;
                await api.updateProject(p.id, undefined, e.target.value).catch((err) => setError(errorMessage(err)));
                await refresh();
              }}
            />
            <input
              className="field py-1"
              defaultValue={p.name}
              onBlur={async (e) => {
                const name = e.target.value.trim();
                if (!name || name === p.name) return;
                await api.updateProject(p.id, name).catch((err) => setError(errorMessage(err)));
                await refresh();
              }}
            />
            <button
              className="btn btn-ghost px-2"
              title="Archive project (tasks keep existing, without a project)"
              onClick={async () => {
                await api.archiveProject(p.id).catch((err) => setError(errorMessage(err)));
                await refresh();
              }}
            >
              <Archive size={14} />
            </button>
          </div>
        ))}
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-start gap-3">
      <div className="pt-1.5">{label}</div>
      <div>
        {children}
        {hint && <div className="mt-1 text-[12px] text-faint">{hint}</div>}
      </div>
    </div>
  );
}
