import type { RuleAutofix } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

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
    return { kind: "none", reason: typeof obj.reason === "string" ? obj.reason : "No reason given" }
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
    return { kind: "none", reason: typeof obj.reason === "string" ? obj.reason : "No reason given" }
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
