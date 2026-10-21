//! Tauri command layer: thin wrappers around `db` and `summary`.

use crate::db::{self, Activity, NewTask, PrRow, Project, Summary, Task, TaskPatch};
use crate::github::{self, SearchPr};
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
        let digest = summary::build_digest(&title, &activity, &tasks, &projects, &open, &prs, prompt_kind);
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

// ---------------------------------------------------------------- pull requests

fn gh_path(state: &AppState) -> R<PathBuf> {
    Ok(github::resolve_gh(db::get_setting(&*state.conn()?, "gh_path")))
}

#[tauri::command]
pub fn list_prs(state: State<AppState>) -> R<Vec<PrRow>> {
    db::list_prs(&*state.conn()?)
}

/// Fetch the given PR rows and store the results. Holds the DB lock only around reads/writes.
async fn fetch_and_apply(state: &AppState, rows: Vec<PrRow>) -> R<Vec<i64>> {
    let refs: Vec<(i64, github::PrRef)> = rows.iter().filter_map(|r| r.pr_ref().map(|p| (r.id, p))).collect();
    if refs.is_empty() {
        return Ok(vec![]);
    }
    let gh = gh_path(state)?;
    let unique: Vec<github::PrRef> = {
        let mut u: Vec<github::PrRef> = refs.iter().map(|(_, p)| p.clone()).collect();
        u.sort_by_key(|p| (p.repo(), p.number));
        u.dedup();
        u
    };
    let fetched = github::fetch_prs(&gh, &state.data_dir, &unique).await?;
    let results = refs
        .into_iter()
        .map(|(id, p)| (id, fetched.get(&p).cloned().unwrap_or_else(|| Err("not fetched".into()))))
        .collect();
    db::apply_pr_results(&*state.conn()?, results)
}

#[tauri::command]
pub async fn link_pr(state: State<'_, AppState>, task_id: i64, input: String) -> R<PrRow> {
    let pr = github::parse_pr(&input).ok_or_else(|| format!("'{}' isn't a GitHub pull request link", input.trim()))?;
    let row = db::link_pr(&*state.conn()?, task_id, &pr)?;
    // Fetch right away; a failure is stored on the row and shown in the UI.
    if let Err(e) = fetch_and_apply(&state, vec![row.clone()]).await {
        let _ = db::apply_pr_results(&*state.conn()?, vec![(row.id, Err(e))]);
    }
    db::get_pr(&*state.conn()?, row.id)
}

#[tauri::command]
pub fn unlink_pr(state: State<AppState>, id: i64) -> R<()> {
    db::unlink_pr(&*state.conn()?, id)
}

#[derive(Serialize)]
pub struct RefreshResult {
    prs: Vec<PrRow>,
    /// Tasks that were marked done because their PRs merged.
    completed: Vec<i64>,
    /// Set when the whole refresh failed (gh missing, not logged in, offline).
    error: Option<String>,
    skipped: bool,
}

#[tauri::command]
pub async fn refresh_prs(state: State<'_, AppState>, task_id: Option<i64>) -> R<RefreshResult> {
    if state.refreshing.swap(true, Ordering::SeqCst) {
        return Ok(RefreshResult { prs: db::list_prs(&*state.conn()?)?, completed: vec![], error: None, skipped: true });
    }
    let rows = db::prs_to_refresh(&*state.conn()?, task_id);
    let outcome = match rows {
        Ok(rows) => fetch_and_apply(&state, rows).await,
        Err(e) => Err(e),
    };
    state.refreshing.store(false, Ordering::SeqCst);
    let (completed, error) = match outcome {
        Ok(c) => (c, None),
        Err(e) => (vec![], Some(e)),
    };
    Ok(RefreshResult { prs: db::list_prs(&*state.conn()?)?, completed, error, skipped: false })
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
        let digest = summary::build_digest("Test", &activity, &tasks, &[], &[], &prs, false);
        println!("{digest}");
        assert!(digest.contains(&format!("Linked PR {}", pr.label())));
    }
}
