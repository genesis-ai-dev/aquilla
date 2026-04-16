mod fs_bridge;
mod repo_root;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_bridge::fs_read_file,
            fs_bridge::fs_write_file,
            fs_bridge::fs_unlink,
            fs_bridge::fs_mkdir,
            fs_bridge::fs_rmdir,
            fs_bridge::fs_readdir,
            fs_bridge::fs_stat,
            fs_bridge::fs_reset_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
