use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default)]
struct TokenStore {
    jwt: Option<String>,
    refresh_token: Option<String>,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("tokens.json"))
        .map_err(|e| e.to_string())
}

// Path-based halves of read_store/write_store, split out so the
// serialize/deserialize round trip is testable against a temp file without
// a `tauri::AppHandle`.
fn read_store_at(path: &std::path::Path) -> TokenStore {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store_at(path: &std::path::Path, store: &TokenStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, serde_json::to_string_pretty(store).unwrap())
        .map_err(|e| e.to_string())
}

fn read_store(app: &tauri::AppHandle) -> TokenStore {
    store_path(app)
        .ok()
        .map(|p| read_store_at(&p))
        .unwrap_or_default()
}

fn write_store(app: &tauri::AppHandle, store: &TokenStore) -> Result<(), String> {
    write_store_at(&store_path(app)?, store)
}

pub fn store_tokens(app: &tauri::AppHandle, token: String, refresh_token: String) -> Result<(), String> {
    let mut store = read_store(app);
    store.jwt = Some(token);
    store.refresh_token = Some(refresh_token);
    write_store(app, &store)
}

#[tauri::command]
pub fn get_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(read_store(&app).jwt)
}

#[tauri::command]
pub fn set_token(
    app: tauri::AppHandle,
    token: String,
    refresh_token: String,
) -> Result<(), String> {
    let mut store = read_store(&app);
    store.jwt = Some(token);
    store.refresh_token = Some(refresh_token);
    write_store(&app, &store)
}

#[tauri::command]
pub fn clear_token(app: tauri::AppHandle) -> Result<(), String> {
    let mut store = read_store(&app);
    store.jwt = None;
    store.refresh_token = None;
    write_store(&app, &store)
}

#[tauri::command]
pub fn get_refresh_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(read_store(&app).refresh_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unique-per-test path under the OS temp dir; avoids pulling in a
    // tempfile crate dependency just for this.
    fn temp_store_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "aquilla-keychain-test-{name}-{}-{:?}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn read_store_at_missing_file_returns_default() {
        let path = temp_store_path("missing");
        let store = read_store_at(&path);
        assert!(store.jwt.is_none());
        assert!(store.refresh_token.is_none());
    }

    #[test]
    fn write_then_read_round_trips_tokens() {
        let path = temp_store_path("roundtrip");
        let store = TokenStore {
            jwt: Some("jwt-abc".to_string()),
            refresh_token: Some("refresh-def".to_string()),
        };
        write_store_at(&path, &store).unwrap();
        let read_back = read_store_at(&path);
        assert_eq!(read_back.jwt, Some("jwt-abc".to_string()));
        assert_eq!(read_back.refresh_token, Some("refresh-def".to_string()));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn read_store_at_ignores_corrupt_json() {
        let path = temp_store_path("corrupt");
        fs::write(&path, "not json").unwrap();
        let store = read_store_at(&path);
        assert!(store.jwt.is_none());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn write_store_at_creates_missing_parent_dirs() {
        let dir = temp_store_path("parent-dir");
        let path = dir.join("nested").join("tokens.json");
        let store = TokenStore { jwt: Some("x".to_string()), refresh_token: None };
        write_store_at(&path, &store).unwrap();
        assert!(path.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
