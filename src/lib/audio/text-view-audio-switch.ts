// AQU-490: does the audio validation control appear in the TEXT view's gutter?
//
// Sam's ruling: off for every project that already existed when this shipped —
// a team used to a single circle in that gutter should not find a second one
// there one morning — and for a new project, off until it actually has audio,
// at which point it turns itself on.
//
// THE RULE IS DERIVED, NOT WRITTEN, and that is forced rather than chosen.
// Nothing can write the setting at the moment a project gains its first take:
// a settings write needs Maintainer and the recorder is usually a contributor,
// and a projection-side write would race the settings version. So "has audio"
// is answered live, and the stored key only ever records a human's decision.
import type { ProjectRecord } from "@/lib/parsers/types"

/**
 * `showAudioValidationInTextView` ABSENT IS NOT FALSE.
 *
 * Migration 0096 stamped `false` onto every project that existed when audio
 * validation shipped, precisely so that absent could keep a different meaning:
 * "made after this shipped", which resolves to on-once-there-is-audio. Reading
 * absent as false would make the derived half unreachable and every new
 * project would need a manual opt-in nobody would know to give.
 */
export function showAudioValidationInTextView(
  project: Pick<ProjectRecord, "showAudioValidationInTextView"> | null | undefined,
  hasAudio: boolean,
): boolean {
  const stored = project?.showAudioValidationInTextView
  if (typeof stored === "boolean") return stored
  return hasAudio
}
