// src/lib/brief/brief.ts
import { BRIEF_FIELDS } from "./schema"
import type { BriefGroup, BriefStatus, TranslationBrief } from "./types"

/** A blank brief. version 0 mirrors the project_settings "no server row" floor. */
export function emptyBrief(author: string): TranslationBrief {
  return {
    version: 0,
    updatedAt: new Date().toISOString(),
    updatedBy: author,
    parameters: {},
    freeformNotes: "",
    l2Markdown: "",
    l1Summary: null,
    l1GeneratedAt: null,
    l1ModelId: null,
  }
}

/** Count schema fields with non-empty (trimmed) answers. */
export function filledFieldCount(brief: TranslationBrief): number {
  return BRIEF_FIELDS.reduce(
    (n, f) => n + ((brief.parameters[f.id] ?? "").trim() ? 1 : 0),
    0,
  )
}

/**
 * L1 is stale when it was never generated, or when the brief was edited after
 * the last generation. The generation flow sets l1GeneratedAt === updatedAt of
 * that same save, so a freshly generated L1 is not stale; a later content edit
 * advances updatedAt past it. ISO-8601 UTC strings compare chronologically.
 */
export function isL1Stale(brief: TranslationBrief): boolean {
  if (!brief.l1Summary || !brief.l1GeneratedAt) return true
  return brief.updatedAt > brief.l1GeneratedAt
}

/** Derived status — never stored. */
export function briefStatus(brief: TranslationBrief | null | undefined): BriefStatus {
  if (!brief) return "none"
  const allFilled = filledFieldCount(brief) === BRIEF_FIELDS.length
  if (allFilled && !isL1Stale(brief)) return "complete"
  return "draft"
}

const GROUP_HEADINGS: Record<BriefGroup, string> = {
  purpose: "Purpose & audience",
  standards: "Standards",
}

/**
 * Render the brief as a clean markdown document from the filled parameters and
 * freeform notes. Empty fields are omitted (not stubbed) so a partial brief
 * still reads cleanly. This is the canonical L2 the agent can pull on demand.
 */
export function assembleL2Markdown(brief: TranslationBrief): string {
  const parts: string[] = ["# Translation Brief"]
  for (const group of ["purpose", "standards"] as BriefGroup[]) {
    const fields = BRIEF_FIELDS.filter(
      (f) => f.group === group && (brief.parameters[f.id] ?? "").trim(),
    )
    if (!fields.length) continue
    parts.push(`## ${GROUP_HEADINGS[group]}`)
    for (const f of fields) {
      parts.push(`### ${f.label}\n${brief.parameters[f.id].trim()}`)
    }
  }
  if (brief.freeformNotes.trim()) {
    parts.push(`## Additional notes\n${brief.freeformNotes.trim()}`)
  }
  return parts.join("\n\n")
}
