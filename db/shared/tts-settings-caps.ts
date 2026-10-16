// The ceiling on a project's TTS settings (AQU-1943).
//
// Nothing bounded the project settings blob before this. One production
// project's `ttsSettings` reached 5.45 MB — 31,287 voices and 36,860 cast
// assignments, one voice minted per verse label by an old Codex migration
// (AQU-1942) — and that blob is read by every member on every workspace open
// and every window focus, which is what killed the Voices panel (AQU-1940).
// AQU-1941 prunes the known damage; this is the door, so no writer of the
// voice library (file imports, spreadsheet cast import, diarization,
// clone-voice, the settings form, agents) can ever put a project back there.
//
// The ceiling is deliberately far above any real cast — a dubbing project
// casts tens of voices, not thousands — so it refuses runaway machine writes
// without ever being a limit a producer can reach by hand.
//
// PURE + dependency-free, like its neighbours in this folder, so both workers
// and the SPA can import it.

/** Most voices a project's library may hold. */
export const MAX_TTS_VOICES = 2_000

/** Most cell→voice entries `castAssignments` may hold. */
export const MAX_TTS_CAST_ASSIGNMENTS = 100_000

/** Largest serialized `ttsSettings` value, in bytes. */
export const MAX_TTS_SETTINGS_BYTES = 1_048_576

export interface TtsSettingsSize {
  voices: number
  assignments: number
  bytes: number
}

/**
 * Bytes this value serializes to. A value that cannot be serialized measures
 * as 0: it cannot be stored either, and that refusal belongs to the caller's
 * own shape check, not to the cap.
 */
function serializedBytes(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value) ?? '')
  } catch {
    return 0
  }
}

function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  // Every runtime we ship on has TextEncoder; counting the code units is a
  // last-resort floor so a measurement never throws.
  return text.length
}

/**
 * Count what the cap is about. A non-object (or absent) value measures as
 * empty: it carries no library, and its shape is somebody else's refusal.
 */
export function measureTtsSettings(value: unknown): TtsSettingsSize {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { voices: 0, assignments: 0, bytes: 0 }
  }
  const settings = value as { voices?: unknown; castAssignments?: unknown }
  const voices = Array.isArray(settings.voices) ? settings.voices.length : 0
  const assignments =
    typeof settings.castAssignments === 'object'
      && settings.castAssignments !== null
      && !Array.isArray(settings.castAssignments)
      ? Object.keys(settings.castAssignments as Record<string, unknown>).length
      : 0
  return { voices, assignments, bytes: serializedBytes(value) }
}

/**
 * Why this TTS settings value is over the cap, or null when it fits. The
 * message names the limit AND the actual count, because the person reading it
 * in a toast has to know how far over they are to act on it.
 */
export function ttsSettingsCapMessage(size: TtsSettingsSize): string | null {
  if (size.voices > MAX_TTS_VOICES) {
    return `ttsSettings.voices holds ${size.voices} voices, over the limit of ${MAX_TTS_VOICES}. `
      + 'Remove voices from the project\'s voice library and save again.'
  }
  if (size.assignments > MAX_TTS_CAST_ASSIGNMENTS) {
    return `ttsSettings.castAssignments holds ${size.assignments} entries, over the limit of `
      + `${MAX_TTS_CAST_ASSIGNMENTS}. Remove cast assignments and save again.`
  }
  if (size.bytes > MAX_TTS_SETTINGS_BYTES) {
    return `ttsSettings is ${size.bytes} bytes, over the limit of ${MAX_TTS_SETTINGS_BYTES}. `
      + 'Remove voices or cast assignments and save again.'
  }
  return null
}

/** Measure and judge in one step. Null means the value fits. */
export function ttsSettingsCapProblem(
  value: unknown,
): { message: string; size: TtsSettingsSize } | null {
  const size = measureTtsSettings(value)
  const message = ttsSettingsCapMessage(size)
  return message ? { message, size } : null
}
