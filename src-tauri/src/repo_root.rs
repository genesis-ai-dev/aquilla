use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// Returns <app data dir>/repos/<repo_key>, creating parents as needed.
// The repo_key is path-sanitized: only [A-Za-z0-9._-] are allowed; any other
// character becomes "_". This prevents path traversal via "../" in repo_key.
pub fn repo_dir(app: &AppHandle, repo_key: &str) -> Result<PathBuf, String> {
    let safe: String = repo_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err(format!("EINVAL: invalid repo_key: {repo_key:?}"));
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("EIO: app_data_dir: {e}"))?
        .join("repos")
        .join(&safe);
    std::fs::create_dir_all(&base).map_err(|e| format!("EIO: mkdir {base:?}: {e}"))?;
    Ok(base)
}

// Joins a relative path under the repo dir and refuses any result that
// escapes the dir (defense in depth against ".." segments slipping past
// the JS layer).
pub fn safe_join(root: &std::path::Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." { continue; }
        if seg == ".." {
            return Err(format!("EINVAL: path escapes repo root: {rel:?}"));
        }
        out.push(seg);
    }
    if !out.starts_with(root) {
        return Err(format!("path escapes repo root: {rel:?}"));
    }
    Ok(out)
}
