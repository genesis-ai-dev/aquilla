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

// ── The accepted-format list, in ONE place (AQU-1922) ───────────────────────
//
// Three call sites used to keep their own copy of "which audio files may be
// imported": the one-file cell upload (`attach-file.ts`), bulk recordings
// upload (`bulk-upload/match.ts`), and each picker's `accept` string. They had
// already drifted — the one-file picker's `accept` named 4 of the 10 supported
// extensions, so a FLAC/Opus/AAC/WebM pick off a phone's Files app (where the
// OS reports an empty or wrong MIME type, the very case the extension list
// exists for) could not be chosen at all, even though the validator and the
// whole decode/playback path accept it. Derive, never re-type.
//
// The list is exactly the set `audioMimeForExt` above maps explicitly: an
// extension it has to guess for is one playback cannot label honestly, so the
// two MUST stay in step. `mime.test.ts` fails if they part ways.

/** Every extension the audio import path accepts, and playback can label. */
export const AUDIO_FILE_EXTS = [
  "wav", "mp3", "m4a", "mp4", "aac", "ogg", "oga", "opus", "webm", "flac",
] as const

export const AUDIO_FILE_EXT_SET: ReadonlySet<string> = new Set<string>(AUDIO_FILE_EXTS)

/**
 * Extensions a browser cannot decode, so a take made from one would sit on its
 * line and never play. Refused UP FRONT rather than uploaded: these declare a
 * real `audio/*` MIME type (`audio/x-ms-wma`, `audio/aiff`), so a check that
 * trusts the declared type alone waves them straight through.
 */
export const UNPLAYABLE_AUDIO_EXTS: ReadonlySet<string> = new Set<string>([
  "wma", "aif", "aiff", "amr", "3gp", "caf",
])

/** `accept` for an audio `<input type="file">`. `audio/*` alone is not enough:
 *  some mobile browsers report an empty or wrong MIME type for files off the
 *  camera roll / Files app, so every extension is listed too. */
export const AUDIO_FILE_ACCEPT =
  ["audio/*", ...AUDIO_FILE_EXTS.map((ext) => `.${ext}`)].join(",")

/** The formats to NAME to a person, container aliases folded in (`.mp4` is the
 *  same container as `.m4a`; `.oga`/`.opus` are Ogg). Prose, not a parser
 *  input — the machine-readable list is `AUDIO_FILE_EXTS`. */
export const AUDIO_FORMATS_LABEL =
  ".wav, .mp3, .m4a, .aac, .ogg, .opus, .flac or .webm"
