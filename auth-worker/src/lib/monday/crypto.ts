// AES-GCM encryption for Monday OAuth access tokens (WebCrypto; the cipher
// itself is lib/integrations/token-crypto.ts, shared with Airtable — AQU-804).
//
// Storage format: base64(iv || ciphertext), 12-byte random IV per encryption.
// Key derivation: SHA-256(<key material> + ":monday-token"), where the key
// material is MONDAY_TOKEN_KEY when set and SECRET_KEY otherwise
// (mondayTokenKeyMaterial). The SECRET_KEY default means no new secret to
// provision, and the ":monday-token" domain separator means a leak of a
// derived key never equals the JWT signing key.
//
// AQU-1775: production and development share SECRET_KEY, and the dev Neon
// branch is restored from production, so under the default derivation dev
// could read every production org's copied Monday tokens. The dev worker sets
// MONDAY_TOKEN_KEY so its Monday key is one no other deployment holds.

import type { Env } from "../../types"
import {
  decryptIntegrationToken,
  encryptIntegrationToken,
  integrationTokenKeyMaterial,
  toBase64,
} from "../integrations/token-crypto"

const KEY_CONTEXT = ":monday-token"

/**
 * The key material Monday tokens are encrypted under on this deployment:
 * MONDAY_TOKEN_KEY when set, else SECRET_KEY. Every encrypt and decrypt of a
 * Monday token goes through this, so the two can never disagree.
 */
export function mondayTokenKeyMaterial(
  env: Pick<Env, "SECRET_KEY" | "MONDAY_TOKEN_KEY">,
): string {
  return integrationTokenKeyMaterial(env)
}

/** Encrypt a Monday access token for storage → base64(iv || ciphertext). */
export async function encryptMondayToken(
  secretKey: string,
  plaintext: string,
): Promise<string> {
  return encryptIntegrationToken(secretKey, KEY_CONTEXT, plaintext)
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
  return decryptIntegrationToken(secretKey, KEY_CONTEXT, encoded)
}
