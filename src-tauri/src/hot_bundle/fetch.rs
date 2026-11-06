//! Network side of the hot bundle channel: the manifest GET and the tarball download.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use super::manifest::Manifest;

/// Same reasoning as `app_update.rs`: an unbounded fetch would hold the in-flight lock and
/// block every later check.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Measured between chunks, so a slow-but-moving download on a bad hotel connection still
/// finishes while a dead one is abandoned.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Anything larger than this is not a web bundle; refuse before filling the disk.
const MAX_BUNDLE_BYTES: u64 = 512 * 1024 * 1024;

pub async fn fetch_manifest(url: &str) -> Result<Manifest, String> {
    let client = reqwest::Client::builder()
        .timeout(MANIFEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|e| format!("manifest fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("manifest fetch failed: {e}"))?;
    response
        .json::<Manifest>()
        .await
        .map_err(|e| format!("manifest is not valid JSON: {e}"))
}

/// Streams `url` into `dest`, giving up when no chunk arrives for `DOWNLOAD_STALL_TIMEOUT`.
/// The byte count is checked against the manifest; the sha256 is the caller's job.
pub async fn download_to_file(url: &str, dest: &Path, expected_size: u64) -> Result<(), String> {
    if expected_size > MAX_BUNDLE_BYTES {
        return Err(format!("manifest declares {expected_size} bytes; refusing to download"));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("bundle download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("bundle download failed: {e}"))?;
    let mut file = std::fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut written: u64 = 0;
    loop {
        let chunk = tokio::time::timeout(DOWNLOAD_STALL_TIMEOUT, response.chunk())
            .await
            .map_err(|_| format!("bundle download stalled for {}s", DOWNLOAD_STALL_TIMEOUT.as_secs()))?
            .map_err(|e| format!("bundle download failed: {e}"))?;
        let Some(chunk) = chunk else { break };
        written += chunk.len() as u64;
        if written > expected_size {
            return Err(format!("bundle is larger than the manifest's {expected_size} bytes"));
        }
        file.write_all(&chunk).map_err(|e| format!("write {}: {e}", dest.display()))?;
    }
    file.flush().map_err(|e| e.to_string())?;
    if written != expected_size {
        return Err(format!("bundle is {written} bytes, manifest says {expected_size}"));
    }
    Ok(())
}
