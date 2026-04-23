import type { RuleAutofix } from "@/lib/parsers/types"

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
