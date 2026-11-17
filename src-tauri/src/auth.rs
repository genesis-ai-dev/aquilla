use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[derive(Default)]
pub struct GoogleCallback(Mutex<Option<String>>);

// A URL supplied by web content must never open arbitrary native protocols.
fn valid_authorization_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("accounts.google.com")
            && url.path() == "/o/oauth2/v2/auth"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

#[tauri::command]
pub async fn open_auth_browser(app: tauri::AppHandle, auth_url: String) -> Result<(), String> {
    if !valid_authorization_url(&auth_url) {
        return Err("invalid_authorization_url".into());
    }
    app.opener()
        .open_url(auth_url, None::<&str>)
        .map_err(|_| "browser_open_failed".into())
}

#[tauri::command]
pub fn google_login_supported() -> bool {
    true
}

#[tauri::command]
pub fn take_google_callback(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .state::<GoogleCallback>()
        .0
        .lock()
        .map_err(|_| "callback_unavailable")?
        .take())
}

pub fn setup_deep_link_handler(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle_callback_url(&handle, url.as_str());
        }
    });
    if let Some(urls) = app.deep_link().get_current()? {
        for url in urls {
            handle_callback_url(app.handle(), url.as_str());
        }
    }
    Ok(())
}

fn valid_callback(value: &str) -> bool {
    if value.len() > 512 {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "aquilla"
        || url.host_str() != Some("auth")
        || url.path() != "/google"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
    {
        return false;
    }
    let params: Vec<_> =
        url::form_urlencoded::parse(url.fragment().unwrap_or("").as_bytes()).collect();
    if params.len() != 2 {
        return false;
    }
    let states: Vec<_> = params.iter().filter(|(key, _)| key == "state").collect();
    if states.len() != 1
        || states[0].1.len() != 43
        || !states[0]
            .1
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return false;
    }
    params.iter().any(|(key, value)| {
        (key == "code"
            && value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            || (key == "error"
                && ["cancelled", "invalid_request", "provider_failed"].contains(&value.as_ref()))
    })
}

fn handle_callback_url(app: &tauri::AppHandle, value: &str) {
    // Never accept credentials from a URL. The SPA must match the local attempt
    // and redeem this short-lived code using its private PKCE verifier.
    if !valid_callback(value) {
        return;
    }
    if let Ok(mut slot) = app.state::<GoogleCallback>().0.lock() {
        *slot = Some(value.to_owned());
    }
    let _ = app.emit("auth://google-return", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(feature = "e2e-webdriver")]
#[tauri::command]
pub fn simulate_deep_link_callback(app: tauri::AppHandle, url: String) {
    handle_callback_url(&app, &url);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_handoffs_and_rejects_credentials_or_foreign_destinations() {
        let good = format!(
            "aquilla://auth/google#code={}&state={}",
            "a".repeat(64),
            "b".repeat(43)
        );
        assert!(valid_callback(&good));
        assert!(valid_callback(&format!(
            "aquilla://auth/google#error=cancelled&state={}",
            "b".repeat(43)
        )));
        for bad in [
            good.replace("aquilla:", "codex:"),
            good.replace("auth/google", "other/google"),
            good.replace("#", "?"),
            format!("{good}&token=jwt"),
            good.replace("code=", "token="),
            "aquilla://auth/callback?token=jwt&refresh=r".into(),
        ] {
            assert!(!valid_callback(&bad));
        }
    }
    #[test]
    fn opens_only_google_authorization_urls() {
        assert!(valid_authorization_url(
            "https://accounts.google.com/o/oauth2/v2/auth?state=example"
        ));
        for bad in [
            "file:///etc/passwd",
            "https://evil.example/o/oauth2/v2/auth",
            "https://accounts.google.com/other",
            "https://user@accounts.google.com/o/oauth2/v2/auth",
        ] {
            assert!(!valid_authorization_url(bad));
        }
    }
}
