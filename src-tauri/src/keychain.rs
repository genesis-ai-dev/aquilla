// Use keyring crate v3 for cross-platform OS keychain access.
// Service name: "com.frontierrnd.codex"
// Key names: "jwt" and "refresh_token"

const SERVICE: &str = "com.frontierrnd.codex";
const JWT_KEY: &str = "jwt";
const REFRESH_KEY: &str = "refresh_token";

/// Returns the stored JWT from the OS keychain, or `None` if not set.
#[tauri::command]
pub fn get_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, JWT_KEY).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Stores both the JWT and refresh token in the OS keychain.
#[tauri::command]
pub fn set_token(token: String, refresh_token: String) -> Result<(), String> {
    let jwt_entry = keyring::Entry::new(SERVICE, JWT_KEY).map_err(|e| e.to_string())?;
    jwt_entry.set_password(&token).map_err(|e| e.to_string())?;

    let refresh_entry =
        keyring::Entry::new(SERVICE, REFRESH_KEY).map_err(|e| e.to_string())?;
    refresh_entry
        .set_password(&refresh_token)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Deletes both keychain entries. Ignores "not found" errors.
#[tauri::command]
pub fn clear_token() -> Result<(), String> {
    let jwt_entry = keyring::Entry::new(SERVICE, JWT_KEY).map_err(|e| e.to_string())?;
    match jwt_entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }

    let refresh_entry =
        keyring::Entry::new(SERVICE, REFRESH_KEY).map_err(|e| e.to_string())?;
    match refresh_entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }

    Ok(())
}

/// Returns the stored refresh token from the OS keychain, or `None` if not set.
#[tauri::command]
pub fn get_refresh_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, REFRESH_KEY).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
