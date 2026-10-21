# WorkLogger

A small, fast, local task tracker for running many things in parallel (often with AI agents)
and coming back to them without losing the thread.

- **Focus view**: In progress, Waiting on agent, In review and Blocked on the left; Up next, Backlog and Done today on the right.
  Tasks sort by priority, then by manual drag order.
- **Quick capture** with inline syntax, plus a global hotkey (`Ctrl+Alt+N` by default) that brings the window up from anywhere.
- **Park**: when you switch away from an in-progress task, WorkLogger asks *"Where are you leaving this?"*. The answer
  becomes the task's **next step**, shown on every card.
- **Progress log** per task. Status, priority and completion changes are recorded automatically, and you add notes.
- **Journal**: any day's activity grouped by task, with an AI **day summary**.
- **Welcome back**: after a break (8h by default), opens with an AI recap of where you left everything.

## Pull requests

PR tracking uses your local **GitHub CLI** (`gh auth login`). No token is stored in the app.

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
- **Auto-complete:** when every linked PR of a task is merged, the task is marked done. If you reopen it by hand, it
  stays open.

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

Requires Node 20+, Rust (stable, MSVC) and WebView2 (preinstalled on Windows 11).

```bash
npm install
npm run tauri dev      # desktop app with hot reload
npm run dev            # UI only in a browser, with an in-memory demo backend
npm test               # frontend unit tests
cd src-tauri && cargo test                                    # Rust unit tests
cd src-tauri && WORKLOGGER_LIVE_PR=owner/repo#123 cargo test -- --ignored --nocapture  # live checks (Claude CLI, gh)
npm run tauri build    # release build + NSIS installer in src-tauri/target/release/bundle
```

Data lives in `%APPDATA%\dk.vogg.worklogger\worklogger.db` (SQLite).

### Layout

- `src-tauri/src/db.rs`: schema, migrations and every query. Activity is an append-only log written in the same transaction as each change.
- `src-tauri/src/summary.rs`: digest builder and the Claude CLI runner.
- `src-tauri/src/github.rs`: PR parsing, the batched GraphQL query, snapshot parsing, change detection and the `gh` runner.
- `src-tauri/src/commands.rs`: the Tauri command layer.
- `src/lib/api.ts`: the `Backend` interface, the only seam between the UI and storage. `memoryBackend.ts` is
  a second implementation (browser preview), and the starting point for a future web export.

## License

[MIT](LICENSE) © 2026 Søren Lyster
