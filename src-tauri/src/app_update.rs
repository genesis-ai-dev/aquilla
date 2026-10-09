// Download and install are split so the install can wait for the offline queue to drain.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::shutdown_guard::{self, ShutdownGuardState};

/// Unbounded, a stalled fetch holds `downloading` and blocks every later check.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
/// Measured since the last chunk, so slow-but-moving downloads still finish.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(120);
const DOWNLOAD_STALL_POLL: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct AppUpdateState {
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    /// Overlapping calls (one per reconnect) wait and reuse the result instead of re-downloading.
    downloading: tokio::sync::Mutex<()>,
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

/// `None` when up to date; repeat calls return the already-downloaded update.
#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<DownloadedUpdate>, String> {
    let _downloading = state.downloading.lock().await;
    if let Some((update, _)) = state.ready.lock().map_err(|e| e.to_string())?.as_ref() {
        return Ok(Some(update.into()));
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| "update check timed out".to_string())?
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let bytes = download_unless_stalled(&update).await?;
    let info = DownloadedUpdate::from(&update);
    *state.ready.lock().map_err(|e| e.to_string())? = Some((update, bytes));
    Ok(Some(info))
}

/// Returning early drops `download`, which cancels the request.
async fn download_unless_stalled(update: &Update) -> Result<Vec<u8>, String> {
    let last_progress = Arc::new(Mutex::new(Instant::now()));
    let on_chunk = {
        let last_progress = Arc::clone(&last_progress);
        move |_: usize, _: Option<u64>| {
            if let Ok(mut at) = last_progress.lock() {
                *at = Instant::now();
            }
        }
    };
    let download = update.download(on_chunk, || {});
    tokio::pin!(download);
    loop {
        tokio::select! {
            result = &mut download => return result.map_err(|e| e.to_string()),
            _ = tokio::time::sleep(DOWNLOAD_STALL_POLL) => {
                let idle = last_progress.lock().map(|at| at.elapsed()).unwrap_or_default();
                if idle >= DOWNLOAD_STALL_TIMEOUT {
                    return Err(format!("update download stalled for {}s", idle.as_secs()));
                }
            }
        }
    }
}

/// Call only with an empty offline queue. Relaunches (on the old version) even if install fails.
#[tauri::command]
pub fn install_app_update(
    app: AppHandle,
    update_state: State<'_, AppUpdateState>,
    guard_state: State<'_, ShutdownGuardState>,
) -> Result<(), String> {
    if update_state.ready.lock().map_err(|e| e.to_string())?.is_none() {
        return Err("no downloaded update to install".into());
    }
    // Taken inside the closure so a refused shutdown leaves the update downloaded.
    let started = shutdown_guard::exit_after_handshake(&app, &guard_state, |app| {
        let ready = app
            .state::<AppUpdateState>()
            .ready
            .lock()
            .ok()
            .and_then(|mut ready| ready.take());
        match ready {
            Some((update, bytes)) => {
                if let Err(err) = update.install(&bytes) {
                    log::error!("[app_update] install of {} failed: {err}", update.version);
                }
            }
            None => log::error!("[app_update] downloaded update vanished before install"),
        }
        app.restart();
    });
    if !started {
        return Err("the app is already shutting down".into());
    }
    Ok(())
}
