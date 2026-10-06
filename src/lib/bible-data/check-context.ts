// Inputs for the Bible data checks of one open file (AQU-1688).
//
// Pure: no React, no network. `useBibleChecks` (src/hooks/useBibleChecks.ts)
// loads the pack layers and calls these; the rule engine then gets one
// `CellCheckContext` per cell, compiled once per file and pack version.

import type { CellCheckContext } from "@/lib/rules/rule-engine"
import { projectHasScriptureFiles, type FileReference, type ProjectRecord } from "@/lib/parsers/types"
import { resolveBibleEnrichment } from "../../../db/shared/bible-enrichments"
import { readLanguageProfile, type LanguageProfile } from "../../../db/shared/language-profile"
import { compileFileExpectations, type CellRefsInput } from "../../../db/shared/bible-checks/compile"
import { isBibleCheckDormant } from "../../../db/shared/bible-checks/evaluate"
import { expandCellRefs } from "../../../db/shared/bible-checks/refs"
import {
  BIBLE_CHECK_IDS,
  type StructureLayerInput,
  type VoicesLayerInput,
} from "../../../db/shared/bible-checks/types"

/**
 * Whether a project's Bible data checks can run:
 *   off     — Bible data, or its Bible data checks enrichment, is off;
 *   dormant — on, but every check waits for an empty Language-profile slot;
 *   on      — at least one check can run with this profile.
 */
export type BibleChecksGate =
  | { state: "off" }
  | { state: "dormant"; profile: LanguageProfile }
  | { state: "on"; profile: LanguageProfile }

/** What the gate reads from a project. A ProjectRecord fits. */
export type BibleChecksProject = Pick<ProjectRecord, "bibleResourcesEnabled" | "bibleEnrichments" | "languageProfile"> & {
  files?: Pick<FileReference, "type" | "hasScriptureContent">[]
}

/** Is the project's Bible data checks enrichment on? (It needs Bible data on too.) */
export function bibleChecksEnabled(project: BibleChecksProject | null | undefined): boolean {
  return !!project && resolveBibleEnrichment(project, "checks", projectHasScriptureFiles(project.files))
}

/** The gate from the enrichment switch and the stored `languageProfile` value. */
export function bibleChecksGateFor(enabled: boolean, storedProfile: unknown): BibleChecksGate {
  if (!enabled) return { state: "off" }
  const profile = readLanguageProfile(storedProfile)
  const runnable = BIBLE_CHECK_IDS.some((id) => !isBibleCheckDormant(id, profile))
  return runnable ? { state: "on", profile } : { state: "dormant", profile }
}

export function bibleChecksGate(project: BibleChecksProject | null | undefined): BibleChecksGate {
  return bibleChecksGateFor(bibleChecksEnabled(project), project?.languageProfile)
}

/** The USFM book of the first cell with a verse ref, e.g. "JHN"; null for a file with none. */
export function bookOfCells(cells: readonly CellRefsInput[]): string | null {
  for (const cell of cells) {
    const verses = expandCellRefs(cell.globalReferences ?? [])
    if (verses) return verses.book
  }
  return null
}

/**
 * One context per cell the pack has facts for, keyed by cell id. Each holds
 * that cell's expectation and the profile, and nothing about any other cell.
 */
export function buildCellCheckContexts(
  cells: readonly CellRefsInput[],
  voices: VoicesLayerInput,
  structure: StructureLayerInput | null,
  profile: LanguageProfile,
): Map<string, CellCheckContext> {
  const contexts = new Map<string, CellCheckContext>()
  for (const [cellId, expectation] of compileFileExpectations(cells, voices, structure)) {
    contexts.set(cellId, { bible: { expectation, profile } })
  }
  return contexts
}
