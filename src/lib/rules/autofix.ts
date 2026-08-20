import type { RuleAutofix } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings, TranslationRule } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { t } from "@/lib/i18n/standalone"

export function applyRegexFix(fix: RuleAutofix, translated: string): string {
  const re = new RegExp(fix.pattern, fix.flags)
  return translated.replace(re, fix.replacement)
}

// Literal replace-all. Does NOT treat `find` as a regex.
export function applyLiteralFix(find: string, replace: string, translated: string): string {
  if (find.length === 0) return translated
  return translated.split(find).join(replace)
}

export interface PerCellFix {
  cellId: string
  find: string
  replace: string
  rationale?: string
}

export type BatchResponse =
  | { kind: "regex-replace"; pattern: string; replacement: string; flags: string; rationale?: string }
  | { kind: "none"; reason: string }

export type PerCellResponse =
  | { kind: "per-cell"; fixes: PerCellFix[] }
  | { kind: "none"; reason: string }

function stripFences(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return ""
  return s.slice(start, end + 1)
}

export function parseBatchResponse(raw: string): BatchResponse | null {
  const cleaned = stripFences(raw)
  if (!cleaned) return null
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return null }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>

  if (obj.kind === "regex-replace") {
    if (typeof obj.pattern !== "string" || typeof obj.replacement !== "string" || typeof obj.flags !== "string") {
      return null
    }
    return {
      kind: "regex-replace",
      pattern: obj.pattern,
      replacement: obj.replacement,
      flags: obj.flags,
      rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
    }
  }
  if (obj.kind === "none") {
    return { kind: "none", reason: typeof obj.reason === "string" ? obj.reason : t("rules.autofix.noReasonGiven") }
  }
  return null
}

export function parsePerCellResponse(raw: string): PerCellResponse | null {
  const cleaned = stripFences(raw)
  if (!cleaned) return null
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return null }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>

  if (obj.kind === "none") {
    return { kind: "none", reason: typeof obj.reason === "string" ? obj.reason : t("rules.autofix.noReasonGiven") }
  }
  if (obj.kind !== "per-cell" || !Array.isArray(obj.fixes)) return null
  const fixes: PerCellFix[] = []
  for (const f of obj.fixes) {
    if (!f || typeof f !== "object") continue
    const fx = f as Record<string, unknown>
    if (typeof fx.cellId !== "string" || typeof fx.find !== "string" || typeof fx.replace !== "string") continue
    fixes.push({
      cellId: fx.cellId, find: fx.find, replace: fx.replace,
      rationale: typeof fx.rationale === "string" ? fx.rationale : undefined,
    })
  }
  return { kind: "per-cell", fixes }
}

export interface FixPreview {
  cellId: string
  fileId: string
  before: string
  after: string
  find?: string
  replace?: string
  source: "llm" | "cached-regex"
  rationale?: string
}

export type FixProposal =
  | { kind: "regex-replace"; pattern: string; replacement: string; flags: string; rationale?: string; previews: FixPreview[] }
  | { kind: "per-cell"; previews: FixPreview[] }
  | { kind: "none"; reason: string }

export function buildRegexProposal(
  fix: RuleAutofix,
  cells: CellData[],
  source: "llm" | "cached-regex",
  rationale?: string,
): FixProposal {
  const previews: FixPreview[] = []
  for (const c of cells) {
    let after: string
    try { after = applyRegexFix(fix, c.translated) } catch { continue }
    if (after === c.translated) continue
    previews.push({
      cellId: c.id, fileId: c.fileId, before: c.translated, after, source, rationale,
    })
  }
  return { kind: "regex-replace", pattern: fix.pattern, replacement: fix.replacement, flags: fix.flags, rationale, previews }
}

export function buildPerCellProposal(
  response: { kind: "per-cell"; fixes: PerCellFix[] },
  cells: CellData[],
): FixProposal {
  const byId = new Map(cells.map((c) => [c.id, c]))
  const previews: FixPreview[] = []
  for (const fx of response.fixes) {
    const c = byId.get(fx.cellId)
    if (!c) continue
    if (!c.translated.includes(fx.find)) continue   // hallucination guard
    const after = applyLiteralFix(fx.find, fx.replace, c.translated)
    if (after === c.translated) continue
    previews.push({
      cellId: c.id, fileId: c.fileId, before: c.translated, after,
      find: fx.find, replace: fx.replace, source: "llm", rationale: fx.rationale,
    })
  }
  return { kind: "per-cell", previews }
}

const BATCH_SYSTEM_PROMPT = `You are a translation QA engineer. Given a rule and examples of cells that follow it vs. cells that break it, propose a single regex-based fix that transforms breaking cells into following cells.

Output ONLY valid JSON matching one of these shapes:

{ "kind": "regex-replace", "pattern": "regex string", "replacement": "replacement string (may use $1 backrefs)", "flags": "gi", "rationale": "one sentence" }
{ "kind": "none", "reason": "one-sentence reason" }

Rules:
- The fix MUST apply only to the cell's translated content.
- Use JavaScript regex syntax. Escape backslashes in JSON: \\\\b for \\b.
- Prefer narrow patterns. Avoid matches that could over-fire.
- If a single regex cannot correct all breaking examples without risking false positives, return { "kind": "none", "reason": "..." }.

Output ONLY JSON. No markdown, no code fences, no explanation.`

const PER_CELL_SYSTEM_PROMPT = `You are a translation editor. For each cell listed below, identify the smallest substring of the translated text that must change to satisfy the rule, and propose its replacement. Preserve all formatting, punctuation, and surrounding text.

Output ONLY valid JSON:

{ "kind": "per-cell", "fixes": [ { "cellId": "...", "find": "exact substring in translated", "replace": "corrected substring", "rationale": "one sentence" } ] }

If a cell cannot be fixed safely, omit it from fixes. If no cells can be fixed, return { "kind": "none", "reason": "..." }.

The "find" string MUST appear verbatim in that cell's translated text.

Output ONLY JSON. No markdown, no code fences, no explanation.`

function describeCheck(rule: TranslationRule): string {
  const c = rule.check
  if (c.type === "target-forbids") return `Target must not contain /${c.targetPattern}/i`
  if (c.type === "source-target-match") return `Pattern /${c.pattern}/gi must appear in both source and target when present in source`
  if (c.type === "source-requires-target") return `When source matches /${c.sourcePattern}/i, target must match /${c.targetPattern}/i`
  // builtin: code-defined check, identified only by id from the caller's perspective.
  return `Built-in check: ${c.checkId}`
}

function buildBatchUserMessage(rule: TranslationRule, breaking: CellData[], passing: CellData[]): string {
  const breakSample = breaking.slice(0, 10)
  const passSample = passing.slice(0, 5)
  const fmt = (cs: CellData[]) =>
    cs.map((c, i) => `${i + 1}. Source: "${effectiveSourceText(c)}"\n   Target: "${c.translated}"`).join("\n\n") || "(none)"
  return [
    `Rule name: ${rule.name}`,
    `Severity: ${rule.severity}`,
    `Description: ${rule.description || "(none)"}`,
    `Check: ${describeCheck(rule)}`,
    ``,
    `Cells FOLLOWING the rule:`,
    fmt(passSample),
    ``,
    `Cells BREAKING the rule (fix these):`,
    fmt(breakSample),
    ``,
    `Propose a JSON fix per the output contract.`,
  ].join("\n")
}

function buildPerCellUserMessage(rule: TranslationRule, breaking: CellData[]): string {
  const list = breaking
    .map((c) => `- cellId: ${c.id}\n  source: "${effectiveSourceText(c)}"\n  translated: "${c.translated}"`)
    .join("\n")
  return [
    `Rule name: ${rule.name}`,
    `Description: ${rule.description || "(none)"}`,
    `Check: ${describeCheck(rule)}`,
    ``,
    `Cells to fix:`,
    list,
  ].join("\n")
}

export interface RequestBatchFixParams {
  rule: TranslationRule
  violatingCells: CellData[]
  passingCells: CellData[]
  settings: CompletionSettings
  session: FrontierSession | null
  onLlmCall?: (meta: { kind: string; model?: string; provider: string }) => void
}

export async function requestBatchFix(params: RequestBatchFixParams): Promise<FixProposal> {
  const { rule, violatingCells, passingCells, settings, session, onLlmCall } = params
  const provider = settings.provider || "frontier"
  const model = settings.model
  let raw: string
  try {
    raw = await complete({
      settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 2048), temperature: 0.2 },
      session,
      messages: [
        { role: "system", content: BATCH_SYSTEM_PROMPT },
        { role: "user", content: buildBatchUserMessage(rule, violatingCells, passingCells) },
      ],
    })
    onLlmCall?.({ kind: "autofix-batch-regex", model, provider })
  } catch {
    return { kind: "none", reason: t("rules.autofix.couldNotApplyFixes") }
  }
  const parsed = parseBatchResponse(raw)
  if (parsed && parsed.kind === "regex-replace") {
    const autofix: RuleAutofix = {
      kind: "regex-replace", pattern: parsed.pattern, replacement: parsed.replacement, flags: parsed.flags,
    }
    const proposal = buildRegexProposal(autofix, violatingCells, "llm", parsed.rationale)
    if (proposal.kind === "regex-replace" && proposal.previews.length > 0) return proposal
  }
  if (violatingCells.length >= 10) {
    return { kind: "none", reason: parsed && parsed.kind === "none" ? parsed.reason : t("rules.autofix.couldNotApplyFixes") }
  }
  let rawSemantic: string
  try {
    rawSemantic = await complete({
      settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 4096), temperature: 0.2 },
      session,
      messages: [
        { role: "system", content: PER_CELL_SYSTEM_PROMPT },
        { role: "user", content: buildPerCellUserMessage(rule, violatingCells) },
      ],
    })
    onLlmCall?.({ kind: "autofix-batch-semantic", model, provider })
  } catch {
    return { kind: "none", reason: t("rules.autofix.couldNotApplyFixes") }
  }
  const semantic = parsePerCellResponse(rawSemantic)
  if (!semantic || semantic.kind === "none") {
    return { kind: "none", reason: semantic?.reason || t("rules.autofix.couldNotApplyFixes") }
  }
  const built = buildPerCellProposal(semantic, violatingCells)
  if (built.kind === "per-cell" && built.previews.length === 0) {
    return { kind: "none", reason: t("rules.autofix.couldNotApplyFixes") }
  }
  return built
}

export interface RequestSurgicalFixParams {
  rule: TranslationRule
  cell: CellData
  settings: CompletionSettings
  session: FrontierSession | null
  onLlmCall?: (meta: { kind: string; model?: string; provider: string }) => void
}

export async function requestSurgicalFix(params: RequestSurgicalFixParams): Promise<FixProposal> {
  const { rule, cell, settings, session, onLlmCall } = params
  const provider = settings.provider || "frontier"
  const model = settings.model
  let raw: string
  try {
    raw = await complete({
      settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 1024), temperature: 0.2 },
      session,
      messages: [
        { role: "system", content: PER_CELL_SYSTEM_PROMPT },
        { role: "user", content: buildPerCellUserMessage(rule, [cell]) },
      ],
    })
    onLlmCall?.({ kind: "autofix-surgical", model, provider })
  } catch {
    return { kind: "none", reason: t("rules.autofix.couldNotApplyFixes") }
  }
  const parsed = parsePerCellResponse(raw)
  if (!parsed || parsed.kind === "none") {
    return { kind: "none", reason: parsed?.reason || t("rules.autofix.couldNotApplyFixes") }
  }
  const built = buildPerCellProposal(parsed, [cell])
  if (built.kind === "per-cell" && built.previews.length === 0) {
    return { kind: "none", reason: t("rules.autofix.couldNotApplyFixes") }
  }
  return built
}
