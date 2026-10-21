//! Tauri command layer: thin wrappers around `db` and `summary`.

use crate::db::{self, Activity, IssueRow, NewTask, PrRow, Project, Summary, Task, TaskPatch};
use crate::github::{self, SearchIssue, SearchPr};
use crate::summary;
use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, State};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub data_dir: PathBuf,
    /// Set while a PR refresh is running, so focus/interval triggers don't overlap.
    pub refreshing: AtomicBool,
    /// Currently requested global hotkey and the registration error, if any.
    pub hotkey: Mutex<HotkeyStatus>,
}

#[derive(Clone, Serialize)]
pub struct HotkeyStatus {
    pub combo: String,
    pub error: Option<String>,
}

/// (Re)register the global capture hotkey, replacing any previous one.
pub fn register_hotkey(app: &AppHandle, combo: &str) -> HotkeyStatus {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let error = gs.register(combo).err().map(|e| e.to_string());
    HotkeyStatus { combo: combo.to_string(), error }
}

impl AppState {
    fn conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.db.lock().map_err(|_| "database lock poisoned".to_string())
    }
}

type R<T> = Result<T, String>;

#[tauri::command]
pub fn list_tasks(state: State<AppState>, done_since: i64) -> R<Vec<Task>> {
    db::list_tasks(&*state.conn()?, done_since)
}

#[tauri::command]
pub fn get_task(state: State<AppState>, id: i64) -> R<Task> {
    db::get_task(&*state.conn()?, id)
}

#[tauri::command]
pub fn create_task(state: State<AppState>, input: NewTask) -> R<Task> {
    db::create_task(&*state.conn()?, input)
}

#[tauri::command]
pub fn update_task(state: State<AppState>, id: i64, patch: TaskPatch) -> R<Task> {
    db::update_task(&*state.conn()?, id, patch)
}

#[tauri::command]
pub fn park_task(state: State<AppState>, id: i64, next_step: String, status: Option<String>) -> R<Task> {
    db::park_task(&*state.conn()?, id, &next_step, status)
}

#[tauri::command]
pub fn reorder_tasks(state: State<AppState>, ids: Vec<i64>) -> R<()> {
    db::reorder_tasks(&*state.conn()?, &ids)
}

#[tauri::command]
pub fn archive_task(state: State<AppState>, id: i64) -> R<()> {
    db::archive_task(&*state.conn()?, id)
}

#[tauri::command]
pub fn add_note(state: State<AppState>, task_id: i64, body: String) -> R<Activity> {
    db::add_note(&*state.conn()?, task_id, &body)
}

#[tauri::command]
pub fn delete_note(state: State<AppState>, id: i64) -> R<()> {
    db::delete_activity(&*state.conn()?, id)
}

#[tauri::command]
pub fn task_activity(state: State<AppState>, task_id: i64) -> R<Vec<Activity>> {
    db::task_activity(&*state.conn()?, task_id)
}

#[derive(Serialize)]
pub struct ActivityRange {
    activity: Vec<Activity>,
    tasks: Vec<Task>,
}

#[tauri::command]
pub fn activity_range(state: State<AppState>, from: i64, to: i64) -> R<ActivityRange> {
    let (activity, tasks) = db::activity_range(&*state.conn()?, from, to)?;
    Ok(ActivityRange { activity, tasks })
}

#[tauri::command]
pub fn last_activity_at(state: State<AppState>) -> R<Option<i64>> {
    db::last_activity_at(&*state.conn()?)
}

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> R<Vec<Project>> {
    db::list_projects(&*state.conn()?)
}

#[tauri::command]
pub fn ensure_project(state: State<AppState>, name: String) -> R<Project> {
    db::ensure_project(&*state.conn()?, &name)
}

#[tauri::command]
pub fn update_project(state: State<AppState>, id: i64, name: Option<String>, color: Option<String>) -> R<()> {
    db::update_project(&*state.conn()?, id, name, color)
}

#[tauri::command]
pub fn archive_project(state: State<AppState>, id: i64) -> R<()> {
    db::archive_project(&*state.conn()?, id)
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> R<serde_json::Map<String, serde_json::Value>> {
    db::get_settings(&*state.conn()?)
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> R<()> {
    db::set_setting(&*state.conn()?, &key, &value)
}

#[tauri::command]
pub fn hotkey_status(state: State<AppState>) -> R<HotkeyStatus> {
    Ok(state.hotkey.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn set_hotkey(app: AppHandle, state: State<AppState>, combo: String) -> R<HotkeyStatus> {
    let combo = combo.trim().to_lowercase();
    let effective = if combo.is_empty() { crate::DEFAULT_HOTKEY.to_string() } else { combo.clone() };
    let status = register_hotkey(&app, &effective);
    db::set_setting(&*state.conn()?, "hotkey", &combo)?;
    *state.hotkey.lock().map_err(|e| e.to_string())? = status.clone();
    Ok(status)
}

#[tauri::command]
pub fn get_summary(state: State<AppState>, scope: String, from: i64) -> R<Option<Summary>> {
    db::get_summary(&*state.conn()?, &scope, from)
}

/// Generate (and cache) a summary. `scope` is "day" (a calendar day) or "since" (welcome-back recap).
#[tauri::command]
pub async fn summarize(state: State<'_, AppState>, scope: String, from: i64, to: i64, label: String) -> R<Summary> {
    let (digest, claude, model) = {
        let conn = state.conn()?;
        let (activity, tasks) = db::activity_range(&conn, from, to)?;
        let projects = db::list_projects(&conn)?;
        let (title, open, prompt_kind) = if scope == "since" {
            let open: Vec<Task> = db::list_tasks(&conn, i64::MAX)?
                .into_iter()
                .filter(|t| {
                    matches!(t.status.as_str(), "in_progress" | "waiting" | "in_review" | "blocked")
                        || (t.status == "todo" && t.priority <= 1)
                })
                .collect();
            (format!("Last working session ({label})"), open, true)
        } else {
            (format!("Activity log for {label}"), Vec::new(), false)
        };
        let prs = db::pr_snapshots_by_task(&conn)?;
        let issues = db::issue_snapshots_by_task(&conn)?;
        let linked = summary::Linked { prs: &prs, issues: &issues };
        let digest = summary::build_digest(&title, &activity, &tasks, &projects, &open, &linked, prompt_kind);
        let claude = summary::resolve_claude(db::get_setting(&conn, "claude_path"));
        let model = db::get_setting(&conn, "model").unwrap_or_else(|| "sonnet".into());
        (digest, claude, model)
    };
    let system = if scope == "since" { summary::SINCE_PROMPT } else { summary::DAY_PROMPT };
    let content = summary::run_claude(&claude, &state.data_dir, &model, system, &digest).await?;
    db::save_summary(&*state.conn()?, &scope, from, to, &content)
}

#[tauri::command]
pub async fn test_claude(state: State<'_, AppState>) -> R<String> {
    let claude = summary::resolve_claude(db::get_setting(&*state.conn()?, "claude_path"));
    let version = summary::claude_version(&claude, &state.data_dir).await?;
    Ok(format!("{} ({})", version, claude.display()))
}

// ---------------------------------------------------------------- GitHub: pull requests and issues

fn gh_path(state: &AppState) -> R<PathBuf> {
    Ok(github::resolve_gh(db::get_setting(&*state.conn()?, "gh_path")))
}

fn unique_refs(refs: &[(i64, github::GhRef)]) -> Vec<github::GhRef> {
    let mut u: Vec<github::GhRef> = refs.iter().map(|(_, r)| r.clone()).collect();
    u.sort_by_key(|r| (r.repo(), r.number));
    u.dedup();
    u
}

#[tauri::command]
pub fn list_prs(state: State<AppState>) -> R<Vec<PrRow>> {
    db::list_prs(&*state.conn()?)
}

#[tauri::command]
pub fn list_issues(state: State<AppState>) -> R<Vec<IssueRow>> {
    db::list_issues(&*state.conn()?)
}

/// Fetch the given PR rows and store the results. Holds the DB lock only around reads/writes.
async fn fetch_and_apply(state: &AppState, rows: Vec<PrRow>) -> R<Vec<i64>> {
    let refs: Vec<(i64, github::GhRef)> = rows.iter().filter_map(|r| r.pr_ref().map(|p| (r.id, p))).collect();
    if refs.is_empty() {
        return Ok(vec![]);
    }
    let fetched = github::fetch_prs(&gh_path(state)?, &state.data_dir, &unique_refs(&refs)).await?;
    let results = refs
        .into_iter()
        .map(|(id, p)| (id, fetched.get(&p).cloned().unwrap_or_else(|| Err("not fetched".into()))))
        .collect();
    db::apply_pr_results(&*state.conn()?, results)
}

/// Same as [`fetch_and_apply`] for issues.
async fn fetch_and_apply_issues(state: &AppState, rows: Vec<IssueRow>) -> R<Vec<i64>> {
    let refs: Vec<(i64, github::GhRef)> = rows.iter().filter_map(|r| r.issue_ref().map(|i| (r.id, i))).collect();
    if refs.is_empty() {
        return Ok(vec![]);
    }
    let fetched = github::fetch_issues(&gh_path(state)?, &state.data_dir, &unique_refs(&refs)).await?;
    let results = refs
        .into_iter()
        .map(|(id, i)| (id, fetched.get(&i).cloned().unwrap_or_else(|| Err("not fetched".into()))))
        .collect();
    db::apply_issue_results(&*state.conn()?, results)
}

#[derive(Serialize)]
pub struct LinkResult {
    kind: github::Kind,
    pr: Option<PrRow>,
    issue: Option<IssueRow>,
}

/// Link a PR or issue (URL or `owner/repo#123`) to a task and fetch it right away.
#[tauri::command]
pub async fn link_github(state: State<'_, AppState>, task_id: i64, input: String) -> R<LinkResult> {
    let (r, kind) =
        github::parse_ref(&input).ok_or_else(|| format!("'{}' isn't a GitHub pull request or issue link", input.trim()))?;
    let kind = match kind {
        Some(k) => k,
        None => github::resolve_kind(&gh_path(&state)?, &state.data_dir, &r).await?,
    };
    // A fetch failure is stored on the row and shown in the UI, so it doesn't fail the link.
    match kind {
        github::Kind::Pr => {
            let row = db::link_pr(&*state.conn()?, task_id, &r)?;
            if let Err(e) = fetch_and_apply(&state, vec![row.clone()]).await {
                let _ = db::apply_pr_results(&*state.conn()?, vec![(row.id, Err(e))]);
            }
            Ok(LinkResult { kind, pr: Some(db::get_pr(&*state.conn()?, row.id)?), issue: None })
        }
        github::Kind::Issue => {
            let row = db::link_issue(&*state.conn()?, task_id, &r)?;
            if let Err(e) = fetch_and_apply_issues(&state, vec![row.clone()]).await {
                let _ = db::apply_issue_results(&*state.conn()?, vec![(row.id, Err(e))]);
            }
            Ok(LinkResult { kind, pr: None, issue: Some(db::get_issue(&*state.conn()?, row.id)?) })
        }
    }
}

#[tauri::command]
pub fn unlink_pr(state: State<AppState>, id: i64) -> R<()> {
    db::unlink_pr(&*state.conn()?, id)
}

#[tauri::command]
pub fn unlink_issue(state: State<AppState>, id: i64) -> R<()> {
    db::unlink_issue(&*state.conn()?, id)
}

#[derive(Serialize)]
pub struct RefreshResult {
    prs: Vec<PrRow>,
    issues: Vec<IssueRow>,
    /// Tasks that were marked done because everything linked to them finished.
    completed: Vec<i64>,
    /// Set when a whole fetch failed (gh missing, not logged in, offline).
    error: Option<String>,
    skipped: bool,
}

/// Re-fetch linked PRs and issues (for one task, or all), in parallel.
#[tauri::command]
pub async fn refresh_github(state: State<'_, AppState>, task_id: Option<i64>) -> R<RefreshResult> {
    let lists = |state: &AppState| -> R<(Vec<PrRow>, Vec<IssueRow>)> {
        let conn = state.conn()?;
        Ok((db::list_prs(&conn)?, db::list_issues(&conn)?))
    };
    if state.refreshing.swap(true, Ordering::SeqCst) {
        let (prs, issues) = lists(&state)?;
        return Ok(RefreshResult { prs, issues, completed: vec![], error: None, skipped: true });
    }
    let rows = (|| -> R<_> {
        let conn = state.conn()?;
        Ok((db::prs_to_refresh(&conn, task_id)?, db::issues_to_refresh(&conn, task_id)?))
    })();
    let (pr_outcome, issue_outcome) = match rows {
        Ok((pr_rows, issue_rows)) => {
            tokio::join!(fetch_and_apply(&state, pr_rows), fetch_and_apply_issues(&state, issue_rows))
        }
        Err(e) => (Err(e.clone()), Err(e)),
    };
    state.refreshing.store(false, Ordering::SeqCst);
    let mut completed = Vec::new();
    let mut errors = Vec::new();
    for outcome in [pr_outcome, issue_outcome] {
        match outcome {
            Ok(c) => completed.extend(c),
            Err(e) if !errors.contains(&e) => errors.push(e),
            Err(_) => {}
        }
    }
    let (prs, issues) = lists(&state)?;
    let error = (!errors.is_empty()).then(|| errors.join("; "));
    Ok(RefreshResult { prs, issues, completed, error, skipped: false })
}

/// The user's open PRs that aren't linked to any task yet.
#[tauri::command]
pub async fn untracked_prs(state: State<'_, AppState>) -> R<Vec<SearchPr>> {
    let gh = gh_path(&state)?;
    let mine = github::my_open_prs(&gh, &state.data_dir).await?;
    let linked: std::collections::HashSet<(String, i64)> =
        db::list_prs(&*state.conn()?)?.into_iter().map(|r| (r.repo.to_lowercase(), r.number)).collect();
    Ok(mine.into_iter().filter(|p| !linked.contains(&(p.repo.to_lowercase(), p.number))).collect())
}

/// Open issues for the issue picker (linked ones included; the UI marks them).
#[tauri::command]
pub async fn search_issues(
    state: State<'_, AppState>,
    scope: github::IssueScope,
    repo: Option<String>,
    query: String,
) -> R<Vec<SearchIssue>> {
    let gh = gh_path(&state)?;
    github::search_issues(&gh, &state.data_dir, scope, repo.as_deref(), &query).await
}

#[tauri::command]
pub async fn test_gh(state: State<'_, AppState>) -> R<String> {
    let gh = gh_path(&state)?;
    github::auth_status(&gh, &state.data_dir).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real end-to-end through gh:
    /// `WORKLOGGER_LIVE_PR=owner/repo#123 cargo test -- --ignored live_link --nocapture`
    #[test]
    #[ignore]
    fn live_link_and_refresh() {
        let Some(pr) = std::env::var("WORKLOGGER_LIVE_PR").ok().and_then(|v| github::parse_pr(&v)) else {
            println!("skipped: set WORKLOGGER_LIVE_PR=owner/repo#123");
            return;
        };
        let conn = Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: std::env::temp_dir(),
            hotkey: Mutex::new(HotkeyStatus { combo: String::new(), error: None }),
            refreshing: AtomicBool::new(false),
        };
        let task = db::create_task(&state.conn().unwrap(), NewTask { title: "Live test".into(), ..Default::default() }).unwrap();
        let row = db::link_pr(&state.conn().unwrap(), task.id, &pr).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        let completed = rt.block_on(fetch_and_apply(&state, vec![row.clone()])).unwrap();
        assert!(completed.is_empty());
        let stored = db::get_pr(&state.conn().unwrap(), row.id).unwrap();
        let snap = stored.data.expect("snapshot stored");
        println!("stored: {}", snap.digest_line());
        assert_eq!(snap.number, pr.number);

        // A second refresh with unchanged data logs nothing new.
        let before = db::task_activity(&state.conn().unwrap(), task.id).unwrap().len();
        let rows = db::prs_to_refresh(&state.conn().unwrap(), None).unwrap();
        rt.block_on(fetch_and_apply(&state, rows)).unwrap();
        let after = db::task_activity(&state.conn().unwrap(), task.id).unwrap().len();
        assert_eq!(before, after, "no spurious events on an unchanged PR");

        let prs = db::pr_snapshots_by_task(&state.conn().unwrap()).unwrap();
        let (activity, tasks) = db::activity_range(&state.conn().unwrap(), 0, i64::MAX).unwrap();
        let issues = summary::IssueMap::new();
        let digest = summary::build_digest("Test", &activity, &tasks, &[], &[], &summary::Linked { prs: &prs, issues: &issues }, false);
        println!("{digest}");
        assert!(digest.contains(&format!("Linked PR {}", pr.label())));
    }
}
