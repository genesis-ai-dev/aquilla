/**
 * The builder's requirements checklist (AQU-1793): before coding, the model
 * turns the user's request into numbered requirements, each must/should, and
 * marks the ones the bridge cannot support. After coding, the self-review
 * re-marks each one. Review & try shows the result, so a requirement that
 * cannot be built (e.g. alignment data, which the bridge does not expose) is
 * stated honestly instead of silently dropped.
 *
 * Shared by auth-worker (parses model output) and the SPA (renders it).
 */

export type RequirementPriority = "must" | "should"

/** planned: the coder intends to cover it (before review).
 *  covered / partial / missing: the review's verdict on the code.
 *  not_possible: the current bridge cannot support it — say why. */
export type RequirementStatus = "planned" | "covered" | "partial" | "missing" | "not_possible"

export interface ToolRequirement {
  id: number
  text: string
  priority: RequirementPriority
  status: RequirementStatus
  /** Why (for not_possible / partial / missing), or how it is covered. One short sentence. */
  note?: string
}

const STATUSES: readonly RequirementStatus[] = ["planned", "covered", "partial", "missing", "not_possible"]
export const MAX_REQUIREMENTS = 12
const MAX_TEXT = 160
const MAX_NOTE = 200

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** Validate and normalize a model-written checklist; drops malformed rows. */
export function normalizeRequirements(value: unknown): ToolRequirement[] {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { requirements?: unknown }).requirements) ? (value as { requirements: unknown[] }).requirements : []
  const out: ToolRequirement[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const text = typeof r.text === "string" ? clip(r.text, MAX_TEXT) : ""
    if (!text) continue
    const status = STATUSES.includes(r.status as RequirementStatus) ? (r.status as RequirementStatus) : "planned"
    const priority: RequirementPriority = r.priority === "should" ? "should" : "must"
    const note = typeof r.note === "string" && r.note.trim() ? clip(r.note, MAX_NOTE) : undefined
    const id = typeof r.id === "number" && Number.isFinite(r.id) ? r.id : out.length + 1
    out.push({ id, text, priority, status, ...(note ? { note } : {}) })
    if (out.length >= MAX_REQUIREMENTS) break
  }
  return out
}

/** Merge a later verdict (review / fix) into the planned list by id; unknown ids are kept as new rows. */
export function mergeRequirements(base: ToolRequirement[], verdict: ToolRequirement[]): ToolRequirement[] {
  if (verdict.length === 0) return base
  const byId = new Map(verdict.map((v) => [v.id, v]))
  const merged = base.map((b) => {
    const v = byId.get(b.id)
    if (!v) return b
    byId.delete(b.id)
    return { ...b, status: v.status, ...(v.note ? { note: v.note } : {}) }
  })
  return [...merged, ...byId.values()].slice(0, MAX_REQUIREMENTS)
}

/** Must-have requirements the code does not (fully) meet, though the bridge could. */
export function unmetMusts(reqs: ToolRequirement[]): ToolRequirement[] {
  return reqs.filter((r) => r.priority === "must" && (r.status === "missing" || r.status === "partial"))
}
