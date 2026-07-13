// Minimal dependency-free UUIDv7 generator (RFC 9562 §5.7). sync-worker has no
// `uuid` package (unlike the SPA, which imports `uuid`'s v7); the changeset
// engine mints server-side event ids here. UUIDv7 is time-ordered, matching the
// outbox's client id convention, but event ordering is authoritative via
// server_seq — the id only needs to be unique.
export function uuidv7(): string {
  const ts = Date.now()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // 48-bit big-endian millisecond timestamp.
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff
  bytes[5] = ts & 0xff

  // Version 7 in the high nibble of byte 6; RFC variant in the top bits of byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
