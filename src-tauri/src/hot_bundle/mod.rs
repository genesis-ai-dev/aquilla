//! Hot bundle channel: the web client updates hourly without a new shell build.
//!
//! See `docs/superpowers/specs/2026-11-05-desktop-hot-bundle.md`. Split into
//! `manifest` (signature + shell floor), `fetch` (network), `archive` (sha256 + tar),
//! `store` (on-disk state machine) and `serve` (the `app://localhost` origin); this file wires
//! them to Tauri: managed state, commands, events and the launch sequence.

mod archive;
mod fetch;
mod manifest;
mod serve;
mod store;

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl};

pub use serve::{serve_request, SCHEME};
use store::{BundleInfo, BundleStore, LaunchOutcome};

const DEFAULT_MANIFEST_URL: &str = "https://desktop-bundles.aquilla.app/production/latest.json";
/// Long enough for the window to paint first; the check is never on the startup path.
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(5);

const EVENT_STAGED: &str = "bundle://staged";
const EVENT_SHELL_OUTDATED: &str = "bundle://shell-outdated";
const EVENT_ROLLED_BACK: &str = "bundle://rolled-back";

pub struct HotBundleState {
    /// Directory the `app://` scheme serves from; `None` means the embedded assets.
    pub(crate) serve_root: RwLock<Option<PathBuf>>,
    /// Set in `prepare`, once `app_data_dir` is known. Commands before that fail loudly.
    store: OnceLock<BundleStore>,
    /// Overlapping checks (startup + reconnect) wait and reuse the result instead of racing
    /// two downloads of the same tarball into the same staging directory.
    checking: tokio::sync::Mutex<()>,
    /// Rollback detected in `prepare`, emitted once the window exists to listen.
    launch_outcome: Mutex<Option<LaunchOutcome>>,
}

impl Default for HotBundleState {
    fn default() -> Self {
        Self {
            serve_root: RwLock::new(None),
            store: OnceLock::new(),
            checking: tokio::sync::Mutex::new(()),
            launch_outcome: Mutex::new(None),
        }
    }
}

impl HotBundleState {
    fn store(&self) -> Result<&BundleStore, String> {
        self.store.get().ok_or_else(|| "hot bundle store is not initialised".to_string())
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StagedBundle {
    version: String,
    sha: String,
}

impl From<BundleInfo> for StagedBundle {
    fn from(info: BundleInfo) -> Self {
        Self { version: info.version, sha: info.sha }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleStatus {
    version: String,
    sha: String,
    /// `"embedded"` (assets compiled into the shell) or `"downloaded"` (a hot bundle).
    source: &'static str,
    staged: Option<StagedBundle>,
    last_rollback: Option<String>,
}

/// Runs before the window exists: applies a staged bundle or rolls back one that never booted,
/// and decides what the `app://` scheme serves.
pub fn prepare(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let root = app.path().app_data_dir()?.join("bundles");
    let state = app.state::<HotBundleState>();
    let store = BundleStore::new(root);
    let outcome = store.launch()?;
    if let Some(v) = &outcome.applied {
        log::info!("[hot_bundle] applied staged bundle {v}; pending until the SPA boots");
    }
    if let Some(v) = &outcome.rolled_back {
        log::warn!("[hot_bundle] bundle {v} never booted; rolled back and quarantined");
    }
    *state.serve_root.write().map_err(|e| e.to_string())? = store.current_dir();
    *state.launch_outcome.lock().map_err(|e| e.to_string())? = Some(outcome);
    let _ = state.store.set(store);
    Ok(())
}

/// In `tauri dev` with no downloaded bundle, keep Vite's HMR server; everywhere else the SPA
/// lives on `app://localhost` so storage stays on one origin across updates.
pub fn window_url(app: &tauri::App) -> Result<WebviewUrl, String> {
    #[cfg(dev)]
    {
        let has_bundle = app
            .state::<HotBundleState>()
            .serve_root
            .read()
            .map(|r| r.is_some())
            .unwrap_or(false);
        if let (false, Some(dev_url)) = (has_bundle, app.config().build.dev_url.clone()) {
            return Ok(WebviewUrl::External(dev_url));
        }
    }
    let _ = app;
    format!("{SCHEME}://localhost")
        .parse()
        .map(WebviewUrl::CustomProtocol)
        .map_err(|e: url::ParseError| e.to_string())
}

/// After the window exists: tell the SPA about a rollback and schedule the first check.
pub fn start(app: &AppHandle) {
    let state = app.state::<HotBundleState>();
    let rolled_back = state
        .launch_outcome
        .lock()
        .ok()
        .and_then(|mut o| o.take())
        .and_then(|o| o.rolled_back);
    if let Some(version) = rolled_back {
        let _ = app.emit(EVENT_ROLLED_BACK, serde_json::json!({ "version": version }));
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_CHECK_DELAY).await;
        run_check_logged(&app).await;
    });
}

/// Hooked from the connectivity loop on every offline→online transition.
pub fn on_online(app: AppHandle) {
    tauri::async_runtime::spawn(async move { run_check_logged(&app).await });
}

async fn run_check_logged(app: &AppHandle) {
    match run_check(app).await {
        Ok(Some(staged)) => log::info!("[hot_bundle] staged bundle {}", staged.version),
        Ok(None) => {}
        Err(err) => log::warn!("[hot_bundle] check failed: {err}"),
    }
}

/// `None` when nothing new is available (or this shell must not apply it); otherwise the bundle
/// now staged for the next launch. Repeat calls return the already-staged bundle.
#[tauri::command]
pub async fn check_bundle_update(app: AppHandle) -> Result<Option<StagedBundle>, String> {
    run_check(&app).await
}

/// The SPA mounted inside the current bundle, so a relaunch must not roll it back.
#[tauri::command]
pub fn bundle_booted(state: State<'_, HotBundleState>) -> Result<(), String> {
    state.store()?.booted()
}

/// The web bundle currently being served (downloaded hot bundle, else the embedded one).
/// Read by the About window; never fails, falling back to the shell version.
pub fn current_bundle_version(app: &AppHandle) -> String {
    let downloaded = app.try_state::<HotBundleState>().and_then(|state| {
        let store = state.store().ok()?;
        store.current_version().and_then(|v| store.info(&v)).map(|i| i.version)
    });
    downloaded.unwrap_or_else(|| embedded_version(app))
}

#[tauri::command]
pub fn get_bundle_status(app: AppHandle, state: State<'_, HotBundleState>) -> Result<BundleStatus, String> {
    let store = state.store()?;
    let current = store.current_version().and_then(|v| store.info(&v));
    let (version, sha, source) = match current {
        Some(info) => (info.version, info.sha, "downloaded"),
        None => (embedded_version(&app), embedded_sha().to_string(), "embedded"),
    };
    Ok(BundleStatus {
        version,
        sha,
        source,
        staged: store.staged_version().and_then(|v| store.info(&v)).map(Into::into),
        last_rollback: store.last_rollback(),
    })
}

async fn run_check(app: &AppHandle) -> Result<Option<StagedBundle>, String> {
    let state = app.state::<HotBundleState>();
    let _checking = state.checking.lock().await;
    let store = state.store()?;
    if let Some(info) = store.staged_version().and_then(|v| store.info(&v)) {
        return Ok(Some(info.into()));
    }
    let Some(public_key) = public_key() else {
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| {
            log::warn!("[hot_bundle] no AQUILLA_BUNDLE_PUBKEY compiled in; remote bundles are never applied")
        });
        return Ok(None);
    };

    let manifest = fetch::fetch_manifest(&manifest_url()).await?;
    manifest.verify_signature(&public_key)?;
    if manifest.schema != 1 {
        return Err(format!("unsupported manifest schema {}", manifest.schema));
    }
    let shell_version = app.package_info().version.to_string();
    if let Err(required) = manifest::shell_meets_floor(&shell_version, &manifest.min_shell_version) {
        log::info!("[hot_bundle] bundle {} needs shell {required}; have {shell_version}", manifest.version);
        let _ = app.emit(EVENT_SHELL_OUTDATED, serde_json::json!({ "minShellVersion": required }));
        return Ok(None);
    }
    if store.knows(&manifest.version) {
        return Ok(None);
    }
    if store.is_quarantined(&manifest.version) {
        log::info!("[hot_bundle] bundle {} is quarantined; skipping", manifest.version);
        return Ok(None);
    }
    if store.current_version().is_none() && embedded_version(app) == manifest.version {
        return Ok(None);
    }

    let info = download_and_stage(store, &manifest).await?;
    let _ = app.emit(EVENT_STAGED, StagedBundle::from(info.clone()));
    Ok(Some(info.into()))
}

async fn download_and_stage(store: &BundleStore, manifest: &manifest::Manifest) -> Result<BundleInfo, String> {
    let staging = store.staging_dir().join(&manifest.version);
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = async {
        let tarball = staging.join("bundle.tar.gz");
        fetch::download_to_file(&manifest.url, &tarball, manifest.size).await?;
        let actual = archive::sha256_hex_of_file(&tarball)?;
        if !actual.eq_ignore_ascii_case(manifest.sha256.trim()) {
            return Err(format!("bundle sha256 mismatch: manifest {}, got {actual}", manifest.sha256));
        }
        let extracted = staging.join("root");
        archive::extract_tar_gz(&tarball, &extracted)?;
        let root = archive::locate_bundle_root(&extracted)?;
        let info = BundleInfo { version: manifest.version.clone(), sha: manifest.sha.clone() };
        store.stage(&info, &root)?;
        Ok(info)
    }
    .await;
    // Success or failure, nothing in staging is needed any more.
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Compiled in by the release workflow. Debug builds may also take it from the environment so
/// the channel can be exercised against a local manifest signed with a throwaway key.
fn public_key() -> Option<String> {
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("AQUILLA_BUNDLE_PUBKEY") {
        if !key.trim().is_empty() {
            return Some(key);
        }
    }
    option_env!("AQUILLA_BUNDLE_PUBKEY")
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

fn manifest_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("AQUILLA_BUNDLE_MANIFEST_URL") {
        if !url.trim().is_empty() {
            return url;
        }
    }
    option_env!("AQUILLA_BUNDLE_MANIFEST_URL")
        .unwrap_or(DEFAULT_MANIFEST_URL)
        .to_string()
}

/// The version of the assets compiled into this shell. The release workflow sets it to the
/// calver it publishes; without it we fall back to the shell version, which never matches a
/// manifest, so a fresh install downloads the latest bundle once.
fn embedded_version(app: &AppHandle) -> String {
    option_env!("AQUILLA_BUNDLE_VERSION")
        .map(str::to_string)
        .unwrap_or_else(|| app.package_info().version.to_string())
}

fn embedded_sha() -> &'static str {
    option_env!("AQUILLA_BUNDLE_SHA").unwrap_or("unknown")
}
