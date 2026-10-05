// AQU-602: resolve the editor's active target language from the active lane.
//
// The lanes model (AQU-538) is "one source, N target lanes". Switching lanes
// switches the target language the editor reads/writes/translates into — not
// just the cell filter. That language is the lane row's (AQU-1592), including
// the default lane; the project setting is the fallback when there is no row.
//
// AQU-1586: that language comes from the lane ROW, never from the lane's tag.
// The tag is the event key (`target_lang`), and `planNewTargetLane` sets it to
// the opaque lane id whenever the language string is taken by a sibling or
// matches the project default — so reading the tag as the language drafted a
// second Spanish lane "into a3f09c1e". `laneLanguageForTag` owns that rule.
//
// AQU-583: a file's `targetLanguage` is only ever an import-time snapshot
// (or an inference seed — AQU-249). Consulting it on the default lane shadowed
// a later Settings change and surfaced a stamped language when the project had
// none set. The file is never consulted. With no lane rows, the project target
// is what the default lane uses; when it is unset the prompt shows.
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
 * - The default lane (`''`) → the lane row's language when the project has
 *   rows (AQU-1592). With no rows, the project's `targetLanguage` only
 *   (AQU-583). The per-file target is ignored either way.
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
  const fromRow = lanes && lanes.length > 0 ? laneLanguageForTag("", lanes) : null
  return fromRow || projectTargetLanguage || undefined
}
