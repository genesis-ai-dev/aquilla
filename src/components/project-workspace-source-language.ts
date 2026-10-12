// AQU-848 / AQU-1593 / AQU-1595: resolve the editor's active SOURCE language.
//
// The source lane's row is the language. A file's `sourceLanguage` is only
// ever an import-time snapshot and is ignored. Project settings are not
// consulted either: a null `language` answers from the row's name, then its
// tag, then its code. Callers still pass the settings object so the signature
// stays stable; `laneLanguage` does not read the keys.
//
// Pure helper, isolated from the heavyweight ProjectWorkspace component so the
// rule can be unit-tested without a harness.

import { laneLanguage, type LaneLanguageSettings } from "@/lib/lanes/lane-display"
import type { LaneLanguageRow } from "@/lib/lanes/lane-language"

/**
 * The source language the editor should display and translate from.
 *
 * The source lane's typed `language` when the row has one. An un-backfilled
 * source lane (`language` null) answers from its name, then its tag, then its
 * code. Settings are ignored. The per-file import-time stamp is ignored.
 *
 * Returns `undefined` when nothing records a source language.
 */
export function resolveActiveSourceLanguage(
  // Retained for signature stability; deliberately not consulted (AQU-848).
  _fileSourceLanguage: string | null | undefined,
  settings: LaneLanguageSettings | null | undefined,
  sourceLane?: LaneLanguageRow | null,
): string | undefined {
  const resolved = laneLanguage(sourceLane ?? { role: "source", language: null }, {
    settings,
    role: sourceLane?.role ?? "source",
    legacyTag: sourceLane?.legacyTag ?? null,
  })
  return resolved || undefined
}
