// Coordinates a graceful shutdown handshake with the webview before the
// Tauri process actually exits.
//
// Why: LiveStore's offline SQLite store (OPFS-backed) treats `store.commit()`
// as fire-and-forget from the caller's perspective — the write reaches the
// leader worker (and therefore OPFS) asynchronously. A plain window
// close/app quit kills the webview before that async hop completes, silently
// losing whatever was committed just before close (confirmed empirically: a
// commit immediately followed by an unguarded reload vanishes with no
// error). The fix is to hold up the close until the webview confirms
// `store.syncStatus().isSynced` and `store.shutdownPromise()` have both
// completed (see `src/lib/offline/shutdown.ts` and
// `src/components/OfflineShutdownGuard.tsx`).
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Window, WindowEvent};
use tokio::sync::Notify;

const PREPARE_SHUTDOWN_EVENT: &str = "offline://prepare-shutdown";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(6);

pub struct ShutdownGuardState {
    notify: Arc<Notify>,
    /// Flips true the first time either hook below starts the handshake.
    /// Shared between `handle_window_event` and `handle_run_event` so
    /// whichever fires first runs the handshake exactly once; every
    /// subsequent close/exit event (including the one `app_handle.exit()`
    /// itself triggers) is let through immediately instead of being
    /// prevented again.
    exiting: Arc<AtomicBool>,
}

impl ShutdownGuardState {
    pub fn new() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            exiting: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Invoked by `OfflineShutdownGuard.tsx` once it has awaited
/// `shutdownOfflineStoreGracefully()` (or immediately, if no offline store
/// was ever booted this session).
#[tauri::command]
pub fn confirm_offline_shutdown(state: State<'_, ShutdownGuardState>) {
    state.notify.notify_one();
}

fn begin_graceful_exit(app: &AppHandle, notify: Arc<Notify>) {
    let app_handle = app.clone();
    if let Err(err) = app_handle.emit(PREPARE_SHUTDOWN_EVENT, ()) {
        log::warn!("[shutdown_guard] failed to emit {PREPARE_SHUTDOWN_EVENT}: {err}");
    }
    tauri::async_runtime::spawn(async move {
        if tokio::time::timeout(SHUTDOWN_TIMEOUT, notify.notified())
            .await
            .is_err()
        {
            log::warn!(
                "[shutdown_guard] webview did not confirm offline shutdown within {SHUTDOWN_TIMEOUT:?}; exiting anyway"
            );
        }
        app_handle.exit(0);
    });
}

/// Register via `Builder::on_window_event` (applies to all windows). Covers
/// the window's close button / Cmd+W.
pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let state = app.state::<ShutdownGuardState>();
        if state.exiting.swap(true, Ordering::SeqCst) {
            return;
        }
        api.prevent_close();
        begin_graceful_exit(app, state.notify.clone());
    }
}

/// Register as `App::run`'s callback. Covers Cmd+Q / app-level quit, which
/// doesn't always route through a window's `CloseRequested` first.
pub fn handle_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, .. } = event {
        let state = app.state::<ShutdownGuardState>();
        if state.exiting.swap(true, Ordering::SeqCst) {
            return;
        }
        api.prevent_exit();
        begin_graceful_exit(app, state.notify.clone());
    }
}
