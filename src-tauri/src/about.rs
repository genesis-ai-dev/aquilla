//! The native "About Aquilla" menu item and the small window it opens.
//!
//! The page is compiled into the shell (`about.html`) and served over its own URI scheme, so
//! it renders even when the hot bundle is missing or broken, and it never depends on which
//! SPA version is currently installed. Links are plain `<a href>`s: the window's navigation
//! hook refuses to leave the about page and hands the URL to the OS browser instead.

use std::borrow::Cow;

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(not(target_os = "macos"))]
use tauri::menu::HELP_SUBMENU_ID;
use tauri::Wry;
use tauri::{AppHandle, Manager, UriSchemeContext, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

pub const SCHEME: &str = "aquilla-about";
const WINDOW_LABEL: &str = "about";
const MENU_ID: &str = "aquilla-about";

const PAGE: &str = include_str!("about.html");
const MARK_SVG: &str = include_str!("../../src/branding/assets/aquilla/mark-icon.svg");

/// Tauri's default menu with its native About panel swapped for ours: on macOS the
/// application submenu is rebuilt (About is its first entry), elsewhere the Help submenu is.
/// Rebuilding rather than editing in place keeps this independent of muda's item labels.
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    let about = MenuItem::with_id(app, MENU_ID, "About Aquilla", true, None::<&str>)?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            app.package_info().name.clone(),
            true,
            &[
                &about,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        menu.remove_at(0)?;
        menu.prepend(&app_menu)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(help) = menu.get(HELP_SUBMENU_ID) {
            menu.remove(&help)?;
        }
        let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[&about])?;
        menu.append(&help)?;
    }
    Ok(menu)
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id() == MENU_ID {
        if let Err(err) = open_about_window(app) {
            log::warn!("[about] failed to open window: {err}");
        }
    }
}

fn open_about_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        return existing.set_focus();
    }
    let opener = app.clone();
    let url: tauri::Url = format!("{SCHEME}://localhost/").parse().expect("static about url");
    let builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::CustomProtocol(url))
        .title("About Aquilla")
        .inner_size(400.0, 520.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .center()
        .on_navigation(move |target| {
            if target.scheme() == SCHEME {
                return true;
            }
            if matches!(target.scheme(), "http" | "https") {
                if let Err(err) = opener.opener().open_url(target.as_str(), None::<&str>) {
                    log::warn!("[about] could not open {target}: {err}");
                }
            }
            false
        });
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    builder.build()?;
    Ok(())
}

pub fn serve_request(ctx: UriSchemeContext<'_, tauri::Wry>, _request: http::Request<Vec<u8>>) -> http::Response<Cow<'static, [u8]>> {
    let app = ctx.app_handle();
    let body = render(app);
    http::Response::builder()
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .body(Cow::Owned(body.into_bytes()))
        .expect("static about response")
}

fn render(app: &AppHandle) -> String {
    let shell = app.package_info().version.to_string();
    PAGE.replace("{{MARK_SVG}}", MARK_SVG)
        .replace("{{SHELL_VERSION}}", &shell)
        .replace("{{BUNDLE_VERSION}}", &bundle_version(app))
}

fn bundle_version(app: &AppHandle) -> String {
    crate::hot_bundle::current_bundle_version(app)
}

#[cfg(test)]
mod tests {
    use super::PAGE;

    #[test]
    fn page_carries_every_link_and_placeholder() {
        for needle in [
            "{{MARK_SVG}}",
            "{{SHELL_VERSION}}",
            "{{BUNDLE_VERSION}}",
            "https://aquilla.app",
            "https://aquilla.app/privacy",
            "https://aquilla.app/terms",
            "https://frontierrnd.com",
            "https://github.com/genesis-ai-dev/aquilla",
        ] {
            assert!(PAGE.contains(needle), "about.html is missing {needle}");
        }
    }

    #[test]
    fn page_has_no_scripts() {
        // Links are handled natively by on_navigation; the page must stay CSP-clean.
        assert!(!PAGE.contains("<script"));
    }
}
