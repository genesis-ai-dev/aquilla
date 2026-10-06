// Inputs for the Bible data checks of one open file (AQU-1688).
//
// Pure: no React, no network. `useBibleChecks` (src/hooks/useBibleChecks.ts)
// loads the pack layers and calls these; the rule engine then gets one
// `CellCheckContext` per cell, compiled once per file and pack version.

import type { CellCheckContext } from "@/lib/rules/rule-engine"
import { projectHasScriptureFiles, type FileReference, type ProjectRecord } from "@/lib/parsers/types"
import { extraRegistryLanes } from "@/lib/lanes/registry-lanes"
import { resolveBibleEnrichment } from "../../../db/shared/bible-enrichments"
import { readLanguageProfile, type LanguageProfile } from "../../../db/shared/language-profile"
import { readProjectFacts } from "../../../db/shared/project-facts"
import { readinessFromDecisions } from "../../../db/shared/bible-checks/agreed-names"
import { compileFileExpectations, type CellRefsInput, type ParticipantLayers } from "../../../db/shared/bible-checks/compile"
import { isBibleCheckDormant } from "../../../db/shared/bible-checks/evaluate"
import { NO_READINESS, type BibleCheckReadiness } from "../../../db/shared/bible-checks/participant-types"
import { expandCellRefs } from "../../../db/shared/bible-checks/refs"
import {
  BIBLE_CHECK_IDS,
  isBibleScanCheckId,
  type StructureLayerInput,
  type TextLayerInput,
  type VoicesLayerInput,
} from "../../../db/shared/bible-checks/types"

/**
 * Whether a project's Bible data checks can run:
 *   off     — Bible data, or its Bible data checks enrichment, is off;
 *   dormant — on, but every check of a cell waits for an empty Language-profile slot
 *             (AQU-1699: or for decisions or terminology the project does not have);
 *   on      — at least one check of a cell can run with this profile.
 */
export type BibleChecksGate =
  | { state: "off" }
  | { state: "dormant"; profile: LanguageProfile }
  | { state: "on"; profile: LanguageProfile }

/** What the gate reads from a project. A ProjectRecord fits. */
export type BibleChecksProject = Pick<
  ProjectRecord,
  "bibleResourcesEnabled" | "bibleEnrichments" | "languageProfile" | "projectFacts" | "targetLanes" | "archivedLanes" | "lanes"
> &
  // AQU-1699: the agreed names read the source language, and the lanes the target's.
  Partial<Pick<ProjectRecord, "sourceLanguage" | "targetLanguage">> & {
    files?: Pick<FileReference, "type" | "hasScriptureContent">[]
  }

/** Is the project's Bible data checks enrichment on? (It needs Bible data on too.) */
export function bibleChecksEnabled(project: BibleChecksProject | null | undefined): boolean {
  return !!project && resolveBibleEnrichment(project, "checks", projectHasScriptureFiles(project.files))
}

/**
 * The gate from the enrichment switch, the stored `languageProfile` value and
 * (AQU-1699) what the project's decisions and terminology switch on.
 */
export function bibleChecksGateFor(
  enabled: boolean,
  storedProfile: unknown,
  readiness: BibleCheckReadiness = NO_READINESS,
): BibleChecksGate {
  if (!enabled) return { state: "off" }
  const profile = readLanguageProfile(storedProfile)
  // AQU-1697: S1 and S8 run in Check file, which loads what it needs, so
  // they never make a cell's live checks worth loading the pack for.
  const runnable = BIBLE_CHECK_IDS.some((id) => !isBibleScanCheckId(id) && !isBibleCheckDormant(id, profile, readiness))
  return runnable ? { state: "on", profile } : { state: "dormant", profile }
}

/** The gate for a project, from its settings. AQU-1699: its decisions count; its terminology is read elsewhere. */
export function bibleChecksGate(project: BibleChecksProject | null | undefined): BibleChecksGate {
  const readiness = readinessFromDecisions(readProjectFacts(project?.projectFacts), [])
  return bibleChecksGateFor(bibleChecksEnabled(project), project?.languageProfile, readiness)
}

/**
 * AQU-1699: more than one target lane is active. The termbase does not say
 * which lane a rendering is for, so an entry then names someone only with a
 * single rendering (db/shared/bible-checks/agreed-names.ts).
 */
export function isMultiLaneProject(project: BibleChecksProject | null | undefined): boolean {
  if (!project) return false
  const rows = project.lanes?.filter((lane) => lane.role === "target" && lane.archivedAt === null)
  if (rows && rows.length > 0) return rows.length > 1
  // The registry may list the primary language too (AQU-1473); it is the default lane, not an extra one.
  const archived = new Set((project.archivedLanes ?? []).map((lane) => lane.toLowerCase()))
  return extraRegistryLanes(project.targetLanes, project.targetLanguage).some((lane) => !archived.has(lane.toLowerCase()))
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
  /** AQU-1697: the text layer, for the number, negation and run-on sentence facts. */
  text: TextLayerInput | null = null,
  /** AQU-1699: the people layer and the agreed names, for check pack B. */
  participants: ParticipantLayers | null = null,
): Map<string, CellCheckContext> {
  const contexts = new Map<string, CellCheckContext>()
  for (const [cellId, expectation] of compileFileExpectations(cells, voices, structure, text, participants)) {
    contexts.set(cellId, { bible: { expectation, profile } })
  }
  return contexts
}
