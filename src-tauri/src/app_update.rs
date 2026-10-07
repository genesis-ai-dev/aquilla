// Desktop auto-update, split into download and install so the webview can
// hold the install until the offline store's queue has drained to the server
// (src/components/DesktopUpdatePrompt.tsx).
//
// Why: a user who edited offline only gets an update once they're back
// online, and the update relaunches straight into the new build. Anything
// still queued then has to survive a newer offline schema reading it. Sending
// it first makes the upgrade lose nothing but re-downloadable cache.
//
// Tauri v2 has no built-in update dialog (`plugins.updater.dialog` is a v1
// key), so nothing checked for updates before this module.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::shutdown_guard::{self, ShutdownGuardState};

#[derive(Default)]
pub struct AppUpdateState {
    /// A checked and fully downloaded update, waiting for `install_app_update`.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    version: String,
    notes: Option<String>,
}

impl From<&Update> for DownloadedUpdate {
    fn from(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            notes: update.body.clone(),
        }
    }
}

/// Checks for an update and downloads it without installing. `None` when the
/// app is up to date. Repeat calls after a successful download return the
/// same update without fetching it again.
#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<DownloadedUpdate>, String> {
    if let Some((update, _)) = state.ready.lock().map_err(|e| e.to_string())?.as_ref() {
        return Ok(Some(update.into()));
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let info = DownloadedUpdate::from(&update);
    *state.ready.lock().map_err(|e| e.to_string())? = Some((update, bytes));
    Ok(Some(info))
}

/// Installs the downloaded update and relaunches into it, after the same save
/// handshake as a quit. The webview must only call this once its offline
/// queue is empty. If the install itself fails the app still relaunches (on
/// the old version) — the store has already been shut down by then.
#[tauri::command]
pub fn install_app_update(
    app: AppHandle,
    update_state: State<'_, AppUpdateState>,
    guard_state: State<'_, ShutdownGuardState>,
) -> Result<(), String> {
    let Some((update, bytes)) = update_state.ready.lock().map_err(|e| e.to_string())?.take() else {
        return Err("no downloaded update to install".into());
    };
    shutdown_guard::exit_after_handshake(&app, &guard_state, move |app| {
        if let Err(err) = update.install(&bytes) {
            log::error!("[app_update] install of {} failed: {err}", update.version);
        }
        app.restart();
    });
    Ok(())
}
