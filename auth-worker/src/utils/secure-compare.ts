// Constant-time string comparison for shared-secret auth checks (SYNC_SECRET_KEY
// and similar). A plain `!==`/`===` on attacker-controlled input short-circuits
// at the first mismatched byte, which in principle leaks timing information an
// attacker could use to recover the secret byte-by-byte.
//
// Mirrors sync-worker/src/lib/secure-compare.ts — kept per-package since the two
// workers don't share a lib directory.
import { timingSafeEqual } from "node:crypto"

export function secureCompare(a: string, b: string): boolean {
  const aBytes = Buffer.from(a)
  const bBytes = Buffer.from(b)
  if (aBytes.length !== bBytes.length) return false
  return timingSafeEqual(aBytes, bBytes)
}
