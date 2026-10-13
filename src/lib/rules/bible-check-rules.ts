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
import { scanHeadings, scanVersification, type ScanCellInput } from "../../../db/shared/bible-checks/scans"
import {
  isBibleCheckId,
  isBibleScanCheckId,
  type BibleCheckFinding,
  type BibleCheckId,
  type CellExpectation,
  type StructureLayerInput,
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
  return {
    ruleId,
    cellId,
    fileId,
    reason: `builtin:${checkId}`,
    reasonParams: bibleReasonParams(finding),
    spans,
  }
}

// ── AQU-1697: the file-level scans (S1, S8) ─────────────────────────────────

/** What Check file's Bible data scans read: the book's structure layer, in the project's versification, and the profile. */
export interface BibleFileScanInput {
  structure: StructureLayerInput
  profile: LanguageProfile
}

/**
 * The scans' findings as infractions of their built-in rules, for every rule
 * in `rules` (the enabled ones) that is a scan and not dormant. The cells are
 * the whole file, in order.
 */
export function bibleScanInfractions(
  cells: readonly (ScanCellInput & { fileId: string })[],
  rules: readonly TranslationRule[],
  scan: BibleFileScanInput | null | undefined,
): RuleInfraction[] {
  if (!scan) return []
  const fileOf = new Map(cells.map((cell) => [cell.id, cell.fileId]))
  const out: RuleInfraction[] = []
  for (const rule of rules) {
    if (rule.check.type !== "builtin" || !isBibleCheckId(rule.check.checkId)) continue
    const checkId = rule.check.checkId
    if (!isBibleScanCheckId(checkId) || isBibleCheckDormant(checkId, scan.profile)) continue
    const findings =
      checkId === "bkp:S1" ? scanHeadings(cells, scan.structure, scan.profile) : scanVersification(cells, scan.structure)
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
