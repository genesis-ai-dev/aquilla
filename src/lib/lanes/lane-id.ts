// AQU-1240: opaque 8-hex lane ids. 32 bits of CSPRNG rendered as 8 lowercase
// hex chars. Independent of the lane's name/language (nothing to reverse) and
// non-consecutive. Globally unique (uq_lanes_id, AQU-1606); an insert that
// hits that index retries with a new id. The primary key stays
// (project_id, id). Re-runs keep an existing lane's id via ON CONFLICT on
// the natural key, which does not write id.
export function newLaneId(): string {
  const b = new Uint8Array(4)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** True when `value` is the opaque id shape {@link newLaneId} mints. A language never is. */
export function isLaneId(value: string): boolean {
  return /^[0-9a-f]{8}$/.test(value)
}
