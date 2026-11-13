// AQU-2052 — which language the hosted transcription model picker compares a
// model's catalog against.
//
// The picker used to read `project.targetLanguage` and only believed it when it
// looked like a BCP 47 code. The create dialog saves the language NAME, not the
// code (`LanguageComboboxInput` hands the catalog entry's `name` to its
// handler), so on every project created the normal way the value is "Spanish"
// and the check failed — no "Supports …" line ever appeared. The project-level
// language is also the field AQU-1593 retired in favour of the lane row.
//
// So the code comes from a LANE, through `laneLanguageCode`, which already
// answers "this lane's language as a tag a machine can act on": the row's
// override when it has one, else the code derived from the label at read time,
// else null. A freeform label no catalog entry matches ("Grade 7 English")
// still derives nothing, and null is what keeps the picker silent rather than
// claiming support for a language it guessed.
//
// One more step than that, though. `laneLanguageCode` can only derive a code
// the LANE catalog carries, and the ASR catalogs are far larger — Omnilingual
// alone knows 1600+ languages, and Tok Pisin ("tpi") is in none of the lane
// lists. A lane whose label already IS a well-formed tag is therefore passed
// through unchanged: it derives nothing here yet matches perfectly downstream.
// That is the one case the old shape check got right, and it is kept.

import {
  firstPositionLaneId, resolveStoredLaneId,
  type LaneChoiceRow, type StoredLaneChoice,
} from "@/lib/lanes/active-lane-choice"
import { laneLanguage, laneLanguageCode } from "@/lib/lanes/lane-display"

/** The lane fields this resolution needs — a subset of `ProjectRecord.lanes`. */
export interface TranscriptionLanguageLane extends LaneChoiceRow {
  role: "source" | "target"
  language?: string | null
  name: string | null
  langCode: string | null
}

/**
 * The language code the picker should test each model against, or `null` when
 * nothing names one.
 *
 * Preferences is not inside a project, so there is no active lane in context:
 * the reader's stored choice for this project answers when they have one
 * (`readPersistedLaneChoice`), and the first target lane in position order is
 * the floor — the same lane the editor would open.
 *
 * The project-level language is deliberately NOT a fallback. A project with no
 * lane rows yet (a read that has not returned them) answers `null` and the
 * picker stays silent until they land, rather than briefly claiming support
 * from the field AQU-1593 retired.
 */
export function transcriptionLanguageCode(
  lanes: readonly TranscriptionLanguageLane[] | null | undefined,
  options: { stored?: StoredLaneChoice } = {},
): string | null {
  const targets = (lanes ?? []).filter((lane) => lane.role === "target")
  if (targets.length === 0) return null

  const laneId =
    (options.stored ? resolveStoredLaneId(options.stored, targets) : null) ??
    firstPositionLaneId(targets)
  const lane = targets.find((row) => row.id === laneId)
  if (!lane) return null

  const context = { role: "target" as const, legacyTag: lane.legacyTag }
  const derived = laneLanguageCode(lane, context)
  if (derived) return derived

  // Nothing derived: the label itself is the tag when it is shaped like one.
  const label = laneLanguage(lane, context).trim()
  return CODE_SHAPED.test(label) ? label : null
}

/** A BCP 47-shaped tag: "es", "es-MX", "tpi", "zh-Hant". */
const CODE_SHAPED = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*$/
