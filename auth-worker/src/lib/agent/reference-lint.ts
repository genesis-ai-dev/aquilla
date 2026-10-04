// AQU-1573: the "Reference Bible quotes" check inside emit staging.
//
// The editor's built-in check warns a translator when a quoted verse does not
// match the lane's reference Bible; this is the same check (the shared
// src/lib/reference-bible/quote-check.ts) run on the agent's staged drafts, so
// the MODEL sees a NEEDS REVIEW line and can redraft before a human reads the
// proposal. Kept out of lint.ts, which stays pure regex over project rules:
// this one needs a database read for the verses.
//
// One passage lookup covers every staged commit. Best-effort like the rest of
// staging lint: a lane with no Bible, a Bible that is not installed, or a
// failed query adds no quote lines and never fails the emit.
//
// A draft that leaves out a reference the source cites (its chapter and verse
// numbers, reference-kept.ts) gets a NEEDS REVIEW line too. That needs no
// verse text, so it is checked on every lane, Bible or not.

import { checkReferenceQuotes } from "../../../../src/lib/reference-bible/quote-check"
import { findDroppedReferences } from "../../../../src/lib/reference-bible/reference-kept"
import { loadLaneReferencePassages } from "./reference-bible"

/** One staged target.cell.commit, as the lint needs it. */
export interface StagedQuoteDraft {
  /** How the verdict block names the cell (its canonicalRef or "#<index>"). */
  ref: string
  source: string
  draft: string
}

/** The verse text a NEEDS REVIEW line quotes back is cut at this length. */
const MAX_QUOTED_CHARS = 400

function clip(text: string): string {
  return text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}…` : text
}

/** NEEDS REVIEW lines for a staged draft that leaves out a reference its source cites. */
function droppedReferenceLines(d: StagedQuoteDraft): string[] {
  return findDroppedReferences(d.source, d.draft).map(
    (f) =>
      `NEEDS REVIEW ${d.ref}: the source cites ${f.label} but the draft leaves out the reference — keep its chapter and verse numbers in the translation`,
  )
}

/** NEEDS REVIEW lines for staged drafts whose cited verses are not quoted from the lane's Bible, or whose references are left out. */
export async function referenceQuoteLintLines(
  db: AquillaDb,
  input: { projectId: string; lane: string; drafts: readonly StagedQuoteDraft[] },
): Promise<string[]> {
  const drafts = input.drafts.filter((d) => d.source && /\d/.test(d.source) && d.draft.trim())
  if (drafts.length === 0) return []
  const quoteLines = await quoteMismatchLines(db, { ...input, drafts })
  const lines: string[] = []
  for (const d of drafts) lines.push(...(quoteLines.get(d) ?? []), ...droppedReferenceLines(d))
  return lines
}

/** The quote lines per draft, from the lane's Bible; empty when the lane has none or the lookup fails. */
async function quoteMismatchLines(
  db: AquillaDb,
  input: { projectId: string; lane: string; drafts: readonly StagedQuoteDraft[] },
): Promise<Map<StagedQuoteDraft, string[]>> {
  const out = new Map<StagedQuoteDraft, string[]>()
  try {
    const found = await loadLaneReferencePassages(db, {
      projectId: input.projectId,
      lane: input.lane,
      sources: input.drafts.map((d) => d.source),
    })
    if (!found?.version || found.passages.length === 0) return out
    const versionName = found.version.name
    const byCanonical = new Map(found.passages.map((p) => [p.canonical, p]))
    const lookup = (canonical: string) => byCanonical.get(canonical)?.verses.map((v) => v.text)
    const verseText = (canonical: string) => clip(lookup(canonical)?.join(" ") ?? "")

    for (const d of input.drafts) {
      const lines: string[] = []
      for (const f of checkReferenceQuotes(d.source, d.draft, lookup)) {
        if (f.kind === "differs") {
          lines.push(
            `NEEDS REVIEW ${d.ref}: Scripture quote ${f.label} does not match ${versionName} word for word — copy the quoted words exactly from it: "${verseText(f.canonical)}"`,
          )
        } else {
          lines.push(
            `NEEDS REVIEW ${d.ref}: the source quotes ${f.labels.join(", ")} but the draft does not use the ${versionName} wording — copy it from ${versionName}: "${verseText(f.canonicals[0])}"`,
          )
        }
      }
      if (lines.length > 0) out.set(d, lines)
    }
    return out
  } catch (err) {
    console.warn("[emit-stage] reference quote lint failed:", err)
    return new Map()
  }
}
