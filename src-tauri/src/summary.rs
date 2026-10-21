//! Builds a plain-text digest of activity and asks the local Claude Code CLI (headless, using the
//! user's existing login) to turn it into a Markdown summary.

use crate::db::{Activity, Project, Task};
use crate::github::PrSnapshot;
use chrono::{Local, TimeZone};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

pub const DAY_PROMPT: &str = "\
You write a concise end-of-day work journal for a software developer who runs many tasks in parallel, \
often delegated to AI coding agents. You receive a raw activity log grouped by task. \
Write GitHub-flavoured Markdown with exactly these parts:\n\
1. A 2-4 sentence overview of the day (no heading).\n\
2. `### Done` - bullets of tasks completed, with the key outcome if the log says it.\n\
3. `### Progressed` - bullets of tasks that moved but are not done, ending each with where it was left.\n\
4. `### Open threads` - bullets of `**task** - next step` for everything still open that was touched today.\n\
Tasks may list linked pull requests with their current state; mention PR outcomes (merged, checks failing, \
changes requested, unresolved review threads) where they matter. \
Omit a section if it would be empty. Use only facts present in the log; never invent details. \
Be terse - bullets are fragments, not sentences. No preamble, no sign-off.";

pub const SINCE_PROMPT: &str = "\
You help a software developer pick their work back up after a break. They run many tasks in parallel, \
often delegated to AI coding agents, and lose track of where each one was left. You receive the activity \
log of their last working session plus a snapshot of every open task. \
Write GitHub-flavoured Markdown with exactly these parts:\n\
1. One sentence on what the last session was mostly about (no heading).\n\
2. `### Where you left off` - one bullet per open in_progress, waiting, in_review or blocked task: \
`**task** (status, agent if any) - concrete next step`. Waiting tasks mean an agent was working on it: \
say to check its output. In-review tasks wait on human review of their PR. If a linked PR has failing checks, requested changes, unresolved review threads \
or merge conflicts, say so - that is usually the next step.\n\
3. `### Suggested first moves` - 1-3 bullets, ordered by priority (P0 most urgent) and by what unblocks other work.\n\
Use only facts present in the input; never invent details. Be terse. No preamble, no sign-off.";

fn fmt_time(ms: i64, with_date: bool) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(t) if with_date => t.format("%a %d %b %H:%M").to_string(),
        Some(t) => t.format("%H:%M").to_string(),
        None => "?".into(),
    }
}

pub type PrMap = HashMap<i64, Vec<PrSnapshot>>;

fn task_header(t: &Task, projects: &HashMap<i64, &Project>, prs: &PrMap) -> String {
    let mut bits = vec![t.status.replace('_', " "), format!("P{}", t.priority)];
    if let Some(p) = t.project_id.and_then(|id| projects.get(&id)) {
        bits.push(format!("project: {}", p.name));
    }
    if !t.agent.is_empty() {
        bits.push(format!("agent: {}", t.agent));
    }
    let mut s = format!("## {} [{}]\n", t.title, bits.join(", "));
    if !t.next_step.is_empty() {
        s.push_str(&format!("Current next step: {}\n", t.next_step));
    }
    if !t.description.is_empty() {
        let d: String = t.description.chars().take(400).collect();
        s.push_str(&format!("Description: {}\n", d.replace('\n', " ")));
    }
    for pr in prs.get(&t.id).into_iter().flatten() {
        s.push_str(&format!("Linked {}\n", pr.digest_line()));
    }
    s
}

fn describe(a: &Activity) -> String {
    let meta = |k: &str| a.meta.get(k).map(|v| v.to_string().trim_matches('"').replace('_', " ")).unwrap_or_default();
    match a.kind.as_str() {
        "created" => "created".into(),
        "status" => format!("status {} -> {}", meta("from"), meta("to")),
        "priority" => format!("priority P{} -> P{}", meta("from"), meta("to")),
        "completed" if a.body.is_empty() => "completed".into(),
        "completed" => format!("completed: {}", a.body),
        "reopened" => format!("reopened ({})", meta("to")),
        "parked" => format!("parked ({} -> {}); left off at: {}", meta("from"), meta("to"), a.body),
        "next_step" => format!("next step set: {}", a.body),
        "note" => format!("note: {}", a.body),
        "pr" => format!("PR {}", a.body),
        "edited" => format!("edited {}", a.meta.get("fields").map(|f| f.to_string()).unwrap_or_default()),
        other => format!("{other}: {}", a.body),
    }
}

/// Activity grouped by task (in order of first touch), oldest entry first.
/// `open_snapshot` adds open tasks that had no activity in range (used by the welcome-back recap).
pub fn build_digest(
    title: &str,
    activity: &[Activity],
    tasks: &[Task],
    projects: &[Project],
    open_snapshot: &[Task],
    prs: &PrMap,
    multi_day: bool,
) -> String {
    let projects: HashMap<i64, &Project> = projects.iter().map(|p| (p.id, p)).collect();
    let by_id: HashMap<i64, &Task> = tasks.iter().chain(open_snapshot.iter()).map(|t| (t.id, t)).collect();
    let mut order: Vec<i64> = Vec::new();
    let mut groups: HashMap<i64, Vec<&Activity>> = HashMap::new();
    for a in activity {
        if !groups.contains_key(&a.task_id) {
            order.push(a.task_id);
        }
        groups.entry(a.task_id).or_default().push(a);
    }

    let mut out = format!("# {title}\n\n");
    if order.is_empty() {
        out.push_str("(No activity logged in this period.)\n\n");
    }
    for id in &order {
        let Some(t) = by_id.get(id) else { continue };
        out.push_str(&task_header(t, &projects, prs));
        for a in &groups[id] {
            out.push_str(&format!("- {} {}\n", fmt_time(a.created_at, multi_day), describe(a)));
        }
        out.push('\n');
    }
    let untouched: Vec<&Task> = open_snapshot.iter().filter(|t| !groups.contains_key(&t.id)).collect();
    if !untouched.is_empty() {
        out.push_str("# Other open tasks (no activity in this period)\n\n");
        for t in untouched {
            out.push_str(&task_header(t, &projects, prs));
            out.push_str(&format!("- last updated {}\n\n", fmt_time(t.updated_at, true)));
        }
    }
    out
}

// ---------------------------------------------------------------- claude CLI

/// Resolve the CLI: explicit setting, then PATH, then the default native-installer location.
pub fn resolve_claude(setting: Option<String>) -> PathBuf {
    if let Some(p) = setting {
        return PathBuf::from(p);
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
        let p = Path::new(&home).join(".local").join("bin").join(exe);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("claude")
}

fn command(claude: &Path, cwd: &Path) -> tokio::process::Command {
    let mut cmd = crate::cli::hidden_command(claude, cwd);
    cmd.env_remove("CLAUDECODE").env_remove("CLAUDE_CODE_ENTRYPOINT");
    cmd
}

fn friendly(msg: &str) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("authenticat") || lower.contains("login") || lower.contains("oauth") {
        format!("Claude Code isn't logged in ({msg}). Open a terminal, run `claude`, and use /login - then try again.")
    } else {
        msg.to_string()
    }
}

pub async fn run_claude(claude: &Path, cwd: &Path, model: &str, system: &str, input: &str) -> Result<String, String> {
    let mut child = command(claude, cwd)
        .args([
            "-p",
            "--output-format",
            "json",
            "--model",
            model,
            "--tools",
            "",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--system-prompt",
            system,
        ])
        .spawn()
        .map_err(|e| {
            format!(
                "Couldn't start Claude Code at '{}': {e}. Install it or set its path in Settings.",
                claude.display()
            )
        })?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);

    let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .map_err(|_| "Claude took longer than 2 minutes - try again.".to_string())?
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        let result = v.get("result").and_then(|r| r.as_str()).unwrap_or("").trim().to_string();
        if v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false) || result.is_empty() {
            let msg = if result.is_empty() { "Claude returned an empty response".into() } else { result };
            return Err(friendly(&msg));
        }
        return Ok(result);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let detail = if stderr.trim().is_empty() { stdout.trim().to_string() } else { stderr.trim().to_string() };
    Err(friendly(&format!("Claude Code failed ({}): {}", out.status, detail)))
}

pub async fn claude_version(claude: &Path, cwd: &Path) -> Result<String, String> {
    let mut cmd = command(claude, cwd);
    cmd.arg("--version").stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| format!("Couldn't start '{}': {e}", claude.display()))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task(id: i64, title: &str, status: &str) -> Task {
        Task {
            id,
            title: title.into(),
            description: String::new(),
            status: status.into(),
            priority: 1,
            project_id: Some(1),
            parent_id: None,
            agent: "claude".into(),
            link: String::new(),
            next_step: "run tests".into(),
            sort_order: 0.0,
            created_at: 0,
            updated_at: 0,
            completed_at: None,
        }
    }

    fn act(task_id: i64, kind: &str, body: &str, meta: serde_json::Value, at: i64) -> Activity {
        Activity { id: at, task_id, kind: kind.into(), body: body.into(), meta, created_at: at }
    }

    #[test]
    fn digest_groups_by_task_in_first_touch_order() {
        let tasks = vec![task(1, "Fix login", "waiting"), task(2, "Write docs", "done")];
        let projects = vec![Project { id: 1, name: "web".into(), color: String::new() }];
        let acts = vec![
            act(2, "created", "Write docs", json!({}), 1),
            act(1, "status", "", json!({"from": "todo", "to": "in_progress"}), 2),
            act(2, "completed", "", json!({"from": "todo", "to": "done"}), 3),
            act(1, "parked", "check agent PR", json!({"from": "in_progress", "to": "waiting"}), 4),
        ];
        let open = vec![task(1, "Fix login", "waiting"), task(3, "Untouched", "blocked")];
        let mut prs = PrMap::new();
        prs.insert(
            1,
            vec![PrSnapshot {
                repo: "o/r".into(),
                number: 9,
                title: "Fix it".into(),
                state: "OPEN".into(),
                checks_state: Some("FAILURE".into()),
                ..Default::default()
            }],
        );
        let d = build_digest("Day", &acts, &tasks, &projects, &open, &prs, false);

        let docs = d.find("## Write docs").unwrap();
        let login = d.find("## Fix login").unwrap();
        assert!(docs < login, "ordered by first touch");
        assert!(d.contains("[waiting, P1, project: web, agent: claude]"));
        assert!(d.contains("status todo -> in progress"));
        assert!(d.contains("parked (in progress -> waiting); left off at: check agent PR"));
        assert!(d.contains("Current next step: run tests"));
        let other = d.find("# Other open tasks").unwrap();
        assert!(d.find("## Untouched").unwrap() > other);
        assert_eq!(d.matches("## Fix login").count(), 1, "touched open task not repeated");
        assert!(d.contains("Linked PR o/r#9 \"Fix it\": open, checks: failure"));
    }

    #[test]
    fn empty_digest_says_so() {
        let d = build_digest("Day", &[], &[], &[], &[], &PrMap::new(), false);
        assert!(d.contains("No activity"));
    }

    /// Hits the real CLI: `cargo test -- --ignored live_claude --nocapture`
    #[test]
    #[ignore]
    fn live_claude_call() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let claude = resolve_claude(None);
        let cwd = std::env::temp_dir();
        let digest = "# Activity log

## Fix login [done, P1]
- 09:10 created
- 11:00 completed
";
        match rt.block_on(run_claude(&claude, &cwd, "haiku", DAY_PROMPT, digest)) {
            Ok(md) => {
                println!("OK:
{md}");
                assert!(md.contains("login") || md.contains("Login"));
            }
            Err(e) => {
                println!("ERR: {e}");
                assert!(e.contains("/login"), "only an auth failure is acceptable here: {e}");
            }
        }
    }

    #[test]
    fn auth_errors_get_login_hint() {
        assert!(friendly("Failed to authenticate: OAuth session expired").contains("/login"));
        assert_eq!(friendly("boom"), "boom");
    }
}
