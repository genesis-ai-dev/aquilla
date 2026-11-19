/**
 * AQU-2551 re-review finding 9: where a PDF's header ("%PDF-") is taken, the
 * one rule for the app's import and the server's Knowledge Base check.
 *
 * As pdf.js takes it: anywhere in the first kilobyte, at the start (after at
 * most a byte-order mark or whitespace) or right after a line break. A .pdf
 * with a junk line before its header reads in the browser, so the server must
 * not refuse it; a text file that only mentions "%PDF-" mid-line is not a PDF.
 *
 * Runtime-neutral, so the app and the auth worker share it.
 */
const SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
const HEAD_BYTES = 1024
const BLANK = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])

export function hasPdfHeader(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, HEAD_BYTES) - SIGNATURE.length
  let leading = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  while (leading < bytes.length && BLANK.has(bytes[leading])) leading++
  for (let i = 0; i <= end; i++) {
    if (i !== leading && bytes[i - 1] !== 0x0a && bytes[i - 1] !== 0x0d) continue
    if (SIGNATURE.every((byte, k) => bytes[i + k] === byte)) return true
  }
  return false
}
