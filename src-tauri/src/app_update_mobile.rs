//! Mobile stand-in for `app_update`: iOS/Android update through the app stores, so the
//! in-app updater always reports "up to date" and install is refused.

use serde::Serialize;

#[derive(Default)]
pub struct AppUpdateState;

#[derive(Serialize)]
pub struct DownloadedUpdate;

#[tauri::command]
pub async fn download_app_update() -> Result<Option<DownloadedUpdate>, String> {
    Ok(None)
}

#[tauri::command]
pub fn install_app_update() -> Result<(), String> {
    Err("in-app updates are not supported on mobile".into())
}
