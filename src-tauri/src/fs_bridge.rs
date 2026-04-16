use crate::repo_root::{repo_dir, safe_join};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
pub struct FsStat {
    pub kind: &'static str, // "file" | "dir"
    pub size: u64,
    pub mtime_ms: u64,
}

#[tauri::command]
pub async fn fs_read_file(app: AppHandle, repo_key: String, path: String) -> Result<Vec<u8>, String> {
    let root = repo_dir(&app, &repo_key)?;
    let full = safe_join(&root, &path)?;
    tokio::fs::read(&full).await.map_err(|e| map_io(&e))
}

#[tauri::command]
pub async fn fs_write_file(app: AppHandle, repo_key: String, path: String, data: Vec<u8>) -> Result<(), String> {
    let root = repo_dir(&app, &repo_key)?;
    let full = safe_join(&root, &path)?;
    if let Some(parent) = full.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| map_io(&e))?;
    }
    tokio::fs::write(&full, &data).await.map_err(|e| map_io(&e))
}

#[tauri::command]
pub async fn fs_unlink(app: AppHandle, repo_key: String, path: String) -> Result<(), String> {
    let root = repo_dir(&app, &repo_key)?;
    let full = safe_join(&root, &path)?;
    tokio::fs::remove_file(&full).await.map_err(|e| map_io(&e))
}

#[tauri::command]
pub async fn fs_mkdir(app: AppHandle, repo_key: String, path: String, recursive: bool) -> Result<(), String> {
    let root = repo_dir(&app, &repo_key)?;
    let full = safe_join(&root, &path)?;
    if recursive {
        tokio::fs::create_dir_all(&full).await.map_err(|e| map_io(&e))
    } else {
        tokio::fs::create_dir(&full).await.map_err(|e| map_io(&e))
    }
}

#[tauri::command]
pub async fn fs_rmdir(app: AppHandle, repo_key: String, path: String) -> Result<(), String> {
    let root = repo_dir(&app, &repo_key)?;
    let full = safe_join(&root, &path)?;
    tokio::fs::remove_dir(&full).await.map_err(|e| map_io(&e))
}

#[tauri::command]
pub async fn fs_readdir(app: AppHandle, repo_key: String, path: String) -> Result<Vec<String>, String> {
    let root = repo_dir(&app, &repo_key)?;
    let full = safe_join(&root, &path)?;
    let mut out = Vec::new();
    let mut rd = tokio::fs::read_dir(&full).await.map_err(|e| map_io(&e))?;
    while let Some(entry) = rd.next_entry().await.map_err(|e| map_io(&e))? {
        if let Some(name) = entry.file_name().to_str() {
            out.push(name.to_string());
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn fs_stat(app: AppHandle, repo_key: String, path: String) -> Result<FsStat, String> {
    let root = repo_dir(&app, &repo_key)?;
    let full = safe_join(&root, &path)?;
    let md = tokio::fs::metadata(&full).await.map_err(|e| map_io(&e))?;
    let kind = if md.is_dir() { "dir" } else { "file" };
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FsStat { kind, size: md.len(), mtime_ms })
}

#[tauri::command]
pub async fn fs_reset_repo(app: AppHandle, repo_key: String) -> Result<(), String> {
    let root = repo_dir(&app, &repo_key)?;
    if root.exists() {
        tokio::fs::remove_dir_all(&root).await.map_err(|e| map_io(&e))?;
    }
    tokio::fs::create_dir_all(&root).await.map_err(|e| map_io(&e))?;
    Ok(())
}

// Map std::io::Error to a POSIX-style code string that the JS shim
// translates back into err.code, matching what isomorphic-git expects.
fn map_io(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    let code = match e.kind() {
        NotFound => "ENOENT",
        PermissionDenied => "EACCES",
        AlreadyExists => "EEXIST",
        InvalidInput | InvalidData => "EINVAL",
        _ => "EIO",
    };
    format!("{code}: {e}")
}
