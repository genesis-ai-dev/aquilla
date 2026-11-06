// Aquilla <-> Paratext bridge: the thin, safe filesystem layer under
// src/lib/paratext-bridge/ (which does all parsing and splicing in TS).
//
// Discovers Paratext project folders on this machine (Windows registry, Wine
// prefixes, platform defaults, user-added roots), reads/hashes/writes book
// files inside a discovered project only, and watches a project folder for
// external changes. Backups live under the app data dir, never inside the
// project folder (Paratext Send/Receive would commit stray files).

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const ROOTS_FILE: &str = "paratext-roots.json";
const BACKUPS_DIR: &str = "paratext-backups";
const CHANGE_EVENT: &str = "paratext:file-changed";
const DEBOUNCE: Duration = Duration::from_millis(300);
const SETTLE_GAP: Duration = Duration::from_millis(150);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub path: String,
    /// "registry" | "wine" | "default" | "user"
    pub source: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub folder_name: String,
    pub settings_xml: String,
    pub user_access_xml: Option<String>,
    /// Basenames of *.SFM / *.sfm / *.usfm files, sorted.
    pub book_files: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredUser {
    pub name: String,
    pub email: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub roots: Vec<Root>,
    pub projects: Vec<Project>,
    pub registered_user: Option<RegisteredUser>,
    pub paratext_running: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub backup_path: String,
    pub new_blob_hash: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct FileChanged {
    project_path: String,
    file_name: String,
    blob_hash: String,
}

#[derive(Default)]
pub struct ParatextWatchers(Mutex<HashMap<PathBuf, RecommendedWatcher>>);

// ---------------------------------------------------------------------------
// Pure helpers (testable without an AppHandle)
// ---------------------------------------------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

// A book/settings file name must be a plain basename: no separators, no
// traversal, no NUL, no drive/ADS colon.
fn validate_file_name(file_name: &str) -> Result<(), String> {
    if file_name.is_empty()
        || file_name == "."
        || file_name.contains("..")
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains('\0')
        || file_name.contains(':')
    {
        return Err(format!("EINVAL: illegal file name: {file_name:?}"));
    }
    Ok(())
}

fn is_book_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".sfm") || lower.ends_with(".usfm")
}

fn is_notes_file(name: &str) -> bool {
    name.starts_with("Notes_") && name.to_ascii_lowercase().ends_with(".xml")
}

fn is_watched_file(name: &str) -> bool {
    is_book_file(name) || is_notes_file(name) || name == "Settings.xml" || name == "ProjectUserAccess.xml"
}

// Parses `Settings_Directory` out of a Wine `system.reg`. The value sits in a
// `[Software\\Wow6432Node\\Paratext\\8] <ts>` section as
// `"Settings_Directory"="C:\\My Paratext 9 Projects"` with backslashes doubled.
fn parse_system_reg_settings_dir(reg: &str) -> Option<String> {
    let mut in_section = false;
    for line in reg.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with('[') {
            let key = line[1..].split(']').next().unwrap_or("").to_ascii_lowercase();
            in_section = key == "software\\\\wow6432node\\\\paratext\\\\8";
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(rest) = line.strip_prefix("\"Settings_Directory\"=") {
            let raw = rest.trim().trim_start_matches('"').trim_end_matches('"');
            return Some(raw.replace("\\\\", "\\"));
        }
    }
    None
}

// Maps a Windows path from inside a Wine prefix (`C:\Foo\Bar`) to the host
// path (`<prefix>/drive_c/Foo/Bar`). Non-C drives go through `dosdevices/`.
fn wine_path_to_host(prefix: &Path, win_path: &str) -> Option<PathBuf> {
    let mut chars = win_path.chars();
    let drive = chars.next()?.to_ascii_lowercase();
    if chars.next()? != ':' || !drive.is_ascii_alphabetic() {
        return None;
    }
    let rest: String = chars.collect();
    let base = if drive == 'c' {
        prefix.join("drive_c")
    } else {
        prefix.join("dosdevices").join(format!("{drive}:"))
    };
    let mut out = base;
    for seg in rest.split(['\\', '/']) {
        if !seg.is_empty() {
            out.push(seg);
        }
    }
    Some(out)
}

fn xml_tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim().to_string())
}

// `<RegistrationData><Name>…</Name><Email>…</Email>…` — no XML crate needed.
fn parse_registration_info(xml: &str) -> Option<RegisteredUser> {
    let name = xml_tag_text(xml, "Name")?;
    let email = xml_tag_text(xml, "Email").unwrap_or_default();
    if name.is_empty() {
        return None;
    }
    Some(RegisteredUser { name, email })
}

// A Paratext project is a folder whose Settings.xml carries a `<Guid>`.
fn detect_project(dir: &Path) -> Option<Project> {
    let settings_path = dir.join("Settings.xml");
    let settings_xml = std::fs::read_to_string(&settings_path).ok()?;
    if !settings_xml.contains("<Guid>") {
        return None;
    }
    let user_access_xml = std::fs::read_to_string(dir.join("ProjectUserAccess.xml")).ok();
    let mut book_files: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| is_book_file(n))
        .collect();
    book_files.sort();
    let folder_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    Some(Project {
        path: dir.to_string_lossy().into_owned(),
        folder_name,
        settings_xml,
        user_access_xml,
        book_files,
    })
}

// Projects under a root: the root itself if it is a project (someone picked
// the project folder), otherwise its immediate child dirs that are projects.
fn projects_in_root(root: &Path) -> Vec<Project> {
    if let Some(p) = detect_project(root) {
        return vec![p];
    }
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<Project> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| detect_project(&e.path()))
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

// Runs discovery over an explicit root list. Never fails because one root is
// unreadable; roots that do not exist are dropped.
fn discover_in_roots(candidates: Vec<Root>) -> (Vec<Root>, Vec<Project>) {
    let mut seen_roots: Vec<PathBuf> = Vec::new();
    let mut roots = Vec::new();
    let mut seen_projects: Vec<PathBuf> = Vec::new();
    let mut projects = Vec::new();
    for root in candidates {
        let path = PathBuf::from(&root.path);
        if !path.is_dir() {
            continue;
        }
        let c = canon(&path);
        if seen_roots.contains(&c) {
            continue;
        }
        seen_roots.push(c);
        for p in projects_in_root(&path) {
            let pc = canon(Path::new(&p.path));
            if seen_projects.contains(&pc) {
                continue;
            }
            seen_projects.push(pc);
            projects.push(p);
        }
        roots.push(root);
    }
    (roots, projects)
}

// Core of paratext_write_book / paratext_write_notes, parameterised on the
// backup dir so it is testable. Hash mismatch writes nothing; otherwise the
// original bytes are copied to the backup dir first and the new bytes are
// written in place. `expected_blob_hash == None` means "the file must not
// exist yet" (a user's first note creates their Notes_<User>.xml).
fn write_book_core(
    project_path: &Path,
    file_name: &str,
    bytes: &[u8],
    expected_blob_hash: Option<&str>,
    backups_root: &Path,
) -> Result<WriteResult, String> {
    validate_file_name(file_name)?;
    let target = project_path.join(file_name);
    let Some(expected_blob_hash) = expected_blob_hash else {
        if target.exists() {
            return Err(format!("EEXIST: {file_name} already exists in the project"));
        }
        std::fs::write(&target, bytes).map_err(|e| format!("EIO: write {file_name}: {e}"))?;
        return Ok(WriteResult { backup_path: String::new(), new_blob_hash: sha256_hex(bytes) });
    };
    if !target.is_file() {
        return Err(format!("ENOENT: {file_name} does not exist in the project"));
    }
    let current = std::fs::read(&target).map_err(|e| format!("EIO: read {file_name}: {e}"))?;
    if sha256_hex(&current) != expected_blob_hash.to_ascii_lowercase() {
        return Err("EHASH: file changed since it was read".to_string());
    }
    let folder_name = project_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let backup_dir = backups_root.join(folder_name);
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("EIO: mkdir {backup_dir:?}: {e}"))?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup_path = backup_dir.join(format!("{file_name}.{millis}.bak"));
    std::fs::write(&backup_path, &current).map_err(|e| format!("EIO: backup: {e}"))?;
    // In place on purpose: Paratext watches this path, and a temp+rename
    // would change the inode under it.
    std::fs::write(&target, bytes).map_err(|e| format!("EIO: write {file_name}: {e}"))?;
    Ok(WriteResult {
        backup_path: backup_path.to_string_lossy().into_owned(),
        new_blob_hash: sha256_hex(bytes),
    })
}

// ---------------------------------------------------------------------------
// Platform discovery
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn registry_roots() -> Vec<Root> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let mut out = Vec::new();
    if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\Wow6432Node\\Paratext\\8") {
        if let Ok(dir) = key.get_value::<String, _>("Settings_Directory") {
            out.push(Root { path: dir, source: "registry" });
        }
    }
    out.push(Root { path: "C:\\My Paratext 9 Projects".to_string(), source: "default" });
    out.push(Root { path: "C:\\My Paratext 8 Projects".to_string(), source: "default" });
    out
}

#[cfg(not(windows))]
fn registry_roots() -> Vec<Root> {
    Vec::new()
}

fn wine_prefixes() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(&home) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(".wine"))
        .map(|e| e.path())
        .filter(|p| p.join("system.reg").is_file())
        .collect();
    out.sort();
    out
}

fn wine_roots() -> Vec<Root> {
    let mut out = Vec::new();
    for prefix in wine_prefixes() {
        let Ok(reg) = std::fs::read_to_string(prefix.join("system.reg")) else {
            continue;
        };
        if let Some(win) = parse_system_reg_settings_dir(&reg) {
            if let Some(host) = wine_path_to_host(&prefix, &win) {
                out.push(Root { path: host.to_string_lossy().into_owned(), source: "wine" });
            }
        }
        for name in ["My Paratext 9 Projects", "My Paratext 8 Projects"] {
            out.push(Root {
                path: prefix.join("drive_c").join(name).to_string_lossy().into_owned(),
                source: "default",
            });
        }
    }
    out
}

fn registration_candidates() -> Vec<PathBuf> {
    let mut dirs_to_scan: Vec<PathBuf> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs_to_scan.push(PathBuf::from(local));
    }
    for prefix in wine_prefixes() {
        if let Ok(users) = std::fs::read_dir(prefix.join("drive_c").join("users")) {
            for u in users.filter_map(|e| e.ok()) {
                dirs_to_scan.push(u.path().join("AppData").join("Local"));
            }
        }
    }
    let mut out = Vec::new();
    for dir in dirs_to_scan {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.filter_map(|e| e.ok()) {
            if e.file_name().to_string_lossy().starts_with("Paratext9") {
                let f = e.path().join("RegistrationInfo.xml");
                if f.is_file() {
                    out.push(f);
                }
            }
        }
    }
    out.sort();
    out
}

fn registered_user() -> Option<RegisteredUser> {
    registration_candidates()
        .into_iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .find_map(|xml| parse_registration_info(&xml))
}

fn paratext_running_now() -> bool {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let via_sysinfo = sys.processes().values().any(|p| {
        let name = p.name().to_string_lossy().to_ascii_lowercase();
        name.contains("paratext.exe")
            || p
                .cmd()
                .iter()
                .any(|a| a.to_string_lossy().to_ascii_lowercase().contains("paratext.exe"))
    });
    if via_sysinfo {
        return true;
    }
    // Under Wine on macOS the process's 16-char `comm` is "C:\Program Files" and
    // sysinfo may not expose its argv, so fall back to `ps`, which does.
    #[cfg(unix)]
    {
        if let Ok(out) = std::process::Command::new("ps").args(["-axo", "args="]).output() {
            return String::from_utf8_lossy(&out.stdout)
                .to_ascii_lowercase()
                .contains("paratext.exe");
        }
    }
    false
}

// ---------------------------------------------------------------------------
// App-data persistence
// ---------------------------------------------------------------------------

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("EIO: app_data_dir: {e}"))
}

fn load_user_roots(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = app_data_dir(app) else {
        return Vec::new();
    };
    std::fs::read_to_string(dir.join(ROOTS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn save_user_roots(app: &AppHandle, roots: &[String]) -> Result<(), String> {
    let dir = app_data_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("EIO: mkdir {dir:?}: {e}"))?;
    let json = serde_json::to_string_pretty(roots).map_err(|e| format!("EIO: {e}"))?;
    std::fs::write(dir.join(ROOTS_FILE), json).map_err(|e| format!("EIO: write roots: {e}"))
}

fn run_discovery(app: &AppHandle) -> Discovery {
    let mut candidates = registry_roots();
    candidates.extend(wine_roots());
    candidates.extend(load_user_roots(app).into_iter().map(|p| Root { path: p, source: "user" }));
    let (roots, projects) = discover_in_roots(candidates);
    Discovery {
        roots,
        projects,
        registered_user: registered_user(),
        paratext_running: paratext_running_now(),
    }
}

// Resolves `project_path` against the current discovery; anything else is
// not a Paratext project folder we may touch.
fn resolve_project(app: &AppHandle, project_path: &str) -> Result<PathBuf, String> {
    let wanted = canon(Path::new(project_path));
    let discovery = run_discovery(app);
    discovery
        .projects
        .iter()
        .map(|p| PathBuf::from(&p.path))
        .find(|p| canon(p) == wanted)
        .ok_or_else(|| "EACCES: not a Paratext project folder".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("EIO: task join: {e}"))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn paratext_discover(app: AppHandle) -> Result<Discovery, String> {
    blocking(move || run_discovery(&app)).await
}

#[tauri::command]
pub async fn paratext_add_root(app: AppHandle, path: String) -> Result<Discovery, String> {
    blocking(move || {
        if !Path::new(&path).is_dir() {
            return Err(format!("ENOENT: not a directory: {path}"));
        }
        let mut roots = load_user_roots(&app);
        if !roots.contains(&path) {
            roots.push(path);
            save_user_roots(&app, &roots)?;
        }
        Ok(run_discovery(&app))
    })
    .await?
}

#[tauri::command]
pub async fn paratext_remove_root(app: AppHandle, path: String) -> Result<Discovery, String> {
    blocking(move || {
        let wanted = canon(Path::new(&path));
        let roots: Vec<String> = load_user_roots(&app)
            .into_iter()
            .filter(|r| r != &path && canon(Path::new(r)) != wanted)
            .collect();
        save_user_roots(&app, &roots)?;
        Ok(run_discovery(&app))
    })
    .await?
}

#[tauri::command]
pub async fn paratext_read_file(
    app: AppHandle,
    project_path: String,
    file_name: String,
) -> Result<Vec<u8>, String> {
    validate_file_name(&file_name)?;
    let dir = blocking(move || resolve_project(&app, &project_path)).await??;
    tokio::fs::read(dir.join(&file_name))
        .await
        .map_err(|e| format!("EIO: read {file_name}: {e}"))
}

#[tauri::command]
pub async fn paratext_hash_file(
    app: AppHandle,
    project_path: String,
    file_name: String,
) -> Result<String, String> {
    let bytes = paratext_read_file(app, project_path, file_name).await?;
    Ok(sha256_hex(&bytes))
}

#[tauri::command]
pub async fn paratext_write_book(
    app: AppHandle,
    project_path: String,
    file_name: String,
    bytes: Vec<u8>,
    expected_blob_hash: String,
) -> Result<WriteResult, String> {
    validate_file_name(&file_name)?;
    blocking(move || {
        let dir = resolve_project(&app, &project_path)?;
        let backups_root = app_data_dir(&app)?.join(BACKUPS_DIR);
        write_book_core(&dir, &file_name, &bytes, Some(&expected_blob_hash), &backups_root)
    })
    .await?
}

/// Write the registered user's `Notes_<User>.xml`. Same read-hash-backup-write
/// as books; `expected_blob_hash: None` creates the file for a first note.
#[tauri::command]
pub async fn paratext_write_notes(
    app: AppHandle,
    project_path: String,
    file_name: String,
    bytes: Vec<u8>,
    expected_blob_hash: Option<String>,
) -> Result<WriteResult, String> {
    validate_file_name(&file_name)?;
    if !is_notes_file(&file_name) {
        return Err(format!("EINVAL: not a Paratext notes file: {file_name:?}"));
    }
    blocking(move || {
        let dir = resolve_project(&app, &project_path)?;
        let backups_root = app_data_dir(&app)?.join(BACKUPS_DIR);
        write_book_core(&dir, &file_name, &bytes, expected_blob_hash.as_deref(), &backups_root)
    })
    .await?
}

#[tauri::command]
pub async fn paratext_is_running() -> bool {
    blocking(paratext_running_now).await.unwrap_or(false)
}

// Reads + hashes a file twice SETTLE_GAP apart; Some(hash) only once stable.
fn settled_hash(path: &Path) -> Option<String> {
    let a = sha256_hex(&std::fs::read(path).ok()?);
    std::thread::sleep(SETTLE_GAP);
    let b = sha256_hex(&std::fs::read(path).ok()?);
    (a == b).then_some(a)
}

// Debounce loop for one watched project dir. Exits when the watcher (and so
// the channel sender) is dropped by paratext_unwatch.
fn run_debounce_loop(app: AppHandle, project_path: PathBuf, rx: mpsc::Receiver<PathBuf>) {
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(path) => {
                pending.insert(path, Instant::now());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        let due: Vec<PathBuf> = pending
            .iter()
            .filter(|(_, t)| now.duration_since(**t) >= DEBOUNCE)
            .map(|(p, _)| p.clone())
            .collect();
        for path in due {
            pending.remove(&path);
            let Some(file_name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
                continue;
            };
            let app = app.clone();
            let project_path = project_path.to_string_lossy().into_owned();
            std::thread::spawn(move || {
                if let Some(blob_hash) = settled_hash(&path) {
                    let _ = app.emit(CHANGE_EVENT, FileChanged { project_path, file_name, blob_hash });
                }
            });
        }
    }
}

#[tauri::command]
pub async fn paratext_watch(
    app: AppHandle,
    watchers: State<'_, ParatextWatchers>,
    project_path: String,
) -> Result<(), String> {
    let app_for_resolve = app.clone();
    let dir = blocking(move || resolve_project(&app_for_resolve, &project_path)).await??;
    let key = canon(&dir);
    let mut map = watchers.0.lock().map_err(|_| "EIO: watcher lock poisoned".to_string())?;
    if map.contains_key(&key) {
        return Ok(());
    }
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let watched = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(is_watched_file)
                    .unwrap_or(false);
                if watched {
                    let _ = tx.send(p);
                }
            }
        }
    })
    .map_err(|e| format!("EIO: watcher: {e}"))?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("EIO: watch {dir:?}: {e}"))?;
    let loop_dir = dir.clone();
    std::thread::spawn(move || run_debounce_loop(app, loop_dir, rx));
    map.insert(key, watcher);
    Ok(())
}

#[tauri::command]
pub async fn paratext_unwatch(
    watchers: State<'_, ParatextWatchers>,
    project_path: String,
) -> Result<(), String> {
    let key = canon(Path::new(&project_path));
    let mut map = watchers.0.lock().map_err(|_| "EIO: watcher lock poisoned".to_string())?;
    // Dropping the watcher drops the callback's sender; the debounce thread exits.
    map.remove(&key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REG: &str = r#"WINE REGISTRY Version 2
;; All keys relative to \\Machine

[Software\\Wow6432Node\\Microsoft\\Windows]
"Foo"="bar"

[Software\\Wow6432Node\\Paratext\\8] 1760000000
#time=1dc0a0b0c0d0e0f
"Settings_Directory"="C:\\"
"Other"="C:\\Program Files\\Paratext 9"

[Software\\Zed]
"Settings_Directory"="D:\\nope"
"#;

    // Wine prefixes only exist on macOS/Linux; on Windows `Path::join("d:")`
    // is drive-relative and replaces the prefix, so the host paths differ.
    #[cfg(not(windows))]
    #[test]
    fn parses_settings_dir_from_system_reg_and_maps_to_drive_c() {
        assert_eq!(parse_system_reg_settings_dir(REG).as_deref(), Some("C:\\"));
        let prefix = Path::new("/home/u/.wine-paratext");
        assert_eq!(
            wine_path_to_host(prefix, "C:\\").unwrap(),
            PathBuf::from("/home/u/.wine-paratext/drive_c")
        );
        assert_eq!(
            wine_path_to_host(prefix, "C:\\My Paratext 9 Projects").unwrap(),
            PathBuf::from("/home/u/.wine-paratext/drive_c/My Paratext 9 Projects")
        );
        assert_eq!(
            wine_path_to_host(prefix, "D:\\Data").unwrap(),
            PathBuf::from("/home/u/.wine-paratext/dosdevices/d:/Data")
        );
        assert!(parse_system_reg_settings_dir("[Software\\\\Other]\n\"Settings_Directory\"=\"C:\\\\\"\n").is_none());
    }

    #[test]
    fn file_name_validation_rejects_paths_and_accepts_basenames() {
        assert!(validate_file_name("41MATTPP1.SFM").is_ok());
        assert!(validate_file_name("Settings.xml").is_ok());
        for bad in ["../x", "a/b", "a\\b", "C:x", "", "a\0b", ".."] {
            let err = validate_file_name(bad).unwrap_err();
            assert!(err.starts_with("EINVAL: "), "{bad:?} -> {err}");
        }
    }

    #[test]
    fn parses_registration_info_xml() {
        let xml = r#"<?xml version="1.0"?>
<RegistrationData>
  <Name>Ryder Wishart</Name>
  <Email>ryder@example.com</Email>
  <Code>abc</Code>
</RegistrationData>"#;
        assert_eq!(
            parse_registration_info(xml),
            Some(RegisteredUser { name: "Ryder Wishart".into(), email: "ryder@example.com".into() })
        );
        assert!(parse_registration_info("<RegistrationData></RegistrationData>").is_none());
    }

    fn make_project(root: &Path, name: &str, with_guid: bool) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let guid = if with_guid { "<Guid>0123456789abcdef0123456789abcdef01234567</Guid>" } else { "" };
        std::fs::write(dir.join("Settings.xml"), format!("<ScriptureText>{guid}<Name>{name}</Name></ScriptureText>")).unwrap();
        dir
    }

    #[test]
    fn detects_projects_with_guid_and_lists_books_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        let good = make_project(tmp.path(), "TPP1", true);
        make_project(tmp.path(), "NOTAPROJECT", false);
        std::fs::create_dir_all(tmp.path().join("empty")).unwrap();
        for f in ["42MRKTPP1.SFM", "41MATTPP1.SFM", "43LUKTPP1.usfm", "notes.txt", "unique.id"] {
            std::fs::write(good.join(f), b"\\id X").unwrap();
        }
        std::fs::write(good.join("ProjectUserAccess.xml"), "<ProjectUserAccess/>").unwrap();
        std::fs::create_dir_all(good.join(".hg")).unwrap();

        let (roots, projects) = discover_in_roots(vec![
            Root { path: tmp.path().to_string_lossy().into_owned(), source: "user" },
            Root { path: tmp.path().to_string_lossy().into_owned(), source: "default" }, // dup
            Root { path: "/definitely/not/here".into(), source: "default" },
            Root { path: good.to_string_lossy().into_owned(), source: "user" }, // root IS a project
        ]);
        assert_eq!(roots.len(), 2, "dup and missing roots dropped: {roots:?}");
        assert_eq!(projects.len(), 1, "same project via two roots is deduped: {projects:?}");
        let p = &projects[0];
        assert_eq!(p.folder_name, "TPP1");
        assert_eq!(p.book_files, vec!["41MATTPP1.SFM", "42MRKTPP1.SFM", "43LUKTPP1.usfm"]);
        assert!(p.settings_xml.contains("<Guid>"));
        assert_eq!(p.user_access_xml.as_deref(), Some("<ProjectUserAccess/>"));
    }

    #[test]
    fn write_book_refuses_on_hash_mismatch_and_backs_up_on_match() {
        let tmp = tempfile::tempdir().unwrap();
        let project = make_project(tmp.path(), "TPP1", true);
        let backups = tmp.path().join("backups");
        let original = b"\\id MAT\n\\c 1\n\\v 1 old".to_vec();
        std::fs::write(project.join("41MATTPP1.SFM"), &original).unwrap();

        let err = write_book_core(&project, "41MATTPP1.SFM", b"new", Some("deadbeef"), &backups).unwrap_err();
        assert!(err.starts_with("EHASH: "), "{err}");
        assert_eq!(std::fs::read(project.join("41MATTPP1.SFM")).unwrap(), original);
        assert!(!backups.exists(), "mismatch must not create a backup");

        assert!(write_book_core(&project, "99NEWTPP1.SFM", b"x", Some(&sha256_hex(b"")), &backups)
            .unwrap_err()
            .starts_with("ENOENT: "));
        assert!(write_book_core(&project, "../41MATTPP1.SFM", b"x", Some(""), &backups)
            .unwrap_err()
            .starts_with("EINVAL: "));

        let new_bytes = b"\\id MAT\n\\c 1\n\\v 1 new".to_vec();
        let res = write_book_core(&project, "41MATTPP1.SFM", &new_bytes, Some(&sha256_hex(&original)), &backups).unwrap();
        assert_eq!(std::fs::read(project.join("41MATTPP1.SFM")).unwrap(), new_bytes);
        assert_eq!(res.new_blob_hash, sha256_hex(&new_bytes));
        let backup = PathBuf::from(&res.backup_path);
        assert!(backup.starts_with(backups.join("TPP1")), "backup outside project: {backup:?}");
        assert!(backup.file_name().unwrap().to_str().unwrap().starts_with("41MATTPP1.SFM."));
        assert_eq!(std::fs::read(&backup).unwrap(), original);
        // Nothing stray inside the project folder.
        let names: Vec<String> = std::fs::read_dir(&project)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|n| !n.ends_with(".bak")), "{names:?}");
    }

    #[test]
    fn write_without_expected_hash_creates_a_new_file_only() {
        let tmp = tempfile::tempdir().unwrap();
        let project = make_project(tmp.path(), "TPP1", true);
        let backups = tmp.path().join("backups");
        let notes = "Notes_Ryder Wishart.xml";
        let first = b"<CommentList/>".to_vec();
        let res = write_book_core(&project, notes, &first, None, &backups).unwrap();
        assert_eq!(std::fs::read(project.join(notes)).unwrap(), first);
        assert_eq!(res.backup_path, "");
        assert!(!backups.exists(), "creating a file has nothing to back up");
        // A second create must not clobber what is there now.
        let err = write_book_core(&project, notes, b"x", None, &backups).unwrap_err();
        assert!(err.starts_with("EEXIST: "), "{err}");
        assert_eq!(std::fs::read(project.join(notes)).unwrap(), first);
        // From here on it is an ordinary hashed, backed-up write.
        write_book_core(&project, notes, b"<CommentList>1</CommentList>", Some(&sha256_hex(&first)), &backups).unwrap();
        assert!(backups.join("TPP1").exists());
    }

    #[test]
    fn watched_file_filter_covers_books_and_project_xml() {
        assert!(is_watched_file("41MATTPP1.SFM"));
        assert!(is_watched_file("41MATTPP1.sfm"));
        assert!(is_watched_file("x.usfm"));
        assert!(is_watched_file("Settings.xml"));
        assert!(is_watched_file("ProjectUserAccess.xml"));
        assert!(is_watched_file("Notes_Ryder Wishart.xml"));
        assert!(!is_watched_file("unique.id"));
        assert!(!is_watched_file("Notes.xml"));
        assert!(!is_notes_file("Notes.xml"));
        assert!(!is_notes_file("41MATTPP1.SFM"));
    }
}
