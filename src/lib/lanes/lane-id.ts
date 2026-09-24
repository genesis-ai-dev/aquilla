// AQU-1240: opaque 8-hex lane ids. 32 bits of CSPRNG rendered as 8 lowercase
// hex chars. Independent of the lane's name/language (nothing to reverse) and
// non-consecutive. Uniqueness is per-project (composite PK); the caller relies
// on the natural-key ON CONFLICT so re-runs keep an existing lane's id.
export function newLaneId(): string {
  const b = new Uint8Array(4)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
