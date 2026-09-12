use axum::{
    body::Body,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Router,
};
use std::sync::{Arc, RwLock};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct LlmConfig {
    pub endpoint: Arc<RwLock<String>>,
    pub model: Arc<RwLock<String>>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            endpoint: Arc::new(RwLock::new("http://localhost:11434".to_string())),
            model: Arc::new(RwLock::new("llama3".to_string())),
        }
    }
}

#[tauri::command]
pub async fn set_llm_config(
    state: tauri::State<'_, LlmConfig>,
    endpoint: String,
    model: String,
) -> Result<(), String> {
    *state.endpoint.write().map_err(|e| e.to_string())? = endpoint;
    *state.model.write().map_err(|e| e.to_string())? = model;
    Ok(())
}

#[tauri::command]
pub async fn get_llm_config(
    state: tauri::State<'_, LlmConfig>,
) -> Result<(String, String), String> {
    let endpoint = state.endpoint.read().map_err(|e| e.to_string())?.clone();
    let model = state.model.read().map_err(|e| e.to_string())?.clone();
    Ok((endpoint, model))
}

pub async fn proxy_handler(
    State((config, client)): State<(LlmConfig, reqwest::Client)>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let endpoint = match config.endpoint.read() {
        Ok(e) => e.clone(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("config lock poisoned: {e}"),
            )
                .into_response()
        }
    };

    let url = format!("{endpoint}/api/chat");
    let upstream = match client
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("upstream error: {e}")).into_response()
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let stream = upstream.bytes_stream();
    (status, Body::from_stream(stream)).into_response()
}

pub fn build_router(config: LlmConfig) -> Router {
    let client = reqwest::Client::new();
    Router::new()
        .route("/llm/chat", post(proxy_handler))
        .layer(CorsLayer::permissive())
        .with_state((config, client))
}
