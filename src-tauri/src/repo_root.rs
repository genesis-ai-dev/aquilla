use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// Sanitizes a repo_key to [A-Za-z0-9._-], mapping any other character to
// "_", and rejects results that would resolve to the repos dir itself or its
// parent. Split out from `repo_dir` so the traversal-defense logic is
// testable without an AppHandle.
fn sanitize_repo_key(repo_key: &str) -> Result<String, String> {
    let safe: String = repo_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err(format!("EINVAL: invalid repo_key: {repo_key:?}"));
    }
    Ok(safe)
}

// Returns <app data dir>/repos/<repo_key>, creating parents as needed.
// The repo_key is path-sanitized: only [A-Za-z0-9._-] are allowed; any other
// character becomes "_". This prevents path traversal via "../" in repo_key.
pub fn repo_dir(app: &AppHandle, repo_key: &str) -> Result<PathBuf, String> {
    let safe = sanitize_repo_key(repo_key)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_repo_key_passes_through_safe_chars() {
        assert_eq!(sanitize_repo_key("my-repo_123.git").unwrap(), "my-repo_123.git");
    }

    #[test]
    fn sanitize_repo_key_replaces_unsafe_chars() {
        assert_eq!(sanitize_repo_key("../etc/passwd").unwrap(), ".._etc_passwd");
        assert_eq!(sanitize_repo_key("a/b\\c d").unwrap(), "a_b_c_d");
    }

    #[test]
    fn sanitize_repo_key_rejects_empty_or_dot_only() {
        assert!(sanitize_repo_key("").is_err());
        assert!(sanitize_repo_key(".").is_err());
        assert!(sanitize_repo_key("..").is_err());
        // ".." after sanitization (e.g. "??") would NOT collide since "?" maps to "_",
        // but a literal ".." input must still be rejected before sanitization changes it.
    }

    #[test]
    fn safe_join_resolves_nested_relative_path() {
        let root = PathBuf::from("/data/repos/foo");
        let joined = safe_join(&root, "a/b/c.txt").unwrap();
        assert_eq!(joined, PathBuf::from("/data/repos/foo/a/b/c.txt"));
    }

    #[test]
    fn safe_join_skips_empty_and_dot_segments() {
        let root = PathBuf::from("/data/repos/foo");
        let joined = safe_join(&root, "a//./b/").unwrap();
        assert_eq!(joined, PathBuf::from("/data/repos/foo/a/b"));
    }

    #[test]
    fn safe_join_rejects_dot_dot_traversal() {
        let root = PathBuf::from("/data/repos/foo");
        assert!(safe_join(&root, "../../etc/passwd").is_err());
        assert!(safe_join(&root, "a/../../b").is_err());
    }

    #[test]
    fn safe_join_root_itself_is_allowed() {
        let root = PathBuf::from("/data/repos/foo");
        let joined = safe_join(&root, "").unwrap();
        assert_eq!(joined, root);
    }
}
