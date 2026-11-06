// SHA-256 for the Paratext bridge. One algorithm everywhere (browser, Workers,
// Tauri webview, Postgres) so every runtime agrees on a unit's identity.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))

export function toHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]]
  return out
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer
  const digest = await crypto.subtle.digest("SHA-256", buf as ArrayBuffer)
  return toHex(new Uint8Array(digest))
}

const encoder = new TextEncoder()

export function sha256TextHex(text: string): Promise<string> {
  return sha256Hex(encoder.encode(text))
}

/** Hash of a sorted list of `(name, hash)` pairs plus a settings hash — the
 *  snapshot hash of a whole project folder. Order-independent by construction. */
export function snapshotHash(files: Iterable<{ fileName: string; blobHash: string }>, settingsHash: string): Promise<string> {
  const lines = Array.from(files)
    .map((f) => `${f.fileName}\t${f.blobHash}`)
    .sort()
  lines.push(`Settings.xml\t${settingsHash}`)
  return sha256TextHex(lines.join("\n"))
}
