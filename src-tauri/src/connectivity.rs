//! Online/offline probe behind the desktop app's connectivity chip.
//!
//! The probe target is supplied by the SPA (`set_connectivity_probe_url`, called
//! with its `VITE_AUTH_BASE`) rather than hardcoded, because "is the network up"
//! is not the question the UI is really asking — "can this build reach the
//! backend it was built against" is. A hardcoded `https://api.aquilla.app` made
//! every dev/staging/self-hosted build report PRODUCTION's health: block
//! `api.dev.aquilla.app` and a dev build still cheerfully says "online" while
//! nothing syncs. Until the SPA supplies a URL the state stays `Unknown`, which
//! surfaces as `null` to JS and renders no chip at all — an honest "don't know"
//! instead of a guess.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use tauri::Emitter;

const UNKNOWN: u8 = 0;
const ONLINE: u8 = 1;
const OFFLINE: u8 = 2;

/// Starts `UNKNOWN`: no probe has completed, so the app must not claim either
/// way. The previous `AtomicBool::new(true)` meant the first ten seconds of
/// every launch asserted "online" with nothing behind it.
static STATE: AtomicU8 = AtomicU8::new(UNKNOWN);

/// API base the SPA was built against, or `None` before it has booted.
static PROBE_URL: RwLock<Option<String>> = RwLock::new(None);

/// How long to wait between probes once we have a URL.
const POLL_INTERVAL: Duration = Duration::from_secs(10);
/// How often to re-check for a probe URL during startup, before the SPA has
/// called `set_connectivity_probe_url`. Short so the first real reading lands
/// promptly rather than a full poll interval after boot.
const AWAITING_URL_INTERVAL: Duration = Duration::from_millis(250);

fn probe_url() -> Option<String> {
    PROBE_URL.read().ok().and_then(|u| u.clone())
}

/// Called by the SPA at boot with the API base from `VITE_AUTH_BASE`.
/// Idempotent — re-setting the same URL is a no-op for the loop.
#[tauri::command]
pub fn set_connectivity_probe_url(url: String) {
    let trimmed = url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut slot) = PROBE_URL.write() {
        *slot = Some(trimmed);
    }
}

pub async fn check_connectivity_once(url: &str) -> bool {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(3)).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    client.head(url).send().await.is_ok()
}

/// `None` until the first probe completes — see the module comment. JS reads
/// this as `null` and treats it as "unknown" (`useConnectivity`).
#[tauri::command]
pub async fn get_connectivity() -> Option<bool> {
    match STATE.load(Ordering::Relaxed) {
        ONLINE => Some(true),
        OFFLINE => Some(false),
        _ => None,
    }
}

fn state_for(online: bool) -> u8 {
    if online {
        ONLINE
    } else {
        OFFLINE
    }
}

// True when a freshly-observed state differs from the previously recorded one,
// i.e. the loop should emit `connectivity://changed`. Split out of
// `start_connectivity_loop` so the edge-detection is testable without a
// `tauri::AppHandle` or the sleep/network round trip. The first real reading
// always differs from `UNKNOWN`, so it is always announced.
fn state_changed(prev: u8, next: u8) -> bool {
    prev != next
}

pub fn start_connectivity_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let Some(url) = probe_url() else {
                // The SPA has not told us what to probe yet.
                tokio::time::sleep(AWAITING_URL_INTERVAL).await;
                continue;
            };
            let online = check_connectivity_once(&url).await;
            let prev = STATE.swap(state_for(online), Ordering::Relaxed);
            if state_changed(prev, state_for(online)) {
                let _ = app.emit("connectivity://changed", serde_json::json!({ "online": online }));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_changed_detects_transitions_both_ways() {
        assert!(state_changed(ONLINE, OFFLINE));
        assert!(state_changed(OFFLINE, ONLINE));
    }

    #[test]
    fn state_changed_is_false_when_unchanged() {
        assert!(!state_changed(ONLINE, ONLINE));
        assert!(!state_changed(OFFLINE, OFFLINE));
    }

    #[test]
    fn first_reading_after_unknown_is_always_announced() {
        assert!(state_changed(UNKNOWN, ONLINE));
        assert!(state_changed(UNKNOWN, OFFLINE));
    }

    #[test]
    fn set_probe_url_trims_trailing_slashes_and_ignores_empty() {
        set_connectivity_probe_url("https://api.example.test/".to_string());
        assert_eq!(probe_url().as_deref(), Some("https://api.example.test"));

        // An empty value must not clear a good URL — a misconfigured build
        // should keep probing the last known host rather than go Unknown.
        set_connectivity_probe_url("   ".to_string());
        assert_eq!(probe_url().as_deref(), Some("https://api.example.test"));
    }
}
