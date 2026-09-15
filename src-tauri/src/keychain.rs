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

fn read_store(app: &tauri::AppHandle) -> TokenStore {
    store_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(app: &tauri::AppHandle, store: &TokenStore) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, serde_json::to_string_pretty(store).unwrap())
        .map_err(|e| e.to_string())
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
