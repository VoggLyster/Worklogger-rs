# WorkLogger

A small, fast, local task tracker for running many things in parallel (often with AI agents)
and coming back to them without losing the thread.

- **Focus view**: In progress, Waiting on agent, In review and Blocked on the left; Up next, Backlog and Done today on the right.
  Tasks sort by priority, then by manual drag order.
- **Quick capture** with inline syntax, plus a global hotkey (`Ctrl+Alt+N` on Windows/Linux, `⌘⌥N` on macOS, configurable) that brings the window up from anywhere.
- **Park**: when you switch away from an in-progress task, WorkLogger asks *"Where are you leaving this?"*. The answer
  becomes the task's **next step**, shown on every card.
- **Progress log** per task. Status, priority and completion changes are recorded automatically, and you add notes.
- **Journal**: any day's activity grouped by task, with an AI **day summary**.
- **Welcome back**: after a break (8h by default), opens with an AI recap of where you left everything.

## GitHub: pull requests and issues

GitHub tracking uses your local **GitHub CLI** (`gh auth login`). No token is stored in the app.

### Pull requests

- **Linking:** paste a PR link into the capture bar (on its own, it creates a task named after the PR), into the
  task drawer, or use the **Untracked PRs** inbox. The inbox lists your open PRs that no task tracks yet. A task can
  have several PRs.
- **On cards:** state (open/draft/merged/closed), checks, approval, and the one thing that needs attention:
  failing checks, changes requested, merge conflicts or unresolved threads.
- **In the drawer:** branch, diff size, review status, failed checks with links, unresolved review threads with
  replies, and the conversation.
- **Refresh:** on launch, when the window regains focus, and every 5 minutes. All PRs go in one batched GraphQL call.
  Merged PRs stop being polled.
- **Activity:** changes are logged to the task's activity, so the Journal and summaries see them. Logged changes are
  merged, closed, ready for review, checks failing or passing, approved, changes requested, conflicts, and new
  comments from others.
- **In review:** when a linked PR is open and ready for review (on first link, or when it leaves draft), a task that
  is Up next, In progress or Waiting moves to In review. Tasks created from a non-draft PR start there.

### Issues

- **Issue picker** (the **Issues** button, or `I`): open issues across all your repos. By default it shows issues
  involving you; switch to Assigned, Created or Mentioned, browse every open issue in one repo, or search. Each row
  can start a new task or be linked to the selected task. Issues that are already linked show which task has them.
- **Linking:** the drawer's link box takes PR or issue links, and `owner/repo#123` (looked up on GitHub, since PRs
  and issues share numbers). **Browse issues** in the drawer opens the picker for that task. Pasting an issue link on
  its own into the capture bar creates a task named after the issue.
- **On cards:** state, comment count, and whether it's assigned to you.
- **In the drawer:** labels, assignees, milestone, the PRs that will close it (one click links them too), the issue
  body and recent comments.
- **Activity:** closed (as completed or as not planned), reopened, assigned to you, and new comments from others.

### Hidden repositories

Hide a repo from the PR inbox and the issue picker with the eye icon on any of its rows, or add it under
Settings → GitHub. The list is saved in your settings. Items you already linked stay on their tasks.

### Done when everything is finished

A task is marked done automatically when everything linked to it is finished: every PR merged (or closed), every
issue closed, and at least one PR merged or issue closed as completed. If you reopen a task by hand, it stays open.

## Capture syntax

```
Wire up Stripe webhooks !0 #web @claude-wt3 ^now > read the signature docs
```

| Token | Meaning |
|---|---|
| `!0` … `!3` (`!` = `!1`) | priority, P0 most urgent |
| `#name` | project (created on first use) |
| `@label` | agent / session label |
| `^now` `^wait` `^review` `^block` `^later` `^done` | status (default: Up next) |
| `https://…` | link |
| `> text` | next step |

Press `?` in the app for all keyboard shortcuts.

## AI summaries

Summaries run through your local **Claude Code CLI** in headless mode (`claude -p`), so they use your
existing Claude login. No API key is stored. If summaries report that you're not logged in, run `claude` in
a terminal and use `/login`. You can change the model and the CLI path in Settings.

## Development

Requires Node 20+ and Rust (stable).

- **Windows:** Rust with the MSVC toolchain, and WebView2 (preinstalled on Windows 11).
- **macOS:** Xcode Command Line Tools (`xcode-select --install`); the webview uses the system WebKit.
- **Linux:** `webkit2gtk-4.1` and the usual build essentials.

```bash
npm install
npm run tauri dev      # desktop app with hot reload
npm run dev            # UI only in a browser, with an in-memory demo backend
npm test               # frontend unit tests
cd src-tauri && cargo test                                    # Rust unit tests
cd src-tauri && WORKLOGGER_LIVE_PR=owner/repo#123 cargo test -- --ignored --nocapture  # live checks (Claude CLI, gh)
npm run tauri build    # release build in src-tauri/target/release/bundle
```

`tauri build` emits platform-appropriate bundles: an NSIS installer on Windows, a `.app`
plus `.dmg` on macOS (the macOS targets live in `src-tauri/tauri.macos.conf.json`).

On macOS, the global hotkey needs **Accessibility** permission the first time it fires
(System Settings → Privacy & Security → Accessibility → enable WorkLogger).

Data lives in a per-platform application-data directory:

- **Windows:** `%APPDATA%\dk.vogg.worklogger\worklogger.db`
- **macOS:** `~/Library/Application Support/dk.vogg.worklogger/worklogger.db`
- **Linux:** `~/.local/share/dk.vogg.worklogger/worklogger.db`

### Layout

- `src-tauri/src/db.rs`: schema, migrations and every query. Activity is an append-only log written in the same transaction as each change.
- `src-tauri/src/summary.rs`: digest builder and the Claude CLI runner.
- `src-tauri/src/github.rs`: PR and issue references, batched GraphQL queries, snapshot parsing, change detection, issue search and the `gh` runner.
- `src-tauri/src/commands.rs`: the Tauri command layer.
- `src/lib/api.ts`: the `Backend` interface, the only seam between the UI and storage. `memoryBackend.ts` is
  a second implementation (browser preview), and the starting point for a future web export.

## License

[MIT](LICENSE) © 2026 Søren Lyster
