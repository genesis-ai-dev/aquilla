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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::shutdown_guard::{self, ShutdownGuardState};

/// Bounds on a check and a download. Without them a connection that stalls
/// (sleep, a captive portal) never resolves, and since the call holds
/// `downloading`, every later check would queue behind it until a restart.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
/// A download is only abandoned when no bytes arrive for this long, so a slow
/// but moving connection still finishes.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(120);
const DOWNLOAD_STALL_POLL: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct AppUpdateState {
    /// A checked and fully downloaded update, waiting for `install_app_update`.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    /// Held for a whole check + download, so a call that overlaps one already
    /// running (the webview re-checks on every reconnect) waits for it and
    /// returns its result instead of fetching the installer a second time.
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

/// Checks for an update and downloads it without installing. `None` when the
/// app is up to date. Repeat calls after a successful download return the
/// same update without fetching it again, including calls that overlap an
/// in-flight download.
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

/// Downloads `update`, giving up once no bytes have arrived for
/// `DOWNLOAD_STALL_TIMEOUT`. Dropping the download future cancels the request.
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

/// Installs the downloaded update and relaunches into it, after the same save
/// handshake as a quit. The webview must only call this once its offline
/// queue is empty. If the install itself fails the app still relaunches (on
/// the old version) — the store has already been shut down by then.
///
/// Errs without starting anything when there's no downloaded update, or when
/// a quit/restart/install already claimed the shutdown — the update stays
/// downloaded, so it isn't lost to a shutdown that won't install it.
#[tauri::command]
pub fn install_app_update(
    app: AppHandle,
    update_state: State<'_, AppUpdateState>,
    guard_state: State<'_, ShutdownGuardState>,
) -> Result<(), String> {
    if update_state.ready.lock().map_err(|e| e.to_string())?.is_none() {
        return Err("no downloaded update to install".into());
    }
    // Only taken once the handshake has run, i.e. once this install owns the
    // shutdown.
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
