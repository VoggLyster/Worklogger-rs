mod cli;
mod commands;
mod db;
mod github;
mod summary;

use commands::{register_hotkey, AppState};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

#[cfg(target_os = "macos")]
pub const DEFAULT_HOTKEY: &str = "cmd+alt+n";
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_HOTKEY: &str = "ctrl+alt+n";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch just focuses the running window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_main(app);
                        let _ = app.emit("quick-capture", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("worklogger.db");
            // The app used to be called Handoff (identifier com.soeren.handoff): bring that data along once.
            if let Ok(roaming) = app.path().data_dir() {
                let legacy = roaming.join("com.soeren.handoff").join("handoff.db");
                if let Err(e) = db::migrate_legacy(&legacy, &db_path) {
                    eprintln!("could not migrate data from {}: {e}", legacy.display());
                }
            }
            let conn = db::open(&db_path)?;
            let hotkey = db::get_setting(&conn, "hotkey").unwrap_or_else(|| DEFAULT_HOTKEY.into());
            let status = register_hotkey(app.handle(), &hotkey);
            if let Some(e) = &status.error {
                eprintln!("could not register global hotkey '{hotkey}': {e}");
            }
            app.manage(AppState {
                db: Mutex::new(conn),
                data_dir,
                hotkey: Mutex::new(status),
                refreshing: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::get_task,
            commands::create_task,
            commands::update_task,
            commands::park_task,
            commands::reorder_tasks,
            commands::archive_task,
            commands::add_note,
            commands::delete_note,
            commands::task_activity,
            commands::activity_range,
            commands::last_activity_at,
            commands::list_projects,
            commands::ensure_project,
            commands::update_project,
            commands::archive_project,
            commands::get_settings,
            commands::set_setting,
            commands::hotkey_status,
            commands::set_hotkey,
            commands::get_summary,
            commands::summarize,
            commands::test_claude,
            commands::list_prs,
            commands::list_issues,
            commands::link_github,
            commands::unlink_pr,
            commands::unlink_issue,
            commands::refresh_github,
            commands::untracked_prs,
            commands::search_issues,
            commands::test_gh,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
