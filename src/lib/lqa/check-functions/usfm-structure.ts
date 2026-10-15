import type { InfractionSpan } from "@/lib/parsers/types"
import { checkUsfmMarkers, looksLikeUsfm } from "@/lib/parsers/usfm-structure-check"

export const MESSAGE = "Unrecognized or unclosed USFM marker in the translation"

/**
 * The live half of AQU-1731: the marker checks run on every commit, so a
 * problem introduced while editing is flagged on the cell rather than waiting
 * for the next import or export.
 *
 * Only the MARKER codes apply here. A cell carries verse body text, not the
 * `\c`/`\v` spine, so chapter/verse numbering is a whole-file question and
 * stays on the import path (`checkUsfmStructure`).
 *
 * `looksLikeUsfm` is the guard that keeps this off non-scripture projects: a
 * software-localization cell containing a literal `\n`, or a Windows path like
 * `C:\temp\file`, tokenizes as marker-shaped runs that no taxonomy models.
 * Requiring at least one marker the taxonomy DOES model means those cells are
 * skipped entirely instead of being reported as a wall of unknown markers.
 */
export function runCheck(source: string, target: string): InfractionSpan[] | null {
  if (!target.trim()) return null
  if (!looksLikeUsfm(target) && !looksLikeUsfm(source)) return null

  const spans: InfractionSpan[] = []
  for (const finding of checkUsfmMarkers(target)) {
    const matchedText = finding.detail
    const start = Math.min(finding.offset, target.length)
    spans.push({
      side: "target",
      start,
      end: Math.min(start + matchedText.length, target.length),
      matchedText,
    })
  }
  return spans.length > 0 ? spans : null
}
