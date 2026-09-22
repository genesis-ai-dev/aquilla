mod auth;
mod connectivity;
mod fs_bridge;
mod keychain;
mod llm_proxy;
mod repo_root;
mod shutdown_guard;

use llm_proxy::LlmConfig;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }

    // e2e/tauri/smoke.spec.ts's embedded WebDriver server. Gated behind the `e2e-webdriver`
    // Cargo feature (never enabled for the signed release binary tauri-action publishes).
    #[cfg(feature = "e2e-webdriver")]
    {
        builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    builder
        .on_window_event(shutdown_guard::handle_window_event)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            auth::setup_deep_link_handler(app)?;

            connectivity::start_connectivity_loop(app.handle().clone());

            let llm_config = LlmConfig::default();
            let router = llm_proxy::build_router(llm_config.clone());
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:49152")
                    .await
                    .expect("failed to bind axum server");
                axum::serve(listener, router)
                    .await
                    .expect("axum server error");
            });
            app.manage(llm_config);
            app.manage(shutdown_guard::ShutdownGuardState::new());

            Ok(())
        })
        .invoke_handler({
            #[cfg(feature = "e2e-webdriver")]
            {
                tauri::generate_handler![
                    fs_bridge::fs_read_file,
                    fs_bridge::fs_write_file,
                    fs_bridge::fs_unlink,
                    fs_bridge::fs_mkdir,
                    fs_bridge::fs_rmdir,
                    fs_bridge::fs_readdir,
                    fs_bridge::fs_stat,
                    fs_bridge::fs_reset_repo,
                    keychain::get_token,
                    keychain::set_token,
                    keychain::clear_token,
                    keychain::get_refresh_token,
                    auth::open_auth_browser,
                    auth::simulate_deep_link_callback,
                    connectivity::get_connectivity,
                    llm_proxy::set_llm_config,
                    llm_proxy::get_llm_config,
                    shutdown_guard::confirm_offline_shutdown,
                ]
            }
            #[cfg(not(feature = "e2e-webdriver"))]
            {
                tauri::generate_handler![
                    fs_bridge::fs_read_file,
                    fs_bridge::fs_write_file,
                    fs_bridge::fs_unlink,
                    fs_bridge::fs_mkdir,
                    fs_bridge::fs_rmdir,
                    fs_bridge::fs_readdir,
                    fs_bridge::fs_stat,
                    fs_bridge::fs_reset_repo,
                    keychain::get_token,
                    keychain::set_token,
                    keychain::clear_token,
                    keychain::get_refresh_token,
                    auth::open_auth_browser,
                    connectivity::get_connectivity,
                    llm_proxy::set_llm_config,
                    llm_proxy::get_llm_config,
                    shutdown_guard::confirm_offline_shutdown,
                ]
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(shutdown_guard::handle_run_event);
}
