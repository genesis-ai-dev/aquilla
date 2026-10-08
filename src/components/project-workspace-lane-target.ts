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
import type { LaneLanguageSettings } from "@/lib/lanes/lane-display"

/**
 * The target language for the currently active lane.
 *
 * - Any lane → {@link laneLanguageForTag}, which calls `laneLanguage`. A typed
 *   `language` wins. The former default lane (`''`) may still answer from
 *   `settings.targetLanguage` inside that function until AQU-1616 backfills
 *   the row. An id-tagged lane never inherits the project language and never
 *   uses its tag.
 * - With no rows, a non-id tag is the language (a server that predates lane
 *   rows). The per-file target is ignored either way.
 *
 * Returns `undefined` only when NOTHING records a target language — then the
 * caller shows the "Set target language" prompt.
 */
export function resolveActiveTargetLanguage(
  activeLane: string,
  // Retained for signature stability; the file stamp is never consulted.
  _fileTargetLanguage: string | null | undefined,
  settings: LaneLanguageSettings | null | undefined,
  lanes?: readonly LaneLanguageRow[] | null,
): string | undefined {
  return laneLanguageForTag(activeLane, lanes, settings) || undefined
}

/** One target lane as the Import dialog's "Is this a translation?" check sees
 *  it (`TranslationTargetLanguage` in ImportDialog). */
export interface LaneTargetLanguage {
  language: string
  label: string | null
  active: boolean
}

/**
 * AQU-1365: every lane's target language, for telling a translation upload
 * from a source one, and which of them is the open lane (the one a translation
 * import fills).
 *
 * The language follows the same rule as the editor's: {@link laneLanguageForTag}
 * for every lane, including the former default. A lane that resolves to nothing
 * is left out.
 */
export function laneTargetLanguages(
  lanes: readonly string[],
  activeLane: string,
  settings: LaneLanguageSettings | null | undefined,
  laneLabels: Readonly<Record<string, string>>,
  rows?: readonly LaneLanguageRow[] | null,
): LaneTargetLanguage[] {
  return lanes.flatMap((lane) => {
    const language = laneLanguageForTag(lane, rows, settings)
    return language ? [{ language, label: laneLabels[lane] || null, active: lane === activeLane }] : []
  })
}
