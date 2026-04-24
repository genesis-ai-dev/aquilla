import { useCallback, useEffect, useRef, useState } from "react"
import type * as Y from "yjs"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import {
  buildRegexProposal,
  requestBatchFix,
  requestSurgicalFix,
  applyRegexFix,
  applyLiteralFix,
  type FixProposal,
} from "@/lib/rules/autofix"
import { addFixApplied, addLlmCall } from "@/lib/usage/record-usage"
import { updateProject } from "@/lib/store/project-index"
import { appendCellHistory } from "@/hooks/useCellHistory"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { checkRules } from "@/lib/rules/rule-engine"

interface Params {
  project: ProjectRecord
  doc: Y.Doc | null
  username: string
  refresh: () => void
  cellsByFile: Map<string, CellData[]>
}

interface ApplyReport { applied: number; skipped: number }

export function useAutofix(params: Params) {
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null)

  // Keep the most recently-persisted project in a ref so that chained mutations
  // (tryFixAll stamps attemptedAt, then applyProposal saves autofix + counters)
  // layer on top of each other even if the consumer hasn't re-rendered yet.
  const projectRef = useRef(params.project)
  useEffect(() => { projectRef.current = params.project }, [params.project])

  const getViolatingCells = useCallback((rule: TranslationRule): CellData[] => {
    const infractions = checkRules(params.cellsByFile, [rule])
    const ids = new Set(infractions.keys())
    const out: CellData[] = []
    for (const cells of params.cellsByFile.values()) {
      for (const c of cells) if (ids.has(c.id)) out.push(c)
    }
    return out
  }, [params.cellsByFile])

  const getPassingCells = useCallback((rule: TranslationRule): CellData[] => {
    const infractions = checkRules(params.cellsByFile, [rule])
    const ids = new Set(infractions.keys())
    const out: CellData[] = []
    for (const cells of params.cellsByFile.values()) {
      for (const c of cells) {
        if (c.status !== "empty" && !ids.has(c.id)) out.push(c)
      }
    }
    return out
  }, [params.cellsByFile])

  async function recordUsage(meta: { kind: string; model?: string; provider: string }) {
    const next = addLlmCall(projectRef.current, meta)
    projectRef.current = next
    await updateProject(next)
    params.refresh()
  }

  async function stampAttempted(rule: TranslationRule) {
    const now = new Date().toISOString()
    const nextRules = (projectRef.current.rules || []).map((r) =>
      r.id === rule.id ? { ...r, autofixAttemptedAt: now } : r
    )
    const next = { ...projectRef.current, rules: nextRules }
    projectRef.current = next
    await updateProject(next)
    params.refresh()
  }

  const tryFixAll = useCallback(async (rule: TranslationRule): Promise<FixProposal> => {
    setBusyRuleId(rule.id)
    try {
      const violating = getViolatingCells(rule)
      if (rule.autofix) {
        const cached = buildRegexProposal(rule.autofix, violating, "cached-regex")
        if (cached.kind === "regex-replace" && cached.previews.length > 0) return cached
      }
      const settings = params.project.completionSettings
      if (!settings) return { kind: "none", reason: "Could not apply fixes" }
      const passing = getPassingCells(rule)
      const proposal = await requestBatchFix({
        rule, violatingCells: violating, passingCells: passing, settings, session: null,
        onLlmCall: (meta) => { void recordUsage(meta) },
      })
      await stampAttempted(rule)
      return proposal
    } finally {
      setBusyRuleId(null)
    }
  }, [params.project.completionSettings, getPassingCells, getViolatingCells])

  const tryFixOne = useCallback(async (rule: TranslationRule, cell: CellData): Promise<FixProposal> => {
    setBusyRuleId(rule.id)
    try {
      const settings = params.project.completionSettings
      if (!settings) return { kind: "none", reason: "Could not apply fixes" }
      return await requestSurgicalFix({
        rule, cell, settings, session: null,
        onLlmCall: (meta) => { void recordUsage(meta) },
      })
    } finally {
      setBusyRuleId(null)
    }
  }, [params.project.completionSettings])

  const applyProposal = useCallback(
    async (rule: TranslationRule, proposal: FixProposal, selected: Set<string>): Promise<ApplyReport> => {
      if (proposal.kind === "none") return { applied: 0, skipped: 0 }
      const doc = params.doc
      if (!doc) return { applied: 0, skipped: 0 }

      let applied = 0
      let skipped = 0
      for (const preview of proposal.previews) {
        if (!selected.has(preview.cellId)) continue
        const cell = doc.getMap("cells").get(preview.cellId) as Y.Map<unknown> | undefined
        if (!cell) { skipped++; continue }
        const current = (cell.get("translated") as string) || ""
        let next: string
        try {
          if (proposal.kind === "regex-replace") {
            next = applyRegexFix({ kind: "regex-replace", pattern: proposal.pattern, replacement: proposal.replacement, flags: proposal.flags }, current)
          } else {
            if (!preview.find || preview.replace === undefined) { skipped++; continue }
            if (!current.includes(preview.find)) { skipped++; continue }
            next = applyLiteralFix(preview.find, preview.replace, current)
          }
        } catch { skipped++; continue }
        if (next === current) { skipped++; continue }
        const author = `autofix:rule-${rule.id}`
        appendCellHistory(doc, preview.cellId, { value: next, source: "llm", author, validated: false })
        commitCellEdit(doc, preview.cellId, author, ["value"], next, "llm")
        applied++
      }

      if (applied > 0) {
        let updated = projectRef.current
        if (proposal.kind === "regex-replace" && !rule.autofix) {
          const nextRules = (updated.rules || []).map((r) =>
            r.id === rule.id
              ? { ...r, autofix: { kind: "regex-replace" as const, pattern: proposal.pattern, replacement: proposal.replacement, flags: proposal.flags }, autofixAttemptedAt: new Date().toISOString() }
              : r
          )
          updated = { ...updated, rules: nextRules }
        }
        updated = addFixApplied(updated)
        projectRef.current = updated
        await updateProject(updated)
        params.refresh()
      }
      return { applied, skipped }
    },
    [params.doc, params.refresh],
  )

  return { busyRuleId, tryFixAll, tryFixOne, applyProposal }
}
