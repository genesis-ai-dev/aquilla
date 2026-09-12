use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

static IS_ONLINE: AtomicBool = AtomicBool::new(true);

pub async fn check_connectivity_once() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .head("https://api.aquilla.app")
        .send()
        .await
        .is_ok()
}

#[tauri::command]
pub async fn get_connectivity() -> bool {
    IS_ONLINE.load(Ordering::Relaxed)
}

pub fn start_connectivity_loop(app: tauri::AppHandle) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let online = check_connectivity_once().await;
            let prev = IS_ONLINE.swap(online, Ordering::Relaxed);
            if online != prev {
                let _ = app.emit("connectivity://changed", serde_json::json!({ "online": online }));
            }
        }
    });
}
