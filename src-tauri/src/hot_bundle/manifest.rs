//! The hot-bundle manifest (`latest.json`) and the two gates every manifest must pass
//! before the shell downloads anything: the ed25519 signature and the shell-version floor.
//!
//! No Tauri types here so the whole file is `cargo test`-able.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub sha: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub min_shell_version: String,
    pub created_at: String,
    pub signature: String,
}

impl Manifest {
    /// Fields joined by `\n`, no trailing newline — must match
    /// `scripts/desktop-bundle-publish.ts` byte for byte or every signature fails.
    pub fn signing_string(&self) -> String {
        [
            self.schema.to_string(),
            self.version.clone(),
            self.sha.clone(),
            self.url.clone(),
            self.sha256.clone(),
            self.size.to_string(),
            self.min_shell_version.clone(),
            self.created_at.clone(),
        ]
        .join("\n")
    }

    pub fn verify_signature(&self, public_key_hex: &str) -> Result<(), String> {
        let key_bytes = hex::decode(public_key_hex.trim()).map_err(|e| format!("bad public key hex: {e}"))?;
        let key_bytes: [u8; 32] = key_bytes
            .try_into()
            .map_err(|_| "public key must be 32 bytes".to_string())?;
        let key = VerifyingKey::from_bytes(&key_bytes).map_err(|e| format!("bad public key: {e}"))?;
        let sig_bytes = base64::engine::general_purpose::STANDARD
            .decode(self.signature.trim())
            .map_err(|e| format!("bad signature base64: {e}"))?;
        let signature = Signature::from_slice(&sig_bytes).map_err(|e| format!("bad signature: {e}"))?;
        key.verify(self.signing_string().as_bytes(), &signature)
            .map_err(|_| "manifest signature does not verify".to_string())
    }
}

/// `Ok(())` when this shell is new enough; `Err(required)` when the SPA must nudge the user to
/// the shell updater instead. A malformed floor fails closed — better to skip one bundle than
/// to load a client that expects IPC commands this shell does not have.
pub fn shell_meets_floor(shell_version: &str, min_shell_version: &str) -> Result<(), String> {
    let shell = semver::Version::parse(shell_version)
        .map_err(|e| format!("shell version {shell_version:?} is not semver: {e}"))?;
    let floor = semver::Version::parse(min_shell_version)
        .map_err(|e| format!("minShellVersion {min_shell_version:?} is not semver: {e}"))?;
    if shell >= floor {
        Ok(())
    } else {
        Err(min_shell_version.to_string())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub(crate) fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    pub(crate) fn signed_manifest(key: &SigningKey) -> Manifest {
        let mut m = Manifest {
            schema: 1,
            version: "2026.11.05.03".into(),
            sha: "abc123".into(),
            url: "https://example.test/production/2026.11.05.03/bundle.tar.gz".into(),
            sha256: "00".repeat(32),
            size: 42,
            min_shell_version: "0.2.0".into(),
            created_at: "2026-11-05T19:00:00Z".into(),
            signature: String::new(),
        };
        let sig = key.sign(m.signing_string().as_bytes());
        m.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
        m
    }

    pub(crate) fn pubkey_hex(key: &SigningKey) -> String {
        hex::encode(key.verifying_key().to_bytes())
    }

    #[test]
    fn signing_string_matches_the_documented_field_order() {
        let m = signed_manifest(&test_key());
        assert_eq!(
            m.signing_string(),
            format!(
                "1\n2026.11.05.03\nabc123\n{}\n{}\n42\n0.2.0\n2026-11-05T19:00:00Z",
                m.url, m.sha256
            )
        );
    }

    #[test]
    fn a_valid_signature_verifies_and_a_tampered_field_does_not() {
        let key = test_key();
        let m = signed_manifest(&key);
        assert_eq!(m.verify_signature(&pubkey_hex(&key)), Ok(()));

        // Changing the download URL is the attack that matters: a verified manifest must
        // not be redirectable to a different tarball.
        let mut tampered = m.clone();
        tampered.url = "https://evil.test/bundle.tar.gz".into();
        assert!(tampered.verify_signature(&pubkey_hex(&key)).is_err());

        let other = SigningKey::from_bytes(&[9u8; 32]);
        assert!(m.verify_signature(&pubkey_hex(&other)).is_err());
        assert!(m.verify_signature("not-hex").is_err());
    }

    #[test]
    fn shell_floor_is_inclusive_and_fails_closed_on_garbage() {
        assert_eq!(shell_meets_floor("0.2.0", "0.2.0"), Ok(()));
        assert_eq!(shell_meets_floor("0.3.1", "0.2.0"), Ok(()));
        assert_eq!(shell_meets_floor("0.1.9", "0.2.0"), Err("0.2.0".into()));
        assert!(shell_meets_floor("0.2.0", "latest").is_err());
    }
}
