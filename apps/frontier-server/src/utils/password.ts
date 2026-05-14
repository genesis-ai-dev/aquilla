// Werkzeug-compatible scrypt password hashing + verifier.
//
// MUST stay byte-compatible with the legacy frontier-server's
// `cloudflare/src/utils/password.ts`. The shared frontier-db-v2 stores
// hashes in werkzeug's `scrypt:N:r:p$salt$hex` format; if this worker
// produces a hash the old server can't verify (or vice versa), a user
// registered on one side can't log in via the other.
//
// nodejs_compat (set in wrangler.toml) gives us native `node:crypto`. Pure-JS
// fallback via @noble/hashes keeps unit tests + edge environments working.

import bcrypt from "bcryptjs"
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { scrypt as nobleScrypt } from "@noble/hashes/scrypt"
import {
  bytesToHex as nobleBytesToHex,
  hexToBytes as nobleHexToBytes,
} from "@noble/hashes/utils"

export type WerkzeugScryptParams = {
  N: number
  r: number
  p: number
}

const DEFAULT_SCRYPT_PARAMS: WerkzeugScryptParams = {
  N: 32768,
  r: 8,
  p: 1,
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function base64Url(bytes: Uint8Array): string {
  try {
    const b64 = Buffer.from(bytes).toString("base64")
    return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
  } catch {
    let binary = ""
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    const b64 = btoa(binary)
    return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
  }
}

export function isWerkzeugScryptHash(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith("scrypt:")
}

export function isBcryptHash(stored: string): boolean {
  return typeof stored === "string" && /^\$2[aby]\$/.test(stored)
}

export function parseWerkzeugScryptHash(stored: string): {
  params: WerkzeugScryptParams
  salt: string
  digestHex: string
} {
  if (!isWerkzeugScryptHash(stored)) {
    throw new Error("Not a werkzeug scrypt hash")
  }
  const rest = stored.slice("scrypt:".length)
  const parts = rest.split("$")
  if (parts.length !== 3) {
    throw new Error("Invalid scrypt hash format (expected 3 $-parts)")
  }
  const [paramStr, salt, digestHex] = parts
  const paramParts = paramStr.split(":").map((x) => x.trim())
  if (paramParts.length !== 3) {
    throw new Error("Invalid scrypt params (expected N:r:p)")
  }
  const N = Number(paramParts[0])
  const r = Number(paramParts[1])
  const p = Number(paramParts[2])
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    throw new Error("Invalid scrypt params (non-numeric)")
  }
  if (!salt) throw new Error("Invalid scrypt hash (missing salt)")
  if (!digestHex || digestHex.length % 2 !== 0) {
    throw new Error("Invalid scrypt hash (bad hex digest)")
  }
  return { params: { N, r, p }, salt, digestHex }
}

export async function hashPasswordWerkzeugScrypt(
  password: string,
  params: WerkzeugScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  // 64-byte derived key — matches the legacy data we migrated (128 hex chars).
  const keyLen = 64
  const saltBytes = new Uint8Array(randomBytes(16))
  const salt = base64Url(saltBytes)
  let digestHex: string
  try {
    const dk = scryptSync(password, salt, keyLen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 64 * 1024 * 1024,
    })
    digestHex = dk.toString("hex")
  } catch {
    const dk = nobleScrypt(utf8Bytes(password), utf8Bytes(salt), {
      N: params.N,
      r: params.r,
      p: params.p,
      dkLen: keyLen,
    })
    digestHex = nobleBytesToHex(dk)
  }
  return `scrypt:${params.N}:${params.r}:${params.p}$${salt}$${digestHex}`
}

export async function verifyPasswordWerkzeugScrypt(
  password: string,
  stored: string,
): Promise<boolean> {
  const { params, salt, digestHex } = parseWerkzeugScryptHash(stored)
  let expected: Uint8Array
  try {
    expected = Buffer.from(digestHex, "hex")
  } catch {
    expected = nobleHexToBytes(digestHex)
  }

  let dk: Uint8Array
  try {
    dk = scryptSync(password, salt, expected.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 64 * 1024 * 1024,
    })
  } catch {
    dk = nobleScrypt(utf8Bytes(password), utf8Bytes(salt), {
      N: params.N,
      r: params.r,
      p: params.p,
      dkLen: expected.length,
    })
  }
  return constantTimeEqual(dk, expected)
}

export type PasswordVerificationResult = {
  isValid: boolean
  /** True when the stored hash is bcrypt and should be upgraded to scrypt
   *  after a successful login (matches the legacy server's behaviour). */
  shouldRehashToWerkzeugScrypt: boolean
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<PasswordVerificationResult> {
  if (isWerkzeugScryptHash(stored)) {
    const ok = await verifyPasswordWerkzeugScrypt(password, stored)
    return { isValid: ok, shouldRehashToWerkzeugScrypt: false }
  }
  if (isBcryptHash(stored)) {
    const ok = await bcrypt.compare(password, stored)
    return { isValid: ok, shouldRehashToWerkzeugScrypt: ok }
  }
  throw new Error("Unsupported password hash format")
}
