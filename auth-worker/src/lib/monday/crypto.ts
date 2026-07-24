// AES-GCM encryption for Monday OAuth access tokens (WebCrypto).
//
// Storage format: base64(iv || ciphertext), 12-byte random IV per encryption.
// Key derivation: SHA-256(SECRET_KEY + ":monday-token") — deterministic from
// the worker's existing JWT secret, so no new secret to provision, and the
// ":monday-token" domain separator means a leak of a derived key never equals
// the JWT signing key.

const KEY_CONTEXT = ":monday-token"

async function deriveKey(secretKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secretKey + KEY_CONTEXT),
  )
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ])
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encrypt a Monday access token for storage → base64(iv || ciphertext). */
export async function encryptMondayToken(
  secretKey: string,
  plaintext: string,
): Promise<string> {
  const key = await deriveKey(secretKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  const out = new Uint8Array(iv.length + ciphertext.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ciphertext), iv.length)
  return toBase64(out)
}

// ── OAuth 2.1 PKCE helpers ─────────────────────────────────────────────────

const VERIFIER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

/** RFC 7636 code_verifier: 43–128 chars from the unreserved set. */
export function generateCodeVerifier(length = 64): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ""
  for (const b of bytes) out += VERIFIER_CHARS[b % VERIFIER_CHARS.length]
  return out
}

/** RFC 7636 S256 code_challenge: base64url(SHA-256(verifier)), no padding. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )
  return toBase64(new Uint8Array(digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** Decrypt a stored token. Throws on tamper/garbage (AES-GCM auth failure). */
export async function decryptMondayToken(
  secretKey: string,
  encoded: string,
): Promise<string> {
  const bytes = fromBase64(encoded)
  if (bytes.length <= 12) throw new Error("monday token ciphertext too short")
  const key = await deriveKey(secretKey)
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  )
  return new TextDecoder().decode(plaintext)
}
