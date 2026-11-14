//! macOS overlay title bar: the SPA's top row stands in for the native title
//! strip (see `src/hooks/useMacTitlebarOverlay.ts`).

/// Runs before any page script on every load: tells the SPA this shell built
/// the window with the overlay title bar, so it keeps the traffic-light corner
/// clear and offers drag regions. Native knows; the web side shouldn't guess
/// from the user agent.
pub const OVERLAY_FLAG_SCRIPT: &str = "window.__AQUILLA_MAC_TITLEBAR_OVERLAY__ = true;";

/// What the user picked in System Settings › Desktop & Dock › "Double-click a
/// window's title bar to".
#[derive(Debug, PartialEq, Eq)]
enum DoubleClickAction {
    Zoom,
    Minimize,
    Nothing,
}

/// `AppleActionOnDoubleClick` holds "Maximize" (shown as Zoom), "Fill",
/// "Minimize" or "None"; older systems only had the
/// `AppleMiniaturizeOnDoubleClick` bool. Unset means the default, Zoom.
fn parse_action(action: Option<&str>, legacy_minimize: bool) -> DoubleClickAction {
    match action {
        Some("Minimize") => DoubleClickAction::Minimize,
        Some("None") => DoubleClickAction::Nothing,
        Some(_) => DoubleClickAction::Zoom,
        None if legacy_minimize => DoubleClickAction::Minimize,
        None => DoubleClickAction::Zoom,
    }
}

#[cfg(target_os = "macos")]
fn double_click_action() -> DoubleClickAction {
    use objc2_foundation::{NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    let action = defaults
        .stringForKey(&NSString::from_str("AppleActionOnDoubleClick"))
        .map(|s| s.to_string());
    let legacy = defaults.boolForKey(&NSString::from_str("AppleMiniaturizeOnDoubleClick"));
    parse_action(action.as_deref(), legacy)
}

#[cfg(not(target_os = "macos"))]
fn double_click_action() -> DoubleClickAction {
    DoubleClickAction::Zoom
}

/// Double click on one of the SPA's title-bar regions. Zoom mirrors Tauri's
/// `internal_toggle_maximize` (respects a non-resizable window).
#[tauri::command]
pub fn titlebar_double_click(window: tauri::WebviewWindow) -> Result<(), String> {
    let run = || -> tauri::Result<()> {
        match double_click_action() {
            DoubleClickAction::Nothing => {}
            DoubleClickAction::Minimize => window.minimize()?,
            DoubleClickAction::Zoom => {
                if window.is_resizable()? {
                    if window.is_maximized()? {
                        window.unmaximize()?
                    } else if window.is_maximizable()? {
                        window.maximize()?
                    }
                }
            }
        }
        Ok(())
    };
    run().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_the_system_double_click_setting() {
        assert_eq!(parse_action(Some("Maximize"), false), DoubleClickAction::Zoom);
        assert_eq!(parse_action(Some("Fill"), false), DoubleClickAction::Zoom);
        assert_eq!(parse_action(Some("Minimize"), false), DoubleClickAction::Minimize);
        assert_eq!(parse_action(Some("None"), false), DoubleClickAction::Nothing);
        // The modern key wins over the legacy bool.
        assert_eq!(parse_action(Some("Maximize"), true), DoubleClickAction::Zoom);
        assert_eq!(parse_action(None, true), DoubleClickAction::Minimize);
        assert_eq!(parse_action(None, false), DoubleClickAction::Zoom);
    }
}
