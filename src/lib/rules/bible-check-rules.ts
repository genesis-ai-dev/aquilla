// Bible data checks inside the rule engine (AQU-1688).
//
// The checks themselves live in db/shared/bible-checks, shared with the
// workers. This adapter turns one finding into the engine's RuleInfraction:
// the reason stays a code (`builtin:bkp:V2`), and the finding's own reason,
// params and pack evidence travel as `reasonParams` strings, which
// src/lib/bible-data/check-messages.ts renders through t().

import type { InfractionSpan, RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import { evaluateCell, isBibleCheckDormant } from "../../../db/shared/bible-checks/evaluate"
import { bibleReasonParams } from "../../../db/shared/bible-checks/params"
import type { BibleCheckReadiness } from "../../../db/shared/bible-checks/participant-types"
import { scanHeadings, scanVersification, type BibleScanFinding, type ScanCellInput } from "../../../db/shared/bible-checks/scans"
import { scanNameConsistency, scanRepeatedQuotations, type TextScanCell } from "../../../db/shared/bible-checks/scans-pack-b"
import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  isBibleCheckId,
  isBibleScanCheckId,
  type BibleCheckFinding,
  type BibleCheckId,
  type CellExpectation,
  type StructureLayerInput,
  type TextLayerInput,
  type VoicesLayerInput,
} from "../../../db/shared/bible-checks/types"
import type { LanguageProfile } from "../../../db/shared/language-profile"

/**
 * What one cell's Bible data checks read besides its own text: the facts the
 * pack gives for that cell, compiled once per file, and the project's
 * Language profile. Never another cell's text.
 */
export interface BibleCellCheckInput {
  expectation: CellExpectation
  profile: LanguageProfile
}

// The engine runs one cell's rules back to back, so a cell's Bible data rules
// share one evaluation of the text. Same text and same input object, same
// findings: this is a cache, not state.
let last: { text: string; input: BibleCellCheckInput; findings: BibleCheckFinding[] } | null = null

function findingsFor(text: string, input: BibleCellCheckInput): BibleCheckFinding[] {
  if (last && last.text === text && last.input === input) return last.findings
  const findings = evaluateCell(text, input.expectation, input.profile)
  last = { text, input, findings }
  return findings
}

// AQU-1690: shared with autopilot, which stores the same strings on a draft's
// `bkp:` verdict. Re-exported so this module's callers are unchanged.
export { bibleReasonParams }

/** The infraction for one Bible data rule on one cell, or null. No input means the check cannot run here. */
export function bibleCheckInfraction(
  ruleId: string,
  checkId: BibleCheckId,
  cellId: string,
  fileId: string,
  text: string,
  input: BibleCellCheckInput | undefined,
): RuleInfraction | null {
  if (!input) return null
  const finding = findingsFor(text, input).find((f) => f.code === checkId)
  if (!finding) return null
  const spans: InfractionSpan[] = finding.spans.map(({ start, end }) => ({
    side: "target",
    start,
    end,
    matchedText: text.slice(start, end),
  }))
  // A finding below its check's default (an info P5 on a place, under P5's
  // warning) shows as minor. One at the default leaves the rule's severity,
  // including whatever the project set it to, untouched.
  const lower = finding.severity === "info" && BIBLE_CHECK_DEFAULT_SEVERITY[checkId] === "warning"
  return {
    ruleId,
    cellId,
    fileId,
    reason: `builtin:${checkId}`,
    reasonParams: bibleReasonParams(finding),
    spans,
    ...(lower ? { severity: "minor" as const } : {}),
  }
}

// ── AQU-1697: the file-level scans (S1, S8; AQU-1699: P2, X3) ───────────────

/** What Check file's Bible data scans read: the book's structure layer, in the project's versification, and the profile. */
export interface BibleFileScanInput {
  structure: StructureLayerInput
  profile: LanguageProfile
  /** AQU-1699: X3 compares the Greek of repeated quotations. */
  voices?: VoicesLayerInput | null
  text?: TextLayerInput | null
  /** AQU-1699: each cell's compiled expectation, with its participants (P2). */
  expectations?: ReadonlyMap<string, CellExpectation>
  /** AQU-1699: what the project's decisions and terminology switch on. */
  readiness?: BibleCheckReadiness
}

/** One scan's findings, or none when it lacks what it reads. */
function runScan(
  checkId: BibleCheckId,
  cells: readonly (ScanCellInput & { translated?: string })[],
  scan: BibleFileScanInput,
): BibleScanFinding[] {
  const textCells = (): TextScanCell[] =>
    cells.map((cell) => ({ id: cell.id, globalReferences: cell.globalReferences, text: cell.translated ?? "" }))
  switch (checkId) {
    case "bkp:S1":
      return scanHeadings(cells, scan.structure, scan.profile)
    case "bkp:S8":
      return scanVersification(cells, scan.structure)
    case "bkp:P2":
      return scan.expectations ? scanNameConsistency(textCells(), scan.expectations) : []
    case "bkp:X3":
      return scan.voices && scan.text ? scanRepeatedQuotations(textCells(), scan.voices, scan.text, scan.profile) : []
    default:
      return []
  }
}

/**
 * The scans' findings as infractions of their built-in rules, for every rule
 * in `rules` (the enabled ones) that is a scan and not dormant. The cells are
 * the whole file, in order.
 */
export function bibleScanInfractions(
  cells: readonly (ScanCellInput & { fileId: string; translated?: string })[],
  rules: readonly TranslationRule[],
  scan: BibleFileScanInput | null | undefined,
): RuleInfraction[] {
  if (!scan) return []
  const fileOf = new Map(cells.map((cell) => [cell.id, cell.fileId]))
  const out: RuleInfraction[] = []
  for (const rule of rules) {
    if (rule.check.type !== "builtin" || !isBibleCheckId(rule.check.checkId)) continue
    const checkId = rule.check.checkId
    if (!isBibleScanCheckId(checkId) || isBibleCheckDormant(checkId, scan.profile, scan.readiness)) continue
    const findings = runScan(checkId, cells, scan)
    for (const finding of findings) {
      out.push({
        ruleId: rule.id,
        cellId: finding.cellId,
        fileId: fileOf.get(finding.cellId) ?? "",
        reason: `builtin:${checkId}`,
        reasonParams: bibleReasonParams(finding),
        spans: [],
      })
    }
  }
  return out
}
