import type { AuthHonoEnv } from "../middleware/auth"
import type { Context } from "hono"
import {
  encryptIntegrationToken,
  decryptIntegrationToken,
} from "./integrations/token-crypto"

export const deployment = (c: Context<AuthHonoEnv>) => {
  const worker = c.env.DEPLOYMENT_WORKER_NAME || c.env.ENVIRONMENT || "local"
  // Branch previews share a parent Worker and database, but not enrollment keys.
  // BASE_URL is trusted deployment configuration, never a request header.
  if (!worker.endsWith("-preview")) return worker
  if (!c.env.BASE_URL) throw new Error("Preview enrollment scope is not configured")
  return `${worker}:${new URL(c.env.BASE_URL).origin}`
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
export function base32(bytes: Uint8Array): string {
  let bits = 0,
    value = 0,
    out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabet[(value >>> bits) & 31]
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31]
  return out
}
function decode(secret: string): Uint8Array {
  let bits = 0,
    value = 0
  const bytes: number[] = []
  for (const char of secret) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new Error("Invalid TOTP seed")
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 255)
    }
  }
  return new Uint8Array(bytes)
}
export async function totp(secret: string, step: number): Promise<string> {
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(step))
  const key = await crypto.subtle.importKey(
    "raw",
    decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  )
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter))
  const offset = bytes[19] & 15
  const value = new DataView(bytes.buffer).getUint32(offset) & 0x7fffffff
  return String(value % 1000000).padStart(6, "0")
}
export async function matchingStep(
  secret: string,
  code: string,
  now = Date.now(),
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null
  const current = Math.floor(now / 30000)
  for (const step of [current, current - 1, current + 1])
    if ((await totp(secret, step)) === code) return step
  return null
}
export function keyMaterial(c: Context<AuthHonoEnv>): string {
  const key = c.env.ADMIN_TOTP_KEY
  if (!key || key.length < 32)
    throw new Error("Admin authenticator encryption is not configured")
  return key
}
export const encryptSeed = (c: Context<AuthHonoEnv>, seed: string) =>
  encryptIntegrationToken(
    keyMaterial(c),
    `:admin-totp:${deployment(c)}:${c.get("user").id}`,
    seed,
  )
export const decryptSeed = (c: Context<AuthHonoEnv>, seed: string) =>
  decryptIntegrationToken(
    keyMaterial(c),
    `:admin-totp:${deployment(c)}:${c.get("user").id}`,
    seed,
  )
export interface Factor {
  generation: string
  secret_enc: string
  enabled: boolean
  confirmed_step: number | null
  last_step: number
}
export const factor = (c: Context<AuthHonoEnv>) =>
  c.env.AQUILLA_PG.prepare(
    "SELECT * FROM admin_totp WHERE user_id=? AND deployment=?",
  )
    .bind(c.get("user").id, deployment(c))
    .first<Factor>()
