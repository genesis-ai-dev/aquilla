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
// failed query adds no lines and never fails the emit.

import { checkReferenceQuotes } from "../../../../src/lib/reference-bible/quote-check"
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

/** NEEDS REVIEW lines for staged drafts whose cited verses are not quoted from the lane's Bible. */
export async function referenceQuoteLintLines(
  db: AquillaDb,
  input: { projectId: string; lane: string; drafts: readonly StagedQuoteDraft[] },
): Promise<string[]> {
  const drafts = input.drafts.filter((d) => d.source && /\d/.test(d.source) && d.draft.trim())
  if (drafts.length === 0) return []
  try {
    const found = await loadLaneReferencePassages(db, {
      projectId: input.projectId,
      lane: input.lane,
      sources: drafts.map((d) => d.source),
    })
    if (!found?.version || found.passages.length === 0) return []
    const versionName = found.version.name
    const byCanonical = new Map(found.passages.map((p) => [p.canonical, p]))
    const lookup = (canonical: string) => byCanonical.get(canonical)?.verses.map((v) => v.text)
    const verseText = (canonical: string) => clip(lookup(canonical)?.join(" ") ?? "")

    const lines: string[] = []
    for (const d of drafts) {
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
    }
    return lines
  } catch (err) {
    console.warn("[emit-stage] reference quote lint failed:", err)
    return []
  }
}
