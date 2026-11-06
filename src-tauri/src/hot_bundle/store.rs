//! On-disk state machine under `<app data>/bundles/`.
//!
//! ```text
//! bundles/
//!   <version>/          extracted SPA (index.html at its root) + bundle.json {version, sha}
//!   staging/            in-progress downloads; wiped on every launch
//!   staged              pointer: version to apply on the next launch
//!   current             pointer: version being served (absent → embedded assets)
//!   previous            pointer: version to fall back to if `current` never boots
//!   pending             marker: `current` was just applied and has not yet called bundle_booted
//!   last_rollback       pointer: last version rolled back, so the SPA can tell the user
//!   quarantine.json     versions that never booted; never downloaded again
//! ```
//!
//! Pointers are written to a temp file and renamed so a crash mid-write leaves either the old
//! value or the new one, never a torn file. Pure `std::fs`, so it runs under `cargo test`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const STAGED: &str = "staged";
const CURRENT: &str = "current";
const PREVIOUS: &str = "previous";
const PENDING: &str = "pending";
const LAST_ROLLBACK: &str = "last_rollback";
const QUARANTINE: &str = "quarantine.json";
const STAGING_DIR: &str = "staging";
const BUNDLE_META: &str = "bundle.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BundleInfo {
    pub version: String,
    pub sha: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct LaunchOutcome {
    /// Version that moved from `staged` to `current` on this launch.
    pub applied: Option<String>,
    /// Version that was `pending` from the last run and never booted.
    pub rolled_back: Option<String>,
}

pub struct BundleStore {
    root: PathBuf,
}

impl BundleStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.root.join(STAGING_DIR)
    }

    pub fn version_dir(&self, version: &str) -> PathBuf {
        self.root.join(version)
    }

    pub fn current_version(&self) -> Option<String> {
        self.read_pointer(CURRENT)
    }

    pub fn staged_version(&self) -> Option<String> {
        self.read_pointer(STAGED)
    }

    pub fn last_rollback(&self) -> Option<String> {
        self.read_pointer(LAST_ROLLBACK)
    }

    /// The directory to serve from, or `None` when the embedded assets should be used.
    pub fn current_dir(&self) -> Option<PathBuf> {
        let version = self.current_version()?;
        let dir = self.version_dir(&version);
        self.is_usable(&version).then_some(dir)
    }

    pub fn info(&self, version: &str) -> Option<BundleInfo> {
        let raw = fs::read(self.version_dir(version).join(BUNDLE_META)).ok()?;
        serde_json::from_slice(&raw).ok()
    }

    pub fn is_quarantined(&self, version: &str) -> bool {
        self.quarantine().iter().any(|v| v == version)
    }

    /// True when a bundle with this version is already current or staged, i.e. a manifest
    /// announcing it is not news.
    pub fn knows(&self, version: &str) -> bool {
        self.current_version().as_deref() == Some(version) || self.staged_version().as_deref() == Some(version)
    }

    /// Moves an extracted, verified tree into place and points `staged` at it. `extracted_root`
    /// must be on the same filesystem (it is: it lives under `staging/`), so the rename is atomic.
    pub fn stage(&self, info: &BundleInfo, extracted_root: &Path) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let target = self.version_dir(&info.version);
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
        }
        fs::rename(extracted_root, &target).map_err(|e| format!("stage {}: {e}", info.version))?;
        let meta = serde_json::to_vec(info).map_err(|e| e.to_string())?;
        fs::write(target.join(BUNDLE_META), meta).map_err(|e| e.to_string())?;
        self.write_pointer(STAGED, &info.version)
    }

    /// Run once per launch, before the window exists. Rolls back a bundle that never booted,
    /// then applies whatever is staged, then prunes to at most `current` + `previous`.
    pub fn launch(&self) -> Result<LaunchOutcome, String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let mut outcome = LaunchOutcome::default();

        if let Some(pending) = self.read_pointer(PENDING) {
            self.clear_pointer(PENDING)?;
            if self.current_version().as_deref() == Some(pending.as_str()) {
                match self.read_pointer(PREVIOUS).filter(|v| self.is_usable(v)) {
                    Some(previous) => self.write_pointer(CURRENT, &previous)?,
                    None => self.clear_pointer(CURRENT)?,
                }
            }
            self.clear_pointer(PREVIOUS)?;
            self.add_to_quarantine(&pending)?;
            self.write_pointer(LAST_ROLLBACK, &pending)?;
            if self.staged_version().as_deref() == Some(pending.as_str()) {
                self.clear_pointer(STAGED)?;
            }
            outcome.rolled_back = Some(pending);
        }

        if let Some(staged) = self.staged_version() {
            self.clear_pointer(STAGED)?;
            let current = self.current_version();
            if self.is_quarantined(&staged) || !self.is_usable(&staged) {
                log::warn!("[hot_bundle] staged bundle {staged} is quarantined or incomplete; not applying");
            } else if current.as_deref() != Some(staged.as_str()) {
                if let Some(current) = current {
                    self.write_pointer(PREVIOUS, &current)?;
                }
                self.write_pointer(CURRENT, &staged)?;
                self.write_pointer(PENDING, &staged)?;
                outcome.applied = Some(staged);
            }
        }

        self.prune()?;
        Ok(outcome)
    }

    /// The SPA mounted inside the new bundle: it is safe to keep.
    pub fn booted(&self) -> Result<(), String> {
        self.clear_pointer(PENDING)
    }

    fn is_usable(&self, version: &str) -> bool {
        self.version_dir(version).join("index.html").is_file()
    }

    fn quarantine(&self) -> Vec<String> {
        fs::read(self.root.join(QUARANTINE))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    fn add_to_quarantine(&self, version: &str) -> Result<(), String> {
        let mut list = self.quarantine();
        if !list.iter().any(|v| v == version) {
            list.push(version.to_string());
        }
        let raw = serde_json::to_vec(&list).map_err(|e| e.to_string())?;
        self.write_atomic(QUARANTINE, &raw)
    }

    /// Keep only `current` and `previous`; everything else (including quarantined versions and
    /// half-finished downloads) is disk the user never asked to spend.
    fn prune(&self) -> Result<(), String> {
        let keep: Vec<String> = [CURRENT, PREVIOUS].iter().filter_map(|p| self.read_pointer(p)).collect();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if keep.contains(&name) {
                continue;
            }
            if let Err(err) = fs::remove_dir_all(&path) {
                log::warn!("[hot_bundle] could not remove {}: {err}", path.display());
            }
        }
        Ok(())
    }

    fn read_pointer(&self, name: &str) -> Option<String> {
        let raw = fs::read_to_string(self.root.join(name)).ok()?;
        let trimmed = raw.trim();
        // A version is a path segment we join onto `root`; refuse anything that could escape.
        let safe = !trimmed.is_empty()
            && trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
        safe.then(|| trimmed.to_string())
    }

    fn write_pointer(&self, name: &str, value: &str) -> Result<(), String> {
        self.write_atomic(name, value.as_bytes())
    }

    fn clear_pointer(&self, name: &str) -> Result<(), String> {
        match fs::remove_file(self.root.join(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("clear {name}: {e}")),
        }
    }

    fn write_atomic(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let tmp = self.root.join(format!("{name}.tmp"));
        fs::write(&tmp, bytes).map_err(|e| format!("write {name}: {e}"))?;
        fs::rename(&tmp, self.root.join(name)).map_err(|e| format!("commit {name}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, BundleStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BundleStore::new(dir.path().join("bundles"));
        (dir, store)
    }

    /// Simulates a finished download: an extracted tree in `staging/` handed to `stage`.
    fn stage(store: &BundleStore, version: &str) {
        let extracted = store.staging_dir().join(version).join("root");
        fs::create_dir_all(&extracted).unwrap();
        fs::write(extracted.join("index.html"), version).unwrap();
        store
            .stage(&BundleInfo { version: version.into(), sha: format!("sha-{version}") }, &extracted)
            .unwrap();
    }

    #[test]
    fn stage_apply_boot_keeps_the_bundle() {
        let (_d, s) = store();
        assert_eq!(s.launch().unwrap(), LaunchOutcome::default());
        assert_eq!(s.current_dir(), None, "fresh install serves embedded assets");

        stage(&s, "2026.11.05.01");
        assert_eq!(s.staged_version().as_deref(), Some("2026.11.05.01"));
        assert!(s.knows("2026.11.05.01"));
        assert_eq!(s.info("2026.11.05.01").unwrap().sha, "sha-2026.11.05.01");

        // Next launch: staged becomes current and is pending until the SPA reports in.
        let out = s.launch().unwrap();
        assert_eq!(out.applied.as_deref(), Some("2026.11.05.01"));
        assert_eq!(s.current_version().as_deref(), Some("2026.11.05.01"));
        assert_eq!(s.staged_version(), None);
        assert!(s.root.join(PENDING).exists());
        assert!(!s.staging_dir().exists(), "staging is wiped on launch");

        s.booted().unwrap();
        assert!(!s.root.join(PENDING).exists());

        // A clean relaunch changes nothing.
        assert_eq!(s.launch().unwrap(), LaunchOutcome::default());
        assert_eq!(s.current_dir(), Some(s.version_dir("2026.11.05.01")));
    }

    #[test]
    fn a_bundle_that_never_boots_is_rolled_back_and_quarantined() {
        let (_d, s) = store();
        stage(&s, "v1");
        s.launch().unwrap();
        s.booted().unwrap();

        stage(&s, "v2");
        assert_eq!(s.launch().unwrap().applied.as_deref(), Some("v2"));
        // ...the SPA never calls bundle_booted; the user relaunches.
        let out = s.launch().unwrap();
        assert_eq!(out.rolled_back.as_deref(), Some("v2"));
        assert_eq!(s.current_version().as_deref(), Some("v1"));
        assert_eq!(s.last_rollback().as_deref(), Some("v2"));
        assert!(s.is_quarantined("v2"));
        assert!(!s.version_dir("v2").exists(), "quarantined bundle is removed from disk");
        assert!(!s.root.join(PENDING).exists());

        // The quarantined version is refused even if it gets staged again.
        stage(&s, "v2");
        assert_eq!(s.launch().unwrap(), LaunchOutcome::default());
        assert_eq!(s.current_version().as_deref(), Some("v1"));
        assert!(!s.version_dir("v2").exists());
    }

    #[test]
    fn rollback_with_no_previous_falls_back_to_embedded() {
        let (_d, s) = store();
        stage(&s, "v1");
        s.launch().unwrap();
        assert_eq!(s.launch().unwrap().rolled_back.as_deref(), Some("v1"));
        assert_eq!(s.current_version(), None);
        assert_eq!(s.current_dir(), None);
    }

    #[test]
    fn at_most_two_versions_survive_on_disk() {
        let (_d, s) = store();
        for v in ["v1", "v2", "v3"] {
            stage(&s, v);
            s.launch().unwrap();
            s.booted().unwrap();
        }
        assert!(!s.version_dir("v1").exists());
        assert!(s.version_dir("v2").exists());
        assert!(s.version_dir("v3").exists());
        assert_eq!(s.current_version().as_deref(), Some("v3"));
    }

    #[test]
    fn pointer_values_that_could_escape_the_root_are_ignored() {
        let (_d, s) = store();
        fs::create_dir_all(&s.root).unwrap();
        fs::write(s.root.join(CURRENT), "../../etc").unwrap();
        assert_eq!(s.current_version(), None);
    }
}
