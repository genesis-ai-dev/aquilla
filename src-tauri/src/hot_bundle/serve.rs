//! The `app://localhost` origin: serves the downloaded bundle when there is one, the embedded
//! assets otherwise, so OPFS/IndexedDB data stays on one origin across every kind of update.

use std::path::{Component, Path, PathBuf};

use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext};
use tauri::utils::config::{Csp, CspDirectiveSources};

use super::HotBundleState;

pub const SCHEME: &str = "app";

pub fn content_type_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// Maps a request path to a bundle-relative file. Anything that does not look like a file
/// (no extension in the last segment) is a client-side route and gets `index.html`; a path
/// that tries to climb out of the bundle gets `index.html` too rather than an error page.
pub fn resolve_request_path(path: &str) -> PathBuf {
    let decoded = percent_decode(path.trim_start_matches('/'));
    let mut clean = PathBuf::new();
    for component in Path::new(&decoded).components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return PathBuf::from("index.html"),
        }
    }
    let is_file = clean
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && !ext.is_empty()));
    if clean.as_os_str().is_empty() || !is_file {
        PathBuf::from("index.html")
    } else {
        clean
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `'sha256-…'` sources for every inline `<script>` in `html`. Tauri computes these at build
/// time for the embedded index.html; a downloaded one needs them computed when served or the
/// CSP's `script-src 'self'` blocks Vite's inline bootstrap script.
pub fn inline_script_hashes(html: &str) -> Vec<String> {
    let mut hashes = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(start) = lower[cursor..].find("<script") {
        let tag_start = cursor + start;
        let Some(tag_end_rel) = lower[tag_start..].find('>') else { break };
        let tag_end = tag_start + tag_end_rel + 1;
        let Some(close_rel) = lower[tag_end..].find("</script>") else { break };
        let body_end = tag_end + close_rel;
        let open_tag = &lower[tag_start..tag_end];
        if !open_tag.contains("src=") {
            let digest = Sha256::digest(&html.as_bytes()[tag_end..body_end]);
            hashes.push(format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(digest)));
        }
        cursor = body_end + "</script>".len();
    }
    hashes
}

/// The configured CSP with inline-script hashes appended to `script-src`.
pub fn csp_header_for(csp: &Csp, script_hashes: &[String]) -> String {
    if script_hashes.is_empty() {
        return csp.to_string();
    }
    match csp {
        Csp::Policy(policy) => {
            let mut directives: Vec<String> = policy
                .split(';')
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(|d| {
                    if d.starts_with("script-src") {
                        format!("{d} {}", script_hashes.join(" "))
                    } else {
                        d.to_string()
                    }
                })
                .collect();
            if !directives.iter().any(|d| d.starts_with("script-src")) {
                directives.push(format!("script-src {}", script_hashes.join(" ")));
            }
            directives.join("; ")
        }
        Csp::DirectiveMap(map) => {
            let mut map = map.clone();
            let entry = map
                .entry("script-src".to_string())
                .or_insert_with(|| CspDirectiveSources::List(Vec::new()));
            match entry {
                CspDirectiveSources::Inline(s) => {
                    s.push(' ');
                    s.push_str(&script_hashes.join(" "));
                }
                CspDirectiveSources::List(list) => list.extend(script_hashes.iter().cloned()),
            }
            Csp::DirectiveMap(map).to_string()
        }
    }
}

type Response = http::Response<Vec<u8>>;

/// Builder hook: `register_uri_scheme_protocol(SCHEME, serve_request)`.
pub fn serve_request<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: http::Request<Vec<u8>>) -> Response {
    let app = ctx.app_handle();
    let path = request.uri().path().to_string();
    let bundle_dir = app
        .try_state::<HotBundleState>()
        .and_then(|state| state.serve_root.read().ok().and_then(|r| r.clone()));
    match bundle_dir {
        Some(dir) => serve_from_dir(app, &dir, &path),
        None => serve_embedded(app, &path),
    }
}

fn serve_from_dir<R: Runtime>(app: &AppHandle<R>, dir: &Path, request_path: &str) -> Response {
    let mut relative = resolve_request_path(request_path);
    let mut file = dir.join(&relative);
    if !file.is_file() {
        relative = PathBuf::from("index.html");
        file = dir.join(&relative);
    }
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(err) => {
            log::error!("[hot_bundle] cannot read {}: {err}", file.display());
            return plain(http::StatusCode::NOT_FOUND, "not found");
        }
    };
    let relative_str = relative.to_string_lossy();
    let mut response = http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, content_type_for(&relative_str));
    if relative_str.ends_with(".html") {
        if let Some(csp) = app.config().app.security.csp.as_ref() {
            let hashes = inline_script_hashes(&String::from_utf8_lossy(&bytes));
            response = response.header(http::header::CONTENT_SECURITY_POLICY, csp_header_for(csp, &hashes));
        }
    }
    response
        .body(bytes)
        .unwrap_or_else(|_| plain(http::StatusCode::INTERNAL_SERVER_ERROR, "bad response"))
}

/// Tauri's resolver already does the SPA fallback to `index.html` and injects the CSP.
fn serve_embedded<R: Runtime>(app: &AppHandle<R>, request_path: &str) -> Response {
    let resolver = app.asset_resolver();
    let asset = resolver
        .get(request_path.to_string())
        .or_else(|| resolver.get("/index.html".to_string()));
    let Some(asset) = asset else {
        return plain(http::StatusCode::NOT_FOUND, "not found");
    };
    let mut response = http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, asset.mime_type.as_str());
    if let Some(csp) = asset.csp_header.as_deref() {
        response = response.header(http::header::CONTENT_SECURITY_POLICY, csp);
    }
    response
        .body(asset.bytes)
        .unwrap_or_else(|_| plain(http::StatusCode::INTERNAL_SERVER_ERROR, "bad response"))
}

fn plain(status: http::StatusCode, body: &str) -> Response {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body.as_bytes().to_vec())
        .expect("static response is well-formed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_cover_every_asset_kind_vite_emits() {
        assert_eq!(content_type_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_for("assets/a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("a.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("a.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("a.json"), "application/json; charset=utf-8");
        // The browser refuses to instantiate WASM served as anything else.
        assert_eq!(content_type_for("sqlite.wasm"), "application/wasm");
        assert_eq!(content_type_for("a.svg"), "image/svg+xml");
        assert_eq!(content_type_for("a.PNG"), "image/png");
        assert_eq!(content_type_for("a.woff2"), "font/woff2");
        assert_eq!(content_type_for("site.webmanifest"), "application/manifest+json");
        assert_eq!(content_type_for("a.mp3"), "audio/mpeg");
        assert_eq!(content_type_for("a.webm"), "video/webm");
        assert_eq!(content_type_for("a.unknown"), "application/octet-stream");
    }

    #[test]
    fn routes_without_an_extension_fall_back_to_index_html() {
        assert_eq!(resolve_request_path("/"), PathBuf::from("index.html"));
        assert_eq!(resolve_request_path(""), PathBuf::from("index.html"));
        assert_eq!(resolve_request_path("/project/abc/editor"), PathBuf::from("index.html"));
        assert_eq!(resolve_request_path("/assets/index-abc.js"), PathBuf::from("assets/index-abc.js"));
        assert_eq!(resolve_request_path("/assets/a%20b.css"), PathBuf::from("assets/a b.css"));
        // Dotfiles and bare dots are routes, not files.
        assert_eq!(resolve_request_path("/.well-known"), PathBuf::from("index.html"));
        // Traversal never leaves the bundle.
        assert_eq!(resolve_request_path("/../../etc/passwd"), PathBuf::from("index.html"));
        assert_eq!(resolve_request_path("/assets/../../x.js"), PathBuf::from("index.html"));
    }

    #[test]
    fn inline_scripts_are_hashed_and_external_ones_are_not() {
        let html = r#"<html><head><script>window.x=1</script><script type="module" src="/a.js"></script></head></html>"#;
        let hashes = inline_script_hashes(html);
        let expected = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(b"window.x=1"));
        assert_eq!(hashes, vec![format!("'sha256-{expected}'")]);
        assert!(inline_script_hashes("<html></html>").is_empty());
    }

    #[test]
    fn csp_header_appends_hashes_to_script_src() {
        let policy = Csp::Policy("default-src 'self'; script-src 'self'".into());
        let header = csp_header_for(&policy, &["'sha256-abc'".to_string()]);
        assert_eq!(header, "default-src 'self'; script-src 'self' 'sha256-abc'");
        assert_eq!(csp_header_for(&policy, &[]), "default-src 'self'; script-src 'self'");

        let mut map = std::collections::HashMap::new();
        map.insert("script-src".to_string(), CspDirectiveSources::Inline("'self'".into()));
        let header = csp_header_for(&Csp::DirectiveMap(map), &["'sha256-abc'".to_string()]);
        assert!(header.contains("script-src 'self' 'sha256-abc'"), "{header}");
    }
}
