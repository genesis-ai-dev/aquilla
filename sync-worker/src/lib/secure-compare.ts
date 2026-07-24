// Constant-time string comparison for shared-secret auth checks (SYNC_SECRET_KEY,
// DIARIZATION_SHARED_SECRET, …). A plain `!==`/`===` on attacker-controlled input
// short-circuits at the first mismatched byte, which in principle leaks timing
// information an attacker could use to recover the secret byte-by-byte.
//
// Previously duplicated ad hoc in admin.ts and diarization.ts (both already
// used this exact pattern for their own secret checks) — centralised here so
// every shared-secret comparison in the worker gets it, not just the two
// routes someone happened to think of it for.
import { timingSafeEqual } from "node:crypto"

export function secureCompare(a: string, b: string): boolean {
  const aBytes = Buffer.from(a)
  const bBytes = Buffer.from(b)
  if (aBytes.length !== bBytes.length) return false
  return timingSafeEqual(aBytes, bBytes)
}
