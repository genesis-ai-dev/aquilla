use axum::{
    body::Body,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use std::collections::HashMap;
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

/// Resolves the target endpoint for a proxied request: an explicit `?endpoint=`
/// query param wins (used by the Settings UI to test/detect against a value
/// that hasn't been Saved yet), falling back to the persisted `LlmConfig` set
/// via `set_llm_config` (used by real completion requests, which always act on
/// the saved config).
fn resolve_endpoint(config: &LlmConfig, params: &HashMap<String, String>) -> Result<String, String> {
    if let Some(e) = params.get("endpoint").filter(|e| !e.is_empty()) {
        return Ok(e.clone());
    }
    config.endpoint.read().map(|e| e.clone()).map_err(|e| e.to_string())
}

pub async fn proxy_handler(
    State((config, client)): State<(LlmConfig, reqwest::Client)>,
    Query(params): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let endpoint = match resolve_endpoint(&config, &params) {
        Ok(e) => e,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("config lock poisoned: {e}"),
            )
                .into_response()
        }
    };

    // OpenAI-compatible chat endpoint — matches Ollama's own /v1 compat layer,
    // LM Studio, llama.cpp server, vLLM, and text-generation-webui alike, so
    // the offline path isn't locked to one local runner.
    let url = format!("{endpoint}/v1/chat/completions");
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

/// GET /llm/models — lists models available at the target endpoint via the
/// same OpenAI-compatible `/v1/models` listing every local runner supports,
/// so the Settings UI can offer a "Detect models" picker instead of requiring
/// the exact model id to be typed and remembered.
pub async fn models_handler(
    State((config, client)): State<(LlmConfig, reqwest::Client)>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let endpoint = match resolve_endpoint(&config, &params) {
        Ok(e) => e,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("config lock poisoned: {e}"),
            )
                .into_response()
        }
    };

    let url = format!("{endpoint}/v1/models");
    let upstream = match client.get(&url).send().await {
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
        .route("/llm/models", get(models_handler))
        .layer(CorsLayer::permissive())
        .with_state((config, client))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_points_at_local_ollama() {
        let config = LlmConfig::default();
        assert_eq!(*config.endpoint.read().unwrap(), "http://localhost:11434");
        assert_eq!(*config.model.read().unwrap(), "llama3");
    }

    #[test]
    fn resolve_endpoint_prefers_query_param_over_saved_config() {
        let config = LlmConfig::default();
        let mut params = HashMap::new();
        params.insert("endpoint".to_string(), "http://127.0.0.1:1234".to_string());
        assert_eq!(resolve_endpoint(&config, &params).unwrap(), "http://127.0.0.1:1234");
    }

    #[test]
    fn resolve_endpoint_ignores_empty_query_param() {
        let config = LlmConfig::default();
        let mut params = HashMap::new();
        params.insert("endpoint".to_string(), "".to_string());
        assert_eq!(resolve_endpoint(&config, &params).unwrap(), "http://localhost:11434");
    }

    #[test]
    fn resolve_endpoint_falls_back_to_saved_config_when_no_param() {
        let config = LlmConfig::default();
        *config.endpoint.write().unwrap() = "http://localhost:8080".to_string();
        let params = HashMap::new();
        assert_eq!(resolve_endpoint(&config, &params).unwrap(), "http://localhost:8080");
    }
}
