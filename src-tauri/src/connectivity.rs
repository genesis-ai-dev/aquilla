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

// True when a freshly-observed `online` reading differs from the previously
// recorded `prev` state, i.e. the loop should emit `connectivity://changed`.
// Split out of `start_connectivity_loop` so the edge-detection is testable
// without a `tauri::AppHandle` or the sleep/network round trip.
fn state_changed(prev: bool, online: bool) -> bool {
    prev != online
}

pub fn start_connectivity_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let online = check_connectivity_once().await;
            let prev = IS_ONLINE.swap(online, Ordering::Relaxed);
            if state_changed(prev, online) {
                let _ = app.emit("connectivity://changed", serde_json::json!({ "online": online }));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_changed_detects_transitions_both_ways() {
        assert!(state_changed(true, false));
        assert!(state_changed(false, true));
    }

    #[test]
    fn state_changed_is_false_when_unchanged() {
        assert!(!state_changed(true, true));
        assert!(!state_changed(false, false));
    }
}
