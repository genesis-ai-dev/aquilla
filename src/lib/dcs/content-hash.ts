// djb2 content hash — a VERBATIM port of the server's change-detection marker
// at sync-worker/src/events/event-projection.ts:56. The DCS delta engine hashes
// each parsed cell's plain text with this so that "unchanged" (hash-equal)
// cells emit nothing on a re-import, matching the server's own no-op behaviour.
//
// DO NOT change the normalization here without changing the server in lockstep:
// a divergence silently re-emits unchanged cells or, worse, skips changed ones.
//
// 32-bit djb2. Cheap change-detection only — not a cryptographic hash.
export function contentHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}
