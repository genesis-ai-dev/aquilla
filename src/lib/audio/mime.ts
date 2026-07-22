/**
 * Map an audio file extension to the MIME type playback must stamp on Blobs.
 *
 * WHY: object-URL playback (`new Audio(URL.createObjectURL(blob))`) works in
 * Chromium regardless of the Blob type because Chromium sniffs the bytes, but
 * Safari and Firefox trust the declared type. A typeless Blob — or worse, mp3
 * bytes labeled "audio/wav" — fails there with a bare `onerror` ("Audio failed
 * to load"). Always derive the type from the extension stored in the
 * frontier-audio:// URL.
 */
export function audioMimeForExt(ext: string): string {
  const clean = ext.replace(/^\./, "").toLowerCase()
  switch (clean) {
    case "wav": return "audio/wav"
    case "mp3": return "audio/mpeg"
    case "m4a":
    case "mp4": return "audio/mp4"
    case "aac": return "audio/aac"
    case "flac": return "audio/flac"
    case "ogg":
    case "oga":
    case "opus": return "audio/ogg"
    case "webm": return "audio/webm"
    // Unknown: prefer audio/mpeg — never audio/wav, which Safari enforces
    // against non-RIFF bytes. Chromium ignores this and sniffs either way.
    default: return "audio/mpeg"
  }
}
