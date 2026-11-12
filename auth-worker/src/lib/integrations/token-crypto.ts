// AES-GCM encryption for integration tokens at rest (WebCrypto): Monday's
// OAuth tokens and Airtable's personal access tokens (AQU-804).
//
// Storage format: base64(iv || ciphertext), 12-byte random IV per encryption.
// Key derivation: SHA-256(<key material> + <context>), one context string per
// provider (":monday-token", ":airtable-token"), so a key derived for one
// provider never decrypts another's tokens and none equals the JWT signing key.

import type { Env } from "../../types"

/**
 * The key material integration tokens are encrypted under on this deployment:
 * MONDAY_TOKEN_KEY when set, else SECRET_KEY. The secret is named for Monday,
 * the first integration (AQU-1775): production and development share
 * SECRET_KEY and the dev Neon branch is restored from production, so the dev
 * worker sets MONDAY_TOKEN_KEY to make copied production tokens unreadable
 * there. Airtable's tokens derive from the same material, so the one secret
 * covers both.
 */
export function integrationTokenKeyMaterial(
  env: Pick<Env, "SECRET_KEY" | "MONDAY_TOKEN_KEY">,
): string {
  return env.MONDAY_TOKEN_KEY?.trim() || env.SECRET_KEY
}

async function deriveKey(secretKey: string, context: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secretKey + context),
  )
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ])
}

export function toBase64(bytes: Uint8Array): string {
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

/** Encrypt a token for storage → base64(iv || ciphertext). */
export async function encryptIntegrationToken(
  secretKey: string,
  context: string,
  plaintext: string,
): Promise<string> {
  const key = await deriveKey(secretKey, context)
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

/** Decrypt a stored token. Throws on tamper/garbage (AES-GCM auth failure). */
export async function decryptIntegrationToken(
  secretKey: string,
  context: string,
  encoded: string,
): Promise<string> {
  const bytes = fromBase64(encoded)
  if (bytes.length <= 12) throw new Error("token ciphertext too short")
  const key = await deriveKey(secretKey, context)
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  )
  return new TextDecoder().decode(plaintext)
}
