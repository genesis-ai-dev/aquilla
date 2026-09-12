// Auth module: system browser OAuth flow + deep-link token capture

use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use url::Url;

/// Opens the given URL in the system browser to begin the OAuth flow.
/// The `auth_url` is supplied by the SPA from its `VITE_AUTH_BASE` env var.
#[tauri::command]
pub async fn open_auth_browser(app: tauri::AppHandle, auth_url: String) -> Result<(), String> {
    app.shell()
        .open(auth_url, None)
        .map_err(|e| e.to_string())
}

/// Registers the deep-link handler for `codex://auth/callback` URLs.
/// Call this once from `lib.rs` inside the `.setup()` closure.
pub fn setup_deep_link_handler(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_deep_link::DeepLinkExt;

    let app_handle = app.handle().clone();

    app.deep_link().on_open_url(move |event| {
        for url_str in event.urls() {
            handle_callback_url(&app_handle, url_str.as_str());
        }
    });

    Ok(())
}

/// Parses a `codex://auth/callback?token=<jwt>&refresh=<refresh_token>` URL,
/// persists the credentials to the OS keychain, and notifies the SPA.
fn handle_callback_url(app: &tauri::AppHandle, url_str: &str) {
    match parse_and_store(url_str) {
        Ok(()) => {
            let _ = app.emit(
                "auth://token-received",
                serde_json::json!({ "success": true }),
            );
        }
        Err(err) => {
            let _ = app.emit(
                "auth://token-received",
                serde_json::json!({ "success": false, "error": err }),
            );
        }
    }
}

/// Parses the callback URL and writes credentials to the keychain.
fn parse_and_store(url_str: &str) -> Result<(), String> {
    let url = Url::parse(url_str).map_err(|e| format!("Invalid callback URL: {e}"))?;

    let mut token: Option<String> = None;
    let mut refresh: Option<String> = None;

    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "token" => token = Some(value.into_owned()),
            "refresh" => refresh = Some(value.into_owned()),
            _ => {}
        }
    }

    let token = token.ok_or_else(|| "Missing 'token' query parameter".to_string())?;
    let refresh = refresh.ok_or_else(|| "Missing 'refresh' query parameter".to_string())?;

    // Write to the OS keychain directly (same logic as keychain::set_token but
    // called without going through the Tauri command machinery).
    let jwt_entry =
        keyring::Entry::new("com.frontierrnd.codex", "jwt").map_err(|e| e.to_string())?;
    jwt_entry.set_password(&token).map_err(|e| e.to_string())?;

    let refresh_entry =
        keyring::Entry::new("com.frontierrnd.codex", "refresh_token")
            .map_err(|e| e.to_string())?;
    refresh_entry
        .set_password(&refresh)
        .map_err(|e| e.to_string())?;

    Ok(())
}
