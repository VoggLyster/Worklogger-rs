//! SQLite storage: schema migrations and every read/write the app performs.
//! All functions take a plain `&Connection` so they can be unit tested without Tauri.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::github::{GhRef, IssueSnapshot, PrSnapshot};

pub type DbResult<T> = Result<T, String>;

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub const STATUSES: &[&str] = &["backlog", "todo", "in_progress", "waiting", "in_review", "blocked", "done"];

const MIGRATIONS: &[&str] = &[
    // v1: initial schema
    r#"
    CREATE TABLE projects (
        id        INTEGER PRIMARY KEY,
        name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color     TEXT NOT NULL DEFAULT '#6366f1',
        archived  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
        id           INTEGER PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'todo',
        priority     INTEGER NOT NULL DEFAULT 2,
        project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        parent_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        agent        TEXT NOT NULL DEFAULT '',
        link         TEXT NOT NULL DEFAULT '',
        next_step    TEXT NOT NULL DEFAULT '',
        sort_order   REAL NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        completed_at INTEGER,
        archived     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE TABLE activity (
        id         INTEGER PRIMARY KEY,
        task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        meta_json  TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_activity_created ON activity(created_at);
    CREATE INDEX idx_activity_task ON activity(task_id, created_at);
    CREATE TABLE summaries (
        id         INTEGER PRIMARY KEY,
        scope      TEXT NOT NULL,
        from_ts    INTEGER NOT NULL,
        to_ts      INTEGER NOT NULL,
        content_md TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_summaries_key ON summaries(scope, from_ts);
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v2: pull requests linked to tasks, with the last fetched snapshot
    r#"
    CREATE TABLE prs (
        id          INTEGER PRIMARY KEY,
        task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repo        TEXT NOT NULL,
        number      INTEGER NOT NULL,
        data_json   TEXT,
        fetched_at  INTEGER,
        fetch_error TEXT,
        created_at  INTEGER NOT NULL,
        UNIQUE (task_id, repo, number)
    );
    CREATE INDEX idx_prs_task ON prs(task_id);
    "#,
    // v3: GitHub issues linked to tasks, same shape as prs
    r#"
    CREATE TABLE issues (
        id          INTEGER PRIMARY KEY,
        task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repo        TEXT NOT NULL,
        number      INTEGER NOT NULL,
        data_json   TEXT,
        fetched_at  INTEGER,
        fetch_error TEXT,
        created_at  INTEGER NOT NULL,
        UNIQUE (task_id, repo, number)
    );
    CREATE INDEX idx_issues_task ON issues(task_id);
    "#,
];

pub fn open(path: &std::path::Path) -> DbResult<Connection> {
    let conn = Connection::open(path).map_err(err)?;
    init(&conn)?;
    Ok(conn)
}

fn row_count(path: &std::path::Path) -> Option<i64> {
    let c = Connection::open(path).ok()?;
    c.query_row("SELECT (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM activity)", [], |r| r.get(0)).ok()
}

fn remove_db_files(path: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

/// One-time copy of the database from the app's previous name/location (Handoff, `com.soeren.handoff`).
/// Runs while the new database doesn't exist or has never been used; the old file is kept as a backup.
pub fn migrate_legacy(legacy: &std::path::Path, target: &std::path::Path) -> DbResult<bool> {
    if !legacy.exists() || target.exists() && row_count(target).unwrap_or(1) > 0 {
        return Ok(false);
    }
    // VACUUM INTO writes a consistent single-file copy, including anything still in the WAL. The old app may
    // still be running and writing, so verify the copy against a fresh look at the source and retry if short.
    for _ in 0..3 {
        remove_db_files(target);
        let old = Connection::open(legacy).map_err(err)?;
        old.execute("VACUUM INTO ?1", [target.to_string_lossy()]).map_err(err)?;
        drop(old);
        if row_count(target).unwrap_or(0) >= row_count(legacy).unwrap_or(0) {
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    remove_db_files(target);
    Err(format!("copy of {} came out incomplete; will retry on next launch", legacy.display()))
}

pub fn init(conn: &Connection) -> DbResult<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")
        .map_err(err)?;
    let version: usize = conn
        .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .map_err(err)? as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1))
            .map_err(err)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- types

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: i64,
    pub project_id: Option<i64>,
    pub parent_id: Option<i64>,
    pub agent: String,
    pub link: String,
    pub next_step: String,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Activity {
    pub id: i64,
    pub task_id: i64,
    pub kind: String,
    pub body: String,
    pub meta: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Summary {
    pub id: i64,
    pub scope: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub content_md: String,
    pub created_at: i64,
}

#[derive(Debug, Default, Deserialize)]
pub struct NewTask {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub project_id: Option<i64>,
    /// Convenience for quick capture: resolves (or creates) a project by name.
    pub project_name: Option<String>,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub link: String,
    #[serde(default)]
    pub next_step: String,
}

/// Partial update. `project_id: Some(None)` clears the project.
#[derive(Debug, Default, Deserialize)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub project_id: Option<Option<i64>>,
    pub agent: Option<String>,
    pub link: Option<String>,
    pub next_step: Option<String>,
}

fn double_option<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
    Ok(Some(Option::<i64>::deserialize(d)?))
}

// ---------------------------------------------------------------- rows

const TASK_COLS: &str = "id, title, description, status, priority, project_id, parent_id, agent, link, \
                         next_step, sort_order, created_at, updated_at, completed_at";

fn task_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        description: r.get(2)?,
        status: r.get(3)?,
        priority: r.get(4)?,
        project_id: r.get(5)?,
        parent_id: r.get(6)?,
        agent: r.get(7)?,
        link: r.get(8)?,
        next_step: r.get(9)?,
        sort_order: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        completed_at: r.get(13)?,
    })
}

fn activity_row(r: &Row) -> rusqlite::Result<Activity> {
    let meta: String = r.get(4)?;
    Ok(Activity {
        id: r.get(0)?,
        task_id: r.get(1)?,
        kind: r.get(2)?,
        body: r.get(3)?,
        meta: serde_json::from_str(&meta).unwrap_or(serde_json::Value::Null),
        created_at: r.get(5)?,
    })
}

fn summary_row(r: &Row) -> rusqlite::Result<Summary> {
    Ok(Summary {
        id: r.get(0)?,
        scope: r.get(1)?,
        from_ts: r.get(2)?,
        to_ts: r.get(3)?,
        content_md: r.get(4)?,
        created_at: r.get(5)?,
    })
}

// ---------------------------------------------------------------- projects

pub fn list_projects(conn: &Connection) -> DbResult<Vec<Project>> {
    let mut stmt = conn
        .prepare("SELECT id, name, color FROM projects WHERE archived = 0 ORDER BY name")
        .map_err(err)?;
    let rows = stmt
        .query_map([], |r| Ok(Project { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? }))
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

const PROJECT_COLORS: &[&str] = &["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];

/// Returns the project with this name (case-insensitive), creating it if needed.
pub fn ensure_project(conn: &Connection, name: &str) -> DbResult<Project> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name is empty".into());
    }
    if let Some(p) = conn
        .query_row("SELECT id, name, color FROM projects WHERE name = ?1", [name], |r| {
            Ok(Project { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? })
        })
        .optional()
        .map_err(err)?
    {
        conn.execute("UPDATE projects SET archived = 0 WHERE id = ?1", [p.id]).map_err(err)?;
        return Ok(p);
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).map_err(err)?;
    let color = PROJECT_COLORS[(count as usize) % PROJECT_COLORS.len()];
    conn.execute("INSERT INTO projects (name, color) VALUES (?1, ?2)", params![name, color])
        .map_err(err)?;
    Ok(Project { id: conn.last_insert_rowid(), name: name.to_string(), color: color.to_string() })
}

pub fn update_project(conn: &Connection, id: i64, name: Option<String>, color: Option<String>) -> DbResult<()> {
    if let Some(n) = name {
        conn.execute("UPDATE projects SET name = ?1 WHERE id = ?2", params![n.trim(), id]).map_err(err)?;
    }
    if let Some(c) = color {
        conn.execute("UPDATE projects SET color = ?1 WHERE id = ?2", params![c, id]).map_err(err)?;
    }
    Ok(())
}

pub fn archive_project(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("UPDATE projects SET archived = 1 WHERE id = ?1", [id]).map_err(err)?;
    conn.execute("UPDATE tasks SET project_id = NULL WHERE project_id = ?1", [id]).map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------- tasks

pub fn get_task(conn: &Connection, id: i64) -> DbResult<Task> {
    conn.query_row(&format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"), [id], task_row)
        .map_err(err)
}

/// All open (non-done) tasks plus tasks completed at or after `done_since`.
pub fn list_tasks(conn: &Connection, done_since: i64) -> DbResult<Vec<Task>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks
             WHERE archived = 0 AND (status != 'done' OR completed_at >= ?1)
             ORDER BY priority, sort_order, id"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([done_since], task_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn log_activity(
    conn: &Connection,
    task_id: i64,
    kind: &str,
    body: &str,
    meta: serde_json::Value,
    at: i64,
) -> DbResult<Activity> {
    conn.execute(
        "INSERT INTO activity (task_id, kind, body, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task_id, kind, body, meta.to_string(), at],
    )
    .map_err(err)?;
    Ok(Activity { id: conn.last_insert_rowid(), task_id, kind: kind.into(), body: body.into(), meta, created_at: at })
}

fn check_status(s: &str) -> DbResult<()> {
    if STATUSES.contains(&s) { Ok(()) } else { Err(format!("Unknown status '{s}'")) }
}

pub fn create_task(conn: &Connection, input: NewTask) -> DbResult<Task> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Title is empty".into());
    }
    let status = input.status.unwrap_or_else(|| "todo".into());
    check_status(&status)?;
    let priority = input.priority.unwrap_or(2).clamp(0, 3);
    let project_id = match (input.project_id, input.project_name.as_deref()) {
        (Some(id), _) => Some(id),
        (None, Some(name)) if !name.trim().is_empty() => Some(ensure_project(conn, name)?.id),
        _ => None,
    };
    let now = now_ms();
    // New tasks go to the top of their priority band.
    let min_order: f64 = conn
        .query_row("SELECT COALESCE(MIN(sort_order), 0) FROM tasks WHERE archived = 0", [], |r| r.get(0))
        .map_err(err)?;
    let completed_at = (status == "done").then_some(now);

    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute(
        "INSERT INTO tasks (title, description, status, priority, project_id, agent, link, next_step,
                            sort_order, created_at, updated_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)",
        params![
            title,
            input.description,
            status,
            priority,
            project_id,
            input.agent.trim(),
            input.link.trim(),
            input.next_step.trim(),
            min_order - 1.0,
            now,
            completed_at
        ],
    )
    .map_err(err)?;
    let id = tx.last_insert_rowid();
    log_activity(&tx, id, "created", title, json!({ "status": status, "priority": priority }), now)?;
    tx.commit().map_err(err)?;
    get_task(conn, id)
}

pub fn update_task(conn: &Connection, id: i64, patch: TaskPatch) -> DbResult<Task> {
    let before = get_task(conn, id)?;
    let now = now_ms();
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut edited: Vec<&str> = Vec::new();

    if let Some(title) = patch.title.as_deref().map(str::trim) {
        if !title.is_empty() && title != before.title {
            tx.execute("UPDATE tasks SET title = ?1 WHERE id = ?2", params![title, id]).map_err(err)?;
            edited.push("title");
        }
    }
    if let Some(d) = &patch.description {
        if *d != before.description {
            tx.execute("UPDATE tasks SET description = ?1 WHERE id = ?2", params![d, id]).map_err(err)?;
            edited.push("description");
        }
    }
    if let Some(a) = patch.agent.as_deref().map(str::trim) {
        if a != before.agent {
            tx.execute("UPDATE tasks SET agent = ?1 WHERE id = ?2", params![a, id]).map_err(err)?;
            edited.push("agent");
        }
    }
    if let Some(l) = patch.link.as_deref().map(str::trim) {
        if l != before.link {
            tx.execute("UPDATE tasks SET link = ?1 WHERE id = ?2", params![l, id]).map_err(err)?;
            edited.push("link");
        }
    }
    if let Some(p) = patch.project_id {
        if p != before.project_id {
            tx.execute("UPDATE tasks SET project_id = ?1 WHERE id = ?2", params![p, id]).map_err(err)?;
            edited.push("project");
        }
    }
    if !edited.is_empty() {
        log_activity(&tx, id, "edited", "", json!({ "fields": edited }), now)?;
    }
    if let Some(ns) = patch.next_step.as_deref().map(str::trim) {
        if ns != before.next_step {
            tx.execute("UPDATE tasks SET next_step = ?1 WHERE id = ?2", params![ns, id]).map_err(err)?;
            if !ns.is_empty() {
                log_activity(&tx, id, "next_step", ns, json!({}), now)?;
            }
        }
    }
    if let Some(p) = patch.priority.map(|p| p.clamp(0, 3)) {
        if p != before.priority {
            tx.execute("UPDATE tasks SET priority = ?1 WHERE id = ?2", params![p, id]).map_err(err)?;
            log_activity(&tx, id, "priority", "", json!({ "from": before.priority, "to": p }), now)?;
        }
    }
    if let Some(s) = &patch.status {
        if *s != before.status {
            apply_status(&tx, &before, s, now)?;
            let kind = status_kind(&before.status, s);
            log_activity(&tx, id, kind, "", json!({ "from": before.status, "to": s }), now)?;
        }
    }
    tx.execute("UPDATE tasks SET updated_at = ?1 WHERE id = ?2", params![now, id]).map_err(err)?;
    tx.commit().map_err(err)?;
    get_task(conn, id)
}

fn status_kind(from: &str, to: &str) -> &'static str {
    match (from, to) {
        (_, "done") => "completed",
        ("done", _) => "reopened",
        _ => "status",
    }
}

fn apply_status(conn: &Connection, before: &Task, to: &str, now: i64) -> DbResult<()> {
    check_status(to)?;
    let completed_at = if to == "done" { Some(now) } else { None };
    conn.execute(
        "UPDATE tasks SET status = ?1, completed_at = ?2 WHERE id = ?3",
        params![to, completed_at, before.id],
    )
    .map_err(err)?;
    Ok(())
}

/// Context switch away from a task: record where it was left and (optionally) move it to a new status.
pub fn park_task(conn: &Connection, id: i64, next_step: &str, status: Option<String>) -> DbResult<Task> {
    let before = get_task(conn, id)?;
    let now = now_ms();
    let next_step = next_step.trim();
    let to = status.unwrap_or_else(|| before.status.clone());
    let tx = conn.unchecked_transaction().map_err(err)?;
    if to != before.status {
        apply_status(&tx, &before, &to, now)?;
    }
    tx.execute(
        "UPDATE tasks SET next_step = ?1, updated_at = ?2 WHERE id = ?3",
        params![next_step, now, id],
    )
    .map_err(err)?;
    let kind = if to == "done" { "completed" } else { "parked" };
    log_activity(&tx, id, kind, next_step, json!({ "from": before.status, "to": to }), now)?;
    tx.commit().map_err(err)?;
    get_task(conn, id)
}

/// Assign `sort_order` by position in `ids`.
pub fn reorder_tasks(conn: &Connection, ids: &[i64]) -> DbResult<()> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE tasks SET sort_order = ?1 WHERE id = ?2", params![i as f64, id]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

pub fn archive_task(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("UPDATE tasks SET archived = 1, updated_at = ?1 WHERE id = ?2", params![now_ms(), id])
        .map_err(err)?;
    Ok(())
}

pub fn add_note(conn: &Connection, task_id: i64, body: &str) -> DbResult<Activity> {
    let body = body.trim();
    if body.is_empty() {
        return Err("Note is empty".into());
    }
    let now = now_ms();
    let a = log_activity(conn, task_id, "note", body, json!({}), now)?;
    conn.execute("UPDATE tasks SET updated_at = ?1 WHERE id = ?2", params![now, task_id]).map_err(err)?;
    Ok(a)
}

pub fn delete_activity(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM activity WHERE id = ?1 AND kind = 'note'", [id]).map_err(err)?;
    Ok(())
}

pub fn task_activity(conn: &Connection, task_id: i64) -> DbResult<Vec<Activity>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, kind, body, meta_json, created_at FROM activity
             WHERE task_id = ?1 ORDER BY created_at DESC, id DESC",
        )
        .map_err(err)?;
    let rows = stmt.query_map([task_id], activity_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

/// Activity in `[from, to)`, oldest first, together with every task it touches (archived included).
pub fn activity_range(conn: &Connection, from: i64, to: i64) -> DbResult<(Vec<Activity>, Vec<Task>)> {
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, kind, body, meta_json, created_at FROM activity
             WHERE created_at >= ?1 AND created_at < ?2 ORDER BY created_at, id",
        )
        .map_err(err)?;
    let acts: Vec<Activity> = stmt
        .query_map([from, to], activity_row)
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks WHERE id IN
             (SELECT DISTINCT task_id FROM activity WHERE created_at >= ?1 AND created_at < ?2)"
        ))
        .map_err(err)?;
    let tasks = stmt
        .query_map([from, to], task_row)
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok((acts, tasks))
}

/// Last activity *by the user* (automated PR/issue events don't count), for the welcome-back gap.
pub fn last_activity_at(conn: &Connection) -> DbResult<Option<i64>> {
    conn.query_row(
        "SELECT MAX(created_at) FROM activity
         WHERE kind NOT IN ('pr', 'issue') AND COALESCE(json_extract(meta_json, '$.auto'), 0) = 0",
        [],
        |r| r.get(0),
    )
    .map_err(err)
}

// ---------------------------------------------------------------- pull requests

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PrRow {
    pub id: i64,
    pub task_id: i64,
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub data: Option<PrSnapshot>,
    pub fetched_at: Option<i64>,
    pub fetch_error: Option<String>,
}

impl PrRow {
    pub fn pr_ref(&self) -> Option<GhRef> {
        crate::github::parse_pr(&format!("{}#{}", self.repo, self.number))
    }
    fn state(&self) -> Option<&str> {
        self.data.as_ref().map(|d| d.state.as_str())
    }
}

const PR_COLS: &str = "p.id, p.task_id, p.repo, p.number, p.data_json, p.fetched_at, p.fetch_error";

fn pr_row(r: &Row) -> rusqlite::Result<PrRow> {
    let repo: String = r.get(2)?;
    let number: i64 = r.get(3)?;
    let data: Option<String> = r.get(4)?;
    Ok(PrRow {
        id: r.get(0)?,
        task_id: r.get(1)?,
        url: format!("https://github.com/{repo}/pull/{number}"),
        repo,
        number,
        data: data.and_then(|d| serde_json::from_str(&d).ok()),
        fetched_at: r.get(5)?,
        fetch_error: r.get(6)?,
    })
}

fn query_prs(conn: &Connection, filter: &str, p: impl rusqlite::Params) -> DbResult<Vec<PrRow>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PR_COLS} FROM prs p JOIN tasks t ON t.id = p.task_id WHERE t.archived = 0 {filter} ORDER BY p.id"
        ))
        .map_err(err)?;
    let rows = stmt.query_map(p, pr_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn list_prs(conn: &Connection) -> DbResult<Vec<PrRow>> {
    query_prs(conn, "", [])
}

pub fn get_pr(conn: &Connection, id: i64) -> DbResult<PrRow> {
    conn.query_row(&format!("SELECT {PR_COLS} FROM prs p WHERE p.id = ?1"), [id], pr_row).map_err(err)
}

/// PRs worth re-fetching: not yet seen as merged (closed ones can be reopened).
pub fn prs_to_refresh(conn: &Connection, task_id: Option<i64>) -> DbResult<Vec<PrRow>> {
    let rows = match task_id {
        Some(id) => query_prs(conn, "AND p.task_id = ?1", [id])?,
        None => query_prs(conn, "", [])?,
    };
    Ok(rows.into_iter().filter(|r| r.state() != Some("MERGED")).collect())
}

pub fn link_pr(conn: &Connection, task_id: i64, pr: &GhRef) -> DbResult<PrRow> {
    let now = now_ms();
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO prs (task_id, repo, number, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![task_id, pr.repo(), pr.number, now],
        )
        .map_err(err)?;
    if inserted > 0 {
        let meta = json!({ "repo": pr.repo(), "number": pr.number, "event": "linked" });
        log_activity(conn, task_id, "pr", &format!("{}: linked", pr.label()), meta, now)?;
    }
    conn.query_row(
        &format!("SELECT {PR_COLS} FROM prs p WHERE p.task_id = ?1 AND p.repo = ?2 AND p.number = ?3"),
        params![task_id, pr.repo(), pr.number],
        pr_row,
    )
    .map_err(err)
}

pub fn unlink_pr(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM prs WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

/// Store fetch results, log notable changes as activity, and complete tasks whose PRs all merged.
/// Returns the ids of tasks that were auto-completed.
pub fn apply_pr_results(conn: &Connection, results: Vec<(i64, Result<PrSnapshot, String>)>) -> DbResult<Vec<i64>> {
    let now = now_ms();
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut newly_merged: Vec<i64> = Vec::new();
    let mut newly_ready: Vec<i64> = Vec::new();
    for (id, result) in results {
        let Ok(row) = get_pr(&tx, id) else { continue };
        match result {
            Ok(snap) => {
                // Ready for review: first seen open and non-draft, or just left draft.
                let ready_now = snap.state == "OPEN" && !snap.is_draft;
                let was_ready = row.data.as_ref().is_some_and(|o| o.state == "OPEN" && !o.is_draft);
                if ready_now && !was_ready && !newly_ready.contains(&row.task_id) {
                    newly_ready.push(row.task_id);
                }
                if let Some(old) = &row.data {
                    let events = crate::github::diff_events(old, &snap);
                    for (event, text) in &events {
                        let body = format!("{}#{}: {text}", row.repo, row.number);
                        let meta = json!({ "repo": row.repo, "number": row.number, "event": event });
                        log_activity(&tx, row.task_id, "pr", &body, meta, now)?;
                        if *event == "merged" && !newly_merged.contains(&row.task_id) {
                            newly_merged.push(row.task_id);
                        }
                    }
                    if !events.is_empty() {
                        tx.execute("UPDATE tasks SET updated_at = ?1 WHERE id = ?2", params![now, row.task_id])
                            .map_err(err)?;
                    }
                }
                let data = serde_json::to_string(&snap).map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE prs SET data_json = ?1, fetched_at = ?2, fetch_error = NULL WHERE id = ?3",
                    params![data, now, id],
                )
                .map_err(err)?;
            }
            Err(e) => {
                tx.execute("UPDATE prs SET fetch_error = ?1, fetched_at = ?2 WHERE id = ?3", params![e, now, id])
                    .map_err(err)?;
            }
        }
    }

    // A PR going up for review moves active work to In review (never out of blocked/backlog/done).
    for task_id in newly_ready {
        let task = get_task(&tx, task_id)?;
        if matches!(task.status.as_str(), "todo" | "in_progress" | "waiting") {
            apply_status(&tx, &task, "in_review", now)?;
            let meta = json!({ "from": task.status, "to": "in_review", "auto": true });
            log_activity(&tx, task_id, "status", "PR ready for review", meta, now)?;
            tx.execute("UPDATE tasks SET updated_at = ?1 WHERE id = ?2", params![now, task_id]).map_err(err)?;
        }
    }

    // Only on the transition to merged, so reopening a task by hand sticks.
    let mut completed = Vec::new();
    for task_id in newly_merged {
        if complete_if_all_finished(&tx, task_id, now)? {
            completed.push(task_id);
        }
    }
    tx.commit().map_err(err)?;
    Ok(completed)
}

/// Mark a task done once everything linked to it is finished: every PR merged or closed, every issue closed,
/// and at least one PR merged or issue closed as completed. Callers only invoke this right after something
/// linked finished, so a task reopened by hand stays open.
fn complete_if_all_finished(tx: &Connection, task_id: i64, now: i64) -> DbResult<bool> {
    let task = get_task(tx, task_id)?;
    if task.status == "done" {
        return Ok(false);
    }
    let prs = query_prs(tx, "AND p.task_id = ?1", [task_id])?;
    let issues = query_issues(tx, "AND i.task_id = ?1", [task_id])?;
    let prs_finished = prs.iter().all(|p| matches!(p.state(), Some("MERGED") | Some("CLOSED")));
    let issues_finished = issues.iter().all(|i| i.data.as_ref().is_some_and(|d| d.state == "CLOSED"));
    let any_success = prs.iter().any(|p| p.state() == Some("MERGED"))
        || issues.iter().any(|i| i.data.as_ref().is_some_and(|d| d.completed()));
    if !(prs_finished && issues_finished && any_success) {
        return Ok(false);
    }
    let body = match (prs.len(), issues.len()) {
        (1, 0) => "PR merged",
        (_, 0) => "All linked PRs merged",
        (0, 1) => "Issue closed",
        (0, _) => "All linked issues closed",
        _ => "All linked PRs and issues finished",
    };
    apply_status(tx, &task, "done", now)?;
    let meta = json!({ "from": task.status, "to": "done", "auto": true });
    log_activity(tx, task_id, "completed", body, meta, now)?;
    tx.execute("UPDATE tasks SET updated_at = ?1 WHERE id = ?2", params![now, task_id]).map_err(err)?;
    Ok(true)
}

// ---------------------------------------------------------------- issues

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IssueRow {
    pub id: i64,
    pub task_id: i64,
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub data: Option<IssueSnapshot>,
    pub fetched_at: Option<i64>,
    pub fetch_error: Option<String>,
}

impl IssueRow {
    pub fn issue_ref(&self) -> Option<GhRef> {
        crate::github::parse_issue(&format!("{}#{}", self.repo, self.number))
    }
}

const ISSUE_COLS: &str = "i.id, i.task_id, i.repo, i.number, i.data_json, i.fetched_at, i.fetch_error";

fn issue_row(r: &Row) -> rusqlite::Result<IssueRow> {
    let repo: String = r.get(2)?;
    let number: i64 = r.get(3)?;
    let data: Option<String> = r.get(4)?;
    Ok(IssueRow {
        id: r.get(0)?,
        task_id: r.get(1)?,
        url: format!("https://github.com/{repo}/issues/{number}"),
        repo,
        number,
        data: data.and_then(|d| serde_json::from_str(&d).ok()),
        fetched_at: r.get(5)?,
        fetch_error: r.get(6)?,
    })
}

fn query_issues(conn: &Connection, filter: &str, p: impl rusqlite::Params) -> DbResult<Vec<IssueRow>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ISSUE_COLS} FROM issues i JOIN tasks t ON t.id = i.task_id WHERE t.archived = 0 {filter} ORDER BY i.id"
        ))
        .map_err(err)?;
    let rows = stmt.query_map(p, issue_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn list_issues(conn: &Connection) -> DbResult<Vec<IssueRow>> {
    query_issues(conn, "", [])
}

pub fn get_issue(conn: &Connection, id: i64) -> DbResult<IssueRow> {
    conn.query_row(&format!("SELECT {ISSUE_COLS} FROM issues i WHERE i.id = ?1"), [id], issue_row).map_err(err)
}

/// Issues worth re-fetching: not yet seen as closed.
pub fn issues_to_refresh(conn: &Connection, task_id: Option<i64>) -> DbResult<Vec<IssueRow>> {
    let rows = match task_id {
        Some(id) => query_issues(conn, "AND i.task_id = ?1", [id])?,
        None => query_issues(conn, "", [])?,
    };
    Ok(rows.into_iter().filter(|r| r.data.as_ref().map(|d| d.state.as_str()) != Some("CLOSED")).collect())
}

pub fn link_issue(conn: &Connection, task_id: i64, issue: &GhRef) -> DbResult<IssueRow> {
    let now = now_ms();
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO issues (task_id, repo, number, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![task_id, issue.repo(), issue.number, now],
        )
        .map_err(err)?;
    if inserted > 0 {
        let meta = json!({ "repo": issue.repo(), "number": issue.number, "event": "linked" });
        log_activity(conn, task_id, "issue", &format!("{}: linked", issue.label()), meta, now)?;
    }
    conn.query_row(
        &format!("SELECT {ISSUE_COLS} FROM issues i WHERE i.task_id = ?1 AND i.repo = ?2 AND i.number = ?3"),
        params![task_id, issue.repo(), issue.number],
        issue_row,
    )
    .map_err(err)
}

pub fn unlink_issue(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM issues WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

/// Store fetched issue snapshots, log notable changes, and complete tasks whose linked work all finished.
/// Returns the ids of tasks that were auto-completed.
pub fn apply_issue_results(conn: &Connection, results: Vec<(i64, Result<IssueSnapshot, String>)>) -> DbResult<Vec<i64>> {
    let now = now_ms();
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut newly_closed: Vec<i64> = Vec::new();
    for (id, result) in results {
        let Ok(row) = get_issue(&tx, id) else { continue };
        match result {
            Ok(snap) => {
                if let Some(old) = &row.data {
                    let events = crate::github::diff_issue_events(old, &snap);
                    for (event, text) in &events {
                        let body = format!("{}#{}: {text}", row.repo, row.number);
                        let meta = json!({ "repo": row.repo, "number": row.number, "event": event });
                        log_activity(&tx, row.task_id, "issue", &body, meta, now)?;
                        if event.starts_with("closed") && !newly_closed.contains(&row.task_id) {
                            newly_closed.push(row.task_id);
                        }
                    }
                    if !events.is_empty() {
                        tx.execute("UPDATE tasks SET updated_at = ?1 WHERE id = ?2", params![now, row.task_id])
                            .map_err(err)?;
                    }
                }
                let data = serde_json::to_string(&snap).map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE issues SET data_json = ?1, fetched_at = ?2, fetch_error = NULL WHERE id = ?3",
                    params![data, now, id],
                )
                .map_err(err)?;
            }
            Err(e) => {
                tx.execute("UPDATE issues SET fetch_error = ?1, fetched_at = ?2 WHERE id = ?3", params![e, now, id])
                    .map_err(err)?;
            }
        }
    }
    let mut completed = Vec::new();
    for task_id in newly_closed {
        if complete_if_all_finished(&tx, task_id, now)? {
            completed.push(task_id);
        }
    }
    tx.commit().map_err(err)?;
    Ok(completed)
}

pub fn issue_snapshots_by_task(conn: &Connection) -> DbResult<std::collections::HashMap<i64, Vec<IssueSnapshot>>> {
    let mut map: std::collections::HashMap<i64, Vec<IssueSnapshot>> = std::collections::HashMap::new();
    for row in list_issues(conn)? {
        if let Some(d) = row.data {
            map.entry(row.task_id).or_default().push(d);
        }
    }
    Ok(map)
}

/// Snapshots per task, for summaries.
pub fn pr_snapshots_by_task(conn: &Connection) -> DbResult<std::collections::HashMap<i64, Vec<PrSnapshot>>> {
    let mut map: std::collections::HashMap<i64, Vec<PrSnapshot>> = std::collections::HashMap::new();
    for row in list_prs(conn)? {
        if let Some(d) = row.data {
            map.entry(row.task_id).or_default().push(d);
        }
    }
    Ok(map)
}

// ---------------------------------------------------------------- summaries

pub fn get_summary(conn: &Connection, scope: &str, from_ts: i64) -> DbResult<Option<Summary>> {
    conn.query_row(
        "SELECT id, scope, from_ts, to_ts, content_md, created_at FROM summaries
         WHERE scope = ?1 AND from_ts = ?2 ORDER BY created_at DESC, id DESC LIMIT 1",
        params![scope, from_ts],
        summary_row,
    )
    .optional()
    .map_err(err)
}

pub fn save_summary(conn: &Connection, scope: &str, from_ts: i64, to_ts: i64, content: &str) -> DbResult<Summary> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO summaries (scope, from_ts, to_ts, content_md, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![scope, from_ts, to_ts, content, now],
    )
    .map_err(err)?;
    // Keep only the latest few generations per key.
    conn.execute(
        "DELETE FROM summaries WHERE scope = ?1 AND from_ts = ?2 AND id NOT IN
         (SELECT id FROM summaries WHERE scope = ?1 AND from_ts = ?2 ORDER BY created_at DESC, id DESC LIMIT 3)",
        params![scope, from_ts],
    )
    .map_err(err)?;
    Ok(Summary { id: conn.last_insert_rowid(), scope: scope.into(), from_ts, to_ts, content_md: content.into(), created_at: now })
}

// ---------------------------------------------------------------- settings

pub fn get_settings(conn: &Connection) -> DbResult<serde_json::Map<String, serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?;
    let mut map = serde_json::Map::new();
    for row in rows {
        let (k, v) = row.map_err(err)?;
        map.insert(k, serde_json::Value::String(v));
    }
    Ok(map)
}

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .filter(|v: &String| !v.trim().is_empty())
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> DbResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    fn kinds(c: &Connection, id: i64) -> Vec<String> {
        let mut k: Vec<String> = task_activity(c, id).unwrap().into_iter().map(|a| a.kind).collect();
        k.reverse();
        k
    }

    #[test]
    fn legacy_database_is_copied_once() {
        let dir = std::env::temp_dir().join(format!("worklogger-test-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("handoff.db");
        let target = dir.join("worklogger.db");
        assert!(!migrate_legacy(&legacy, &target).unwrap(), "nothing to migrate");

        {
            // Leave data in the WAL (connection kept open while migrating) to prove it is included.
            let old = open(&legacy).unwrap();
            create_task(&old, NewTask { title: "carried over".into(), ..Default::default() }).unwrap();
            assert!(migrate_legacy(&legacy, &target).unwrap());
        }
        let new = open(&target).unwrap();
        let titles: Vec<String> = list_tasks(&new, 0).unwrap().into_iter().map(|t| t.title).collect();
        assert_eq!(titles, vec!["carried over"]);
        assert!(!migrate_legacy(&legacy, &target).unwrap(), "never overwrites a database that has data");
        assert!(legacy.exists(), "old database is kept as a backup");
        drop(new);

        // A new database that was created but never used is replaced by the import.
        let fresh_target = dir.join("fresh.db");
        drop(open(&fresh_target).unwrap());
        assert!(migrate_legacy(&legacy, &fresh_target).unwrap());
        assert_eq!(list_tasks(&open(&fresh_target).unwrap(), 0).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Diagnose a migration against a real file: `WORKLOGGER_LEGACY_DB=path cargo test -- --ignored live_migrate --nocapture`
    #[test]
    #[ignore]
    fn live_migrate() {
        let Ok(legacy) = std::env::var("WORKLOGGER_LEGACY_DB") else { return };
        let target = std::env::temp_dir().join(format!("worklogger-live-{}.db", now_ms()));
        assert!(migrate_legacy(std::path::Path::new(&legacy), &target).unwrap());
        let n: i64 = Connection::open(&target).unwrap().query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        println!("copied tasks: {n}");
        let _ = std::fs::remove_file(&target);
    }

    #[test]
    fn migrations_are_idempotent() {
        let c = mem();
        init(&c).unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn create_logs_activity_and_resolves_project() {
        let c = mem();
        let t = create_task(
            &c,
            NewTask { title: " Fix login ".into(), project_name: Some("Web".into()), priority: Some(1), ..Default::default() },
        )
        .unwrap();
        assert_eq!(t.title, "Fix login");
        assert_eq!(t.priority, 1);
        let t2 = create_task(&c, NewTask { title: "Other".into(), project_name: Some("web".into()), ..Default::default() }).unwrap();
        assert_eq!(t.project_id, t2.project_id, "project lookup is case-insensitive");
        assert!(t2.sort_order < t.sort_order, "new tasks go on top");
        assert_eq!(kinds(&c, t.id), vec!["created"]);
    }

    #[test]
    fn status_changes_are_logged_and_set_completed_at() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), ..Default::default() }).unwrap();
        let t = update_task(&c, t.id, TaskPatch { status: Some("in_progress".into()), priority: Some(0), ..Default::default() }).unwrap();
        assert_eq!(t.completed_at, None);
        let t = update_task(&c, t.id, TaskPatch { status: Some("done".into()), ..Default::default() }).unwrap();
        assert!(t.completed_at.is_some());
        let t = update_task(&c, t.id, TaskPatch { status: Some("todo".into()), ..Default::default() }).unwrap();
        assert_eq!(t.completed_at, None);
        assert_eq!(kinds(&c, t.id), vec!["created", "priority", "status", "completed", "reopened"]);
        // No-op patch logs nothing.
        update_task(&c, t.id, TaskPatch { status: Some("todo".into()), title: Some("A".into()), ..Default::default() }).unwrap();
        assert_eq!(kinds(&c, t.id).len(), 5);
        assert!(update_task(&c, t.id, TaskPatch { status: Some("bogus".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn park_records_next_step_and_status() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), status: Some("in_progress".into()), ..Default::default() }).unwrap();
        let t = park_task(&c, t.id, "  check CI on branch x ", Some("waiting".into())).unwrap();
        assert_eq!(t.status, "waiting");
        assert_eq!(t.next_step, "check CI on branch x");
        let last = &task_activity(&c, t.id).unwrap()[0];
        assert_eq!(last.kind, "parked");
        assert_eq!(last.body, "check CI on branch x");
        assert_eq!(last.meta["from"], "in_progress");
    }

    #[test]
    fn list_tasks_hides_old_done_and_archived() {
        let c = mem();
        let a = create_task(&c, NewTask { title: "open".into(), ..Default::default() }).unwrap();
        let b = create_task(&c, NewTask { title: "done".into(), status: Some("done".into()), ..Default::default() }).unwrap();
        let x = create_task(&c, NewTask { title: "gone".into(), ..Default::default() }).unwrap();
        archive_task(&c, x.id).unwrap();
        let ids: Vec<i64> = list_tasks(&c, 0).unwrap().iter().map(|t| t.id).collect();
        assert!(ids.contains(&a.id) && ids.contains(&b.id) && !ids.contains(&x.id));
        let ids: Vec<i64> = list_tasks(&c, now_ms() + 1000).unwrap().iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![a.id]);
    }

    #[test]
    fn activity_range_is_half_open() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), ..Default::default() }).unwrap();
        log_activity(&c, t.id, "note", "before midnight", json!({}), 1_000).unwrap();
        log_activity(&c, t.id, "note", "at midnight", json!({}), 2_000).unwrap();
        let (acts, tasks) = activity_range(&c, 1_000, 2_000).unwrap();
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].body, "before midnight");
        assert_eq!(tasks.len(), 1);
    }

    fn snap(state: &str) -> PrSnapshot {
        PrSnapshot { repo: "o/r".into(), number: 1, state: state.into(), viewer: "me".into(), ..Default::default() }
    }

    fn issue(state: &str, reason: Option<&str>) -> IssueSnapshot {
        IssueSnapshot {
            repo: "o/r".into(),
            number: 5,
            state: state.into(),
            state_reason: reason.map(String::from),
            viewer: "me".into(),
            ..Default::default()
        }
    }

    #[test]
    fn issues_link_log_and_complete_tasks() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), status: Some("in_progress".into()), ..Default::default() }).unwrap();
        let r = crate::github::parse_issue("o/r#5").unwrap();
        let i = link_issue(&c, t.id, &r).unwrap();
        assert_eq!(link_issue(&c, t.id, &r).unwrap().id, i.id, "idempotent");
        assert_eq!(i.url, "https://github.com/o/r/issues/5");

        apply_issue_results(&c, vec![(i.id, Ok(issue("OPEN", None)))]).unwrap();
        assert_eq!(kinds(&c, t.id), vec!["created", "issue"], "baseline fetch logs nothing");
        assert_eq!(get_task(&c, t.id).unwrap().status, "in_progress", "issues don't move tasks to review");

        let mut assigned = issue("OPEN", None);
        assigned.assignees = vec!["me".into()];
        apply_issue_results(&c, vec![(i.id, Ok(assigned))]).unwrap();
        assert_eq!(task_activity(&c, t.id).unwrap()[0].body, "o/r#5: Assigned to you");

        assert_eq!(apply_issue_results(&c, vec![(i.id, Ok(issue("CLOSED", Some("COMPLETED"))))]).unwrap(), vec![t.id]);
        let last = &task_activity(&c, t.id).unwrap()[0];
        assert_eq!((last.kind.as_str(), last.body.as_str()), ("completed", "Issue closed"));
        assert!(issues_to_refresh(&c, None).unwrap().is_empty(), "closed issues are no longer polled");
        assert_eq!(issue_snapshots_by_task(&c).unwrap()[&t.id][0].state, "CLOSED");
        unlink_issue(&c, i.id).unwrap();
        assert!(list_issues(&c).unwrap().is_empty());
    }

    #[test]
    fn tasks_wait_for_every_linked_pr_and_issue() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), ..Default::default() }).unwrap();
        let p = link_pr(&c, t.id, &crate::github::parse_pr("o/r#1").unwrap()).unwrap();
        let i = link_issue(&c, t.id, &crate::github::parse_issue("o/r#5").unwrap()).unwrap();
        apply_pr_results(&c, vec![(p.id, Ok(snap("OPEN")))]).unwrap();
        apply_issue_results(&c, vec![(i.id, Ok(issue("OPEN", None)))]).unwrap();

        // PR merges but its issue is still open: not done yet.
        assert!(apply_pr_results(&c, vec![(p.id, Ok(snap("MERGED")))]).unwrap().is_empty());
        assert_ne!(get_task(&c, t.id).unwrap().status, "done");
        // The issue closes: now everything is finished.
        assert_eq!(apply_issue_results(&c, vec![(i.id, Ok(issue("CLOSED", Some("COMPLETED"))))]).unwrap(), vec![t.id]);
        assert_eq!(task_activity(&c, t.id).unwrap()[0].body, "All linked PRs and issues finished");
    }

    #[test]
    fn closing_issues_as_not_planned_does_not_complete() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), ..Default::default() }).unwrap();
        let i = link_issue(&c, t.id, &crate::github::parse_issue("o/r#5").unwrap()).unwrap();
        apply_issue_results(&c, vec![(i.id, Ok(issue("OPEN", None)))]).unwrap();
        assert!(apply_issue_results(&c, vec![(i.id, Ok(issue("CLOSED", Some("NOT_PLANNED"))))]).unwrap().is_empty());
        assert_eq!(get_task(&c, t.id).unwrap().status, "todo");
        assert_eq!(task_activity(&c, t.id).unwrap()[0].body, "o/r#5: Closed as not planned");
    }

    #[test]
    fn pr_link_is_idempotent_and_logged() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), ..Default::default() }).unwrap();
        let pr = crate::github::parse_pr("o/r#1").unwrap();
        let a = link_pr(&c, t.id, &pr).unwrap();
        let b = link_pr(&c, t.id, &pr).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.url, "https://github.com/o/r/pull/1");
        assert_eq!(kinds(&c, t.id), vec!["created", "pr"]);
        unlink_pr(&c, a.id).unwrap();
        assert!(list_prs(&c).unwrap().is_empty());
    }

    #[test]
    fn merge_auto_completes_once_all_prs_finish() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), status: Some("waiting".into()), ..Default::default() }).unwrap();
        let p1 = link_pr(&c, t.id, &crate::github::parse_pr("o/r#1").unwrap()).unwrap();
        let p2 = link_pr(&c, t.id, &crate::github::parse_pr("o/r#2").unwrap()).unwrap();
        // First fetch: baseline, no PR events; open PRs move the task to review once.
        apply_pr_results(&c, vec![(p1.id, Ok(snap("OPEN"))), (p2.id, Ok(snap("OPEN")))]).unwrap();
        assert_eq!(kinds(&c, t.id), vec!["created", "pr", "pr", "status"]);
        assert_eq!(get_task(&c, t.id).unwrap().status, "in_review");
        // One merges: logged, task stays open.
        assert!(apply_pr_results(&c, vec![(p1.id, Ok(snap("MERGED"))), (p2.id, Ok(snap("OPEN")))]).unwrap().is_empty());
        assert_eq!(get_task(&c, t.id).unwrap().status, "in_review");
        // Merged PRs are no longer polled.
        assert_eq!(prs_to_refresh(&c, None).unwrap().len(), 1);
        // The other merges: task completes automatically.
        assert_eq!(apply_pr_results(&c, vec![(p2.id, Ok(snap("MERGED")))]).unwrap(), vec![t.id]);
        let t2 = get_task(&c, t.id).unwrap();
        assert_eq!(t2.status, "done");
        assert!(t2.completed_at.is_some());
        let last = &task_activity(&c, t.id).unwrap()[0];
        assert_eq!((last.kind.as_str(), last.body.as_str()), ("completed", "All linked PRs merged"));
    }

    #[test]
    fn prs_ready_for_review_move_active_tasks_to_in_review() {
        let c = mem();
        let mk = |status: &str| {
            let t = create_task(&c, NewTask { title: status.into(), status: Some(status.into()), ..Default::default() }).unwrap();
            let p = link_pr(&c, t.id, &crate::github::parse_pr(&format!("o/r#{}", t.id)).unwrap()).unwrap();
            (t.id, p.id)
        };
        let draft = |s: &str| PrSnapshot { is_draft: true, ..snap(s) };

        // Linking an open, non-draft PR moves active work to review...
        let (working, p_working) = mk("in_progress");
        // ...but never out of blocked, backlog or done.
        let (blocked, p_blocked) = mk("blocked");
        let (finished, p_finished) = mk("done");
        // A draft PR leaves the task alone until it is marked ready.
        let (drafting, p_drafting) = mk("in_progress");
        apply_pr_results(
            &c,
            vec![
                (p_working, Ok(snap("OPEN"))),
                (p_blocked, Ok(snap("OPEN"))),
                (p_finished, Ok(snap("OPEN"))),
                (p_drafting, Ok(draft("OPEN"))),
            ],
        )
        .unwrap();
        let status = |id| get_task(&c, id).unwrap().status;
        assert_eq!(status(working), "in_review");
        let last = &task_activity(&c, working).unwrap()[0];
        assert_eq!((last.kind.as_str(), last.body.as_str()), ("status", "PR ready for review"));
        assert_eq!(last.meta["auto"], true);
        assert_eq!(status(blocked), "blocked");
        assert_eq!(status(finished), "done");
        assert_eq!(status(drafting), "in_progress");

        apply_pr_results(&c, vec![(p_drafting, Ok(snap("OPEN")))]).unwrap();
        assert_eq!(status(drafting), "in_review", "draft -> ready moves it");

        // Moving it back by hand sticks: the PR was already ready, so no new transition.
        update_task(&c, drafting, TaskPatch { status: Some("in_progress".into()), ..Default::default() }).unwrap();
        apply_pr_results(&c, vec![(p_drafting, Ok(snap("OPEN")))]).unwrap();
        assert_eq!(status(drafting), "in_progress");
    }

    #[test]
    fn reopened_task_is_not_recompleted() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), ..Default::default() }).unwrap();
        let p = link_pr(&c, t.id, &crate::github::parse_pr("o/r#1").unwrap()).unwrap();
        apply_pr_results(&c, vec![(p.id, Ok(snap("OPEN")))]).unwrap();
        apply_pr_results(&c, vec![(p.id, Ok(snap("MERGED")))]).unwrap();
        update_task(&c, t.id, TaskPatch { status: Some("in_progress".into()), ..Default::default() }).unwrap();
        // A later refresh sees the PR still merged: no transition, no auto-complete.
        assert!(apply_pr_results(&c, vec![(p.id, Ok(snap("MERGED")))]).unwrap().is_empty());
        assert_eq!(get_task(&c, t.id).unwrap().status, "in_progress");
    }

    #[test]
    fn fetch_errors_are_stored_and_automated_events_dont_count_as_activity() {
        let c = mem();
        let t = create_task(&c, NewTask { title: "A".into(), ..Default::default() }).unwrap();
        let p = link_pr(&c, t.id, &crate::github::parse_pr("o/r#1").unwrap()).unwrap();
        // Backdate the human activity, then let automation log later events.
        c.execute("UPDATE activity SET created_at = 1000", []).unwrap();
        apply_pr_results(&c, vec![(p.id, Ok(snap("OPEN")))]).unwrap();
        apply_pr_results(&c, vec![(p.id, Ok(snap("MERGED")))]).unwrap();
        assert_eq!(get_task(&c, t.id).unwrap().status, "done");
        assert_eq!(last_activity_at(&c).unwrap(), Some(1000));
        apply_pr_results(&c, vec![(p.id, Err("gone".into()))]).unwrap();
        assert_eq!(get_pr(&c, p.id).unwrap().fetch_error.as_deref(), Some("gone"));
    }

    #[test]
    fn summaries_cache_keeps_latest() {
        let c = mem();
        for i in 0..5 {
            save_summary(&c, "day", 100, 200, &format!("v{i}")).unwrap();
        }
        assert_eq!(get_summary(&c, "day", 100).unwrap().unwrap().content_md, "v4");
        let n: i64 = c.query_row("SELECT COUNT(*) FROM summaries", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
    }
}
