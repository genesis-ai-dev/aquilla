// bible-repair — the cheap repair for Bible data expectations (AQU-1690;
// design doc §9.4 "Bounded repair").
//
// A cell the verifier panel ACCEPTED, whose only problem is a Bible data
// expectation (a quotation left open, a question made a statement, an active
// Jev question answered "no"), does not need the panel again. It gets one
// mid-tier redraft with templated constraints, then a re-check by code and
// Jev — about 5 units instead of a second ~55-unit panel.
//
// The attempt limit stays at 2: this redraft IS the cell's second attempt.
// Every cell comes out staged — the repaired text when the redraft returned
// it, else the first draft. A failure that survives is staged for a person
// with its bkp: codes (the stage re-check sees to that); it is never skipped.

import type { CellPair } from "../agent/tools/select-cells"
import { checkSpanBible, type SpanBible } from "./bible-span"
import type { PerformSpanResult } from "./draft"
import { cellFindings } from "./findings"
import type { JudgeResult } from "./judge-expectations"
import type { LintFlag, SpanDraft } from "./types"

export interface RepairCell {
  cellId: string
  /** The first draft, which the panel accepted. */
  text: string
  findings: string[]
  constraints: string[]
}

export interface RepairDeps {
  pairs: readonly CellPair[]
  bible: SpanBible
  draft: (pairs: CellPair[], constraints: { cellId: string; constraints: string[] }[]) => Promise<PerformSpanResult>
  lint: (draft: SpanDraft) => Promise<LintFlag[]>
}

export interface RepairOutcome {
  accepted: { cellId: string; text: string; findings: string[] }[]
  notes: string[]
  flags: LintFlag[]
  judged?: JudgeResult
  promptVersion?: string
}

/** The panel's view of the first draft still stands for these; lint and Bible codes are re-derived. */
function panelFindings(findings: readonly string[]): string[] {
  return findings.filter((code) => code.startsWith("dissent:") || code === "unsupported")
}

export async function repairExpectations(cells: readonly RepairCell[], deps: RepairDeps): Promise<RepairOutcome> {
  const keepFirst = (cell: RepairCell) => ({ cellId: cell.cellId, text: cell.text, findings: cell.findings })
  const byId = new Map(deps.pairs.map((p) => [p.cellId, p]))
  const pairs = cells.flatMap((cell) => {
    const pair = byId.get(cell.cellId)
    return pair ? [pair] : []
  })
  const drafted = await deps.draft(
    pairs,
    cells.map((cell) => ({ cellId: cell.cellId, constraints: cell.constraints })),
  )
  if (!drafted.ok) {
    return {
      accepted: cells.map(keepFirst),
      notes: [`expectation repair draft failed (${drafted.error}); staging the first drafts`],
      flags: [],
    }
  }
  const flags = await deps.lint(drafted.draft)
  const check = await checkSpanBible(deps.bible, drafted.draft, flags)
  const textById = new Map(drafted.draft.cells.map((c) => [c.cellId, c.text]))
  const accepted = cells.map((cell) => {
    const text = textById.get(cell.cellId)
    if (!text) return keepFirst(cell)
    const fresh = cellFindings(cell.cellId, {
      votes: [],
      flags,
      redrafted: true,
      bible: check.activeCodes.get(cell.cellId) ?? [],
    })
    return { cellId: cell.cellId, text, findings: [...panelFindings(cell.findings), ...fresh] }
  })
  return {
    accepted,
    notes: [`repaired ${textById.size} cell(s) for Bible data expectations without the deep panel`],
    flags,
    ...(check.judged ? { judged: check.judged } : {}),
    promptVersion: drafted.draft.promptVersion,
  }
}
