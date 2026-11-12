// Keep internal ids out of delivered export filenames. (AQU-1461, 2026-10-01)
//
// Jade exported audio and got back files carrying "a long string of
// a89dec11-d60e-48c1-…". Every segment of an audio export filename is supposed
// to be something a person reads — the file's name, the language code, the line
// number, the character, the track — and an id is none of those. It also makes
// the file unusable for the job the export exists for: a director cannot say
// "re-record a89dec11" to anybody.
//
// WHY A GUARD RATHER THAN A FIX AT ONE SITE. Three segments can be fed a name
// that came from somewhere we don't control — the file's display name, a cast
// voice's name, a track's name — and all three are free text written by
// imports, other clients and the Agent API as well as by our own UI. The
// reporter's repro was never captured (the ticket is titled `[needs-repro]`), so
// closing only the segment we guessed at would leave the other two open. This
// strips ids wherever a name becomes a filename segment, which is cheap, and
// leaves the readable part of the name intact.
//
// NOT A SANITISER. `characterKey` still does the character-class work; this only
// removes id-shaped runs, and a name with no id in it comes back byte-identical
// — which is what keeps every export that already produced readable names
// unchanged.

/**
 * A UUID in any version, which is the shape every internal id we mint has:
 * `newVoiceId()` (voices.ts) and the server's file/cell/project ids alike.
 *
 * Deliberately matched ANYWHERE in the value rather than anchored, because the
 * symptom Jade reported was a long name with an id inside it, and the ticket
 * names "a file whose display name is (or contains) an id" as the first
 * candidate.
 */
const UUID_RUN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Separator runs left behind once an id is cut out of the middle of a name. */
const SEPARATOR_RUN = /[-_\s.]{2,}/g

/**
 * The readable part of `value`, with every id-shaped run removed.
 *
 * Returns `""` when the value was nothing but an id — callers decide what to put
 * there instead, because the right answer differs per segment (no stem at all
 * for the file segment; `NO_CHARACTER` for a character; `unnamed` for a track).
 */
export function stripInternalIds(value: string): string {
  if (!UUID_RUN.test(value)) {
    // `test` advances `lastIndex` on a global regex; reset so the next call
    // starts from the beginning. (The early return below is why this matters:
    // a hit and a miss must not depend on call order.)
    UUID_RUN.lastIndex = 0
    return value
  }
  UUID_RUN.lastIndex = 0
  return value
    .replace(UUID_RUN, "")
    .replace(SEPARATOR_RUN, "_")
    .replace(/^[-_\s.]+|[-_\s.]+$/g, "")
}

/** True when `value` is an id and nothing else a person would read. */
export function isInternalIdName(value: string): boolean {
  return value.trim() !== "" && stripInternalIds(value).trim() === ""
}
