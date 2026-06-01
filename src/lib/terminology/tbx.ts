/**
 * TBX-Basic import / export for Concept[].
 *
 * Implements minimal TBX-Basic (ISO 30042) sufficient for round-tripping
 * concept entries with preferred/admitted/forbidden renderings and notes.
 *
 * Export shape (abridged):
 *   <martif type="TBX-Basic" xml:lang="en">
 *     <text><body>
 *       <termEntry id="...">
 *         <descrip type="subjectField">terminology</descrip>
 *         <note>...</note>             <!-- concept.notes -->
 *         <langSet xml:lang="source">
 *           <tig><term>...</term></tig>  <!-- concept.sourceTerm -->
 *         </langSet>
 *         <langSet xml:lang="target">
 *           <tig>
 *             <term>...</term>
 *             <termNote type="administrativeStatus">preferredTerm-admn-sts</termNote>
 *           </tig>
 *           ...
 *         </langSet>
 *       </termEntry>
 *     </body></text>
 *   </martif>
 *
 * TBX administrative-status mapping:
 *   preferred → "preferredTerm-admn-sts"
 *   admitted  → "admittedTerm-admn-sts"
 *   forbidden → "deprecatedTerm-admn-sts"
 *
 * Import is lenient: it reads any TBX-like XML looking for <termEntry>, <term>,
 * and <termNote type="administrativeStatus"> elements. The first langSet is
 * treated as source; subsequent langSets as target. Missing status defaults to
 * "preferred".
 */

import { v4 as uuid } from "uuid"
import type { Concept, TermRendering, RenderingStatus } from "./types"

// ---------------------------------------------------------------------------
// TBX administrative-status ↔ RenderingStatus mapping
// ---------------------------------------------------------------------------

const STATUS_TO_TBX: Record<RenderingStatus, string> = {
  preferred: "preferredTerm-admn-sts",
  admitted: "admittedTerm-admn-sts",
  forbidden: "deprecatedTerm-admn-sts",
}

// Keys are lowercase for lookup after .toLowerCase() on the raw TBX value.
const TBX_TO_STATUS: Record<string, RenderingStatus> = {
  "preferredterm-admn-sts": "preferred",
  "admittedterm-admn-sts": "admitted",
  "deprecatedterm-admn-sts": "forbidden",
  // common aliases (also lowercased)
  preferred: "preferred",
  admitted: "admitted",
  deprecated: "forbidden",
  forbidden: "forbidden",
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Export Concept[] to a minimal TBX-Basic XML string. */
export function exportConceptsTbx(concepts: Concept[]): string {
  const entries = concepts.map((c) => termEntry(c)).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE martif SYSTEM "TBXBasiccoreStructV02.dtd">
<martif type="TBX-Basic" xml:lang="en">
  <martifHeader>
    <fileDesc>
      <sourceDesc><p>Exported from Aquilla</p></sourceDesc>
    </fileDesc>
  </martifHeader>
  <text>
    <body>
${entries}
    </body>
  </text>
</martif>`
}

function termEntry(c: Concept): string {
  const note = c.notes ? `\n      <note>${xmlEscape(c.notes)}</note>` : ""
  const sourceLang = `\n      <langSet xml:lang="source">\n        <tig><term>${xmlEscape(c.sourceTerm)}</term></tig>\n      </langSet>`
  const targetTigs = c.renderings
    .map(
      (r) =>
        `        <tig>\n          <term>${xmlEscape(r.rendering)}</term>\n          <termNote type="administrativeStatus">${STATUS_TO_TBX[r.status]}</termNote>\n        </tig>`,
    )
    .join("\n")
  const targetLang =
    c.renderings.length > 0
      ? `\n      <langSet xml:lang="target">\n${targetTigs}\n      </langSet>`
      : ""
  return `    <termEntry id="${xmlAttr(c.id)}">${note}${sourceLang}${targetLang}\n    </termEntry>`
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Parse a TBX XML string into Concept[].
 *
 * Uses a simple regex-based parser — no DOM dependency — sufficient for
 * well-formed TBX-Basic files. Malformed XML produces best-effort output.
 */
export function importConceptsTbx(xml: string): Concept[] {
  const concepts: Concept[] = []
  const now = new Date().toISOString()

  // Extract all <termEntry> blocks.
  const entryRe = /<termEntry[^>]*>([\s\S]*?)<\/termEntry>/g
  let entryMatch: RegExpExecArray | null
  while ((entryMatch = entryRe.exec(xml)) !== null) {
    const block = entryMatch[1]

    // concept-level id from the opening tag.
    const idMatch = entryMatch[0].match(/\bid="([^"]*)"/)
    const conceptId = idMatch ? idMatch[1] : uuid()

    // notes: first <note> inside termEntry.
    const noteMatch = block.match(/<note[^>]*>([\s\S]*?)<\/note>/)
    const notes = noteMatch ? xmlUnescape(noteMatch[1].trim()) : undefined

    // Collect langSets in order: first = source, rest = target.
    const langSets: Array<{ lang: string; tigs: Array<{ term: string; status?: string }> }> = []
    const langSetRe = /<langSet[^>]*>([\s\S]*?)<\/langSet>/g
    let lsMatch: RegExpExecArray | null
    while ((lsMatch = langSetRe.exec(block)) !== null) {
      const lsAttr = lsMatch[0].match(/xml:lang="([^"]*)"/)
      const lang = lsAttr ? lsAttr[1] : "unknown"
      const tigs: Array<{ term: string; status?: string }> = []
      const tigRe = /<tig[^>]*>([\s\S]*?)<\/tig>/g
      let tigMatch: RegExpExecArray | null
      while ((tigMatch = tigRe.exec(lsMatch[1])) !== null) {
        const tigBlock = tigMatch[1]
        const termMatch = tigBlock.match(/<term[^>]*>([\s\S]*?)<\/term>/)
        if (!termMatch) continue
        const term = xmlUnescape(termMatch[1].trim())
        const statusMatch = tigBlock.match(
          /<termNote[^>]*type="administrativeStatus"[^>]*>([\s\S]*?)<\/termNote>/,
        )
        const status = statusMatch ? statusMatch[1].trim() : undefined
        tigs.push({ term, status })
      }
      langSets.push({ lang, tigs })
    }

    if (langSets.length === 0) continue
    const sourceTerm = langSets[0].tigs[0]?.term
    if (!sourceTerm) continue

    const renderings: TermRendering[] = []
    for (const ls of langSets.slice(1)) {
      for (const tig of ls.tigs) {
        if (!tig.term) continue
        const rawStatus = tig.status?.toLowerCase() ?? ""
        const status: RenderingStatus = TBX_TO_STATUS[rawStatus] ?? "preferred"
        renderings.push({ rendering: tig.term, status })
      }
    }

    concepts.push({
      id: conceptId,
      sourceTerm,
      renderings,
      notes: notes || undefined,
      status: "active",
      createdAt: now,
    })
  }

  return concepts
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function xmlAttr(s: string): string {
  return s.replace(/"/g, "&quot;")
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}
