// The cross-cell quotation pass inside the rule engine's results (AQU-1733).
//
// The scan itself lives in db/shared/quote-continuity.ts, shared with the
// workers. This adapter turns its findings into the engine's `RuleInfraction`,
// under the project's existing `unpaired-quotes` built-in: one switch, one
// severity and one name for "a quotation mark without its partner", whether
// the partner is missing inside the cell or in a cell further down the file.
//
// It mirrors `bibleScanInfractions` (bible-check-rules.ts) — a file-level scan
// whose findings join the rule pass under a built-in rule the project already
// has — rather than adding a check id, because the finding IS the one
// `unpaired-quotes` describes and the per-cell half of it already ships.
//
// Which marks the scan reads comes from the caller: the Language profile's
// `quoteMarks` slot, or `inferQuoteMarks` reading them off the project's own
// text (AQU-1733's "no configuration" half). Nothing here is behind a flag.

import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import { hasQuotationMarks } from "@/lib/lqa/check-functions/unpaired-quotes"
import {
  scanQuoteContinuity,
  type QuoteContinuityCell,
} from "../../../db/shared/quote-continuity"
import type { QuoteMarksProfile } from "../../../db/shared/language-profile"

/** The built-in whose findings this pass extends. */
export const QUOTE_CONTINUITY_CHECK_ID = "unpaired-quotes"

/** What the pass needs from one cell of the file, in reading order. */
export interface QuoteContinuityCellInput extends QuoteContinuityCell {
  fileId: string
  /**
   * The cell's source text. Only asked whether it marks quotations at all:
   * that decides if a quotation still open where the translation stops is
   * pending or already wrong.
   */
  source?: string
}

/** Cells the file's text is read from — an untranslated cell contributes "". */
export function quoteContinuityCells(
  cells: readonly { id: string; fileId: string; original?: string; translated: string; status: string }[],
): QuoteContinuityCellInput[] {
  return cells.map((cell) => ({
    id: cell.id,
    fileId: cell.fileId,
    source: cell.original,
    text: cell.status === "empty" ? "" : cell.translated,
  }))
}

/** `cellId:start:end` — one mark at one place, however it was found. */
function placeKey(cellId: string, start: number, end: number): string {
  return `${cellId}:${start}:${end}`
}

/**
 * The file's quotation infractions, reconciled: `perCell` with the
 * `unpaired-quotes` false alarms the cross-cell walk resolves removed, and the
 * walk's own findings added.
 *
 * Two corrections, both of which need the whole file and so cannot live in
 * `checkRulesForCell`:
 *
 *  - **added** — a quotation a cell opens and no later cell closes, and a
 *    closing mark with nothing open. Anchored on the offending mark.
 *  - **withdrawn** — a mark the per-cell check reported that the file in fact
 *    pairs across cells. A verse holding only the closing mark of a speech
 *    that began earlier has an odd mark count of its own, and the check's
 *    source comparison cannot rescue it when the source marks no quotations at
 *    all — which is every Greek or Hebrew source. The same goes for the
 *    opening mark of a quotation still open where the translation stops: the
 *    walk does not report it (its closing mark may be in a verse nobody has
 *    written yet), so the per-cell check must not either — unless that cell's
 *    source marks quotations itself. The per-cell check only fires against
 *    such a source when the source closes what the translation leaves open,
 *    and that is evidence the mark is missing here, not pending. An
 *    infraction is only withdrawn when EVERY mark it names is one the walk
 *    accounted for.
 *
 * Returns `perCell` unchanged when the rule is off or the project's quotation
 * marks are unknown: with no system to read, there is nothing to reconcile.
 */
export function reconcileQuoteInfractions(
  cells: readonly QuoteContinuityCellInput[],
  rules: readonly TranslationRule[],
  marks: QuoteMarksProfile | null | undefined,
  perCell: readonly RuleInfraction[],
): RuleInfraction[] {
  if (!marks) return [...perCell]
  const rule = rules.find(
    (r) => r.enabled && r.check.type === "builtin" && r.check.checkId === QUOTE_CONTINUITY_CHECK_ID,
  )
  if (!rule) return [...perCell]

  const fileOf = new Map(cells.map((cell) => [cell.id, cell.fileId]))
  const { unclosed, strays, matched, pending } = scanQuoteContinuity(cells, marks)
  const sourceOf = new Map(cells.map((cell) => [cell.id, cell.source ?? ""]))
  const stillPending = pending.filter((place) => !hasQuotationMarks(sourceOf.get(place.cellId) ?? ""))
  const resolved = new Set(
    [...matched, ...stillPending].map((place) => placeKey(place.cellId, place.start, place.end)),
  )

  const kept = perCell.filter((infraction) => {
    if (infraction.ruleId !== rule.id) return true
    if (infraction.spans.length === 0) return true
    return !infraction.spans.every((span) =>
      resolved.has(placeKey(infraction.cellId, span.start, span.end)),
    )
  })

  // A place the surviving per-cell findings already name is not reported twice:
  // inside one cell both passes see the same missing partner.
  const seen = new Set(
    kept
      .filter((infraction) => infraction.ruleId === rule.id)
      .flatMap((infraction) => infraction.spans.map((span) => placeKey(infraction.cellId, span.start, span.end))),
  )
  const added: RuleInfraction[] = []
  const push = (cellId: string, start: number, end: number, matchedText: string) => {
    const key = placeKey(cellId, start, end)
    if (seen.has(key)) return
    seen.add(key)
    added.push({
      ruleId: rule.id,
      cellId,
      fileId: fileOf.get(cellId) ?? "",
      reason: `builtin:${QUOTE_CONTINUITY_CHECK_ID}`,
      spans: [{ side: "target", start, end, matchedText }],
    })
  }

  for (const quotation of unclosed) push(quotation.cellId, quotation.start, quotation.end, quotation.open)
  for (const stray of strays) push(stray.cellId, stray.start, stray.end, stray.close)
  return [...kept, ...added]
}
