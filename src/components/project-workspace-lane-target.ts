// AQU-602: resolve the editor's active target language from the active lane.
//
// The lanes model (AQU-538) is "one source, N target lanes"; a non-default
// lane has its own target language, while the default lane (`''`) uses the
// project's `targetLanguage`. Switching lanes must therefore switch the target
// language the editor reads/writes/translates into — not just the cell filter.
//
// AQU-1586: that language comes from the lane ROW, never from the lane's tag.
// The tag is the event key (`target_lang`), and `planNewTargetLane` sets it to
// the opaque lane id whenever the language string is taken by a sibling or
// matches the project default — so reading the tag as the language drafted a
// second Spanish lane "into a3f09c1e". `laneLanguageForTag` owns that rule.
//
// AQU-583: the default lane is driven SOLELY by the PROJECT target, never by a
// per-file one. A file's `targetLanguage` is only ever an import-time snapshot
// (or an inference seed — AQU-249); there is no UI to set a deliberate per-file
// target on the default lane. Consulting it caused two bugs: a stamped value
// shadowed a later Settings change (the pill stayed stale with >1 import), and a
// stamped value (e.g. "English") surfaced when the project had NO target set,
// hiding the "Set target language" prompt. So the project target is the single
// source of truth: when it is unset the default lane has no target (the prompt
// shows), regardless of how many files were imported or what they carry.
// `fileTargetLanguage` is retained in the signature but intentionally unused.
//
// This pure helper isolates that rule from the heavyweight ProjectWorkspace
// component so it can be unit-tested without a harness, mirroring
// `project-workspace-lane-deeplink.ts`.

import { laneLanguageForTag, type LaneLanguageRow } from "@/lib/lanes/lane-language"

/**
 * The target language for the currently active lane.
 *
 * - A non-default lane (`activeLane` truthy) → the language recorded on that
 *   lane's row (AQU-1586). Without rows (a server that predates AQU-1418) the
 *   tag is the only thing available and is used as before. A lane whose row
 *   records no language of its own inherits the project's `targetLanguage`,
 *   exactly as the default lane does — never an empty string, and never the
 *   lane's own id.
 * - The default lane (`''`) → the project's `targetLanguage` only (AQU-583);
 *   the per-file target is ignored so the project setting is authoritative.
 *
 * Returns `undefined` only when NOTHING records a target language — then the
 * caller shows the "Set target language" prompt.
 */
export function resolveActiveTargetLanguage(
  activeLane: string,
  // Retained for signature stability; the default lane no longer consults it.
  _fileTargetLanguage: string | null | undefined,
  projectTargetLanguage: string | null | undefined,
  lanes?: readonly LaneLanguageRow[] | null,
): string | undefined {
  if (activeLane) {
    return laneLanguageForTag(activeLane, lanes) || projectTargetLanguage || undefined
  }
  return projectTargetLanguage || undefined
}
