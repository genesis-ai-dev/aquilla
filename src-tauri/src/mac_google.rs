use std::ffi::{c_char, c_void, CStr, CString};
use tauri::Manager;
use tokio::sync::oneshot;

extern "C" {
    fn aquilla_google_begin(
        window: *mut c_void,
        url: *const c_char,
        attempt: *const c_char,
        private_session: bool,
        context: *mut c_void,
        finish: extern "C" fn(*mut c_void, *const c_char, bool),
    );
    fn aquilla_google_cancel(attempt: *const c_char);
}

type Reply = oneshot::Sender<Result<String, String>>;

extern "C" fn finish(context: *mut c_void, url: *const c_char, cancelled: bool) {
    // begin transfers one sender and invokes this completion exactly once.
    let reply = unsafe { Box::from_raw(context.cast::<Reply>()) };
    let result = if url.is_null() {
        Err(if cancelled {
            "cancelled"
        } else {
            "browser_open_failed"
        }
        .to_owned())
    } else {
        unsafe { CStr::from_ptr(url) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "invalid_callback".to_owned())
    };
    let _ = reply.send(result);
}

pub async fn open(app: tauri::AppHandle, url: String, attempt: String, private_session: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("missing_window")?;
    let url = CString::new(url).map_err(|_| "invalid_url")?;
    let attempt = CString::new(attempt).map_err(|_| "invalid_attempt")?;
    let (reply, response) = oneshot::channel::<Result<String, String>>();
    app.run_on_main_thread(move || match window.ns_window() {
        Ok(anchor) => unsafe {
            aquilla_google_begin(
                anchor,
                url.as_ptr(),
                attempt.as_ptr(),
                private_session,
                Box::into_raw(Box::new(reply)).cast(),
                finish,
            )
        },
        Err(_) => {
            let _ = reply.send(Err("missing_window".into()));
        }
    })
    .map_err(|_| "missing_window")?;
    let callback = response.await.map_err(|_| "browser_open_failed")??;
    if !super::valid_callback(&callback) {
        return Err("invalid_callback".into());
    }
    super::handle_callback_url(&app, &callback);
    Ok(())
}

pub fn cancel(app: tauri::AppHandle, attempt: String) {
    if let Ok(attempt) = CString::new(attempt) {
        let _ = app.run_on_main_thread(move || unsafe { aquilla_google_cancel(attempt.as_ptr()) });
    }
}
