/**
 * AQU-2673: open check flags for one book the editor does not have open.
 *
 * Called after that book's cells have loaded, while the loading toast is
 * still up, and only when the reader left "Include cells with unresolved
 * checks" off. The same project rules the open book already applied —
 * `checkRulesForCell` with the library's `rulesForCell` — decide the flags.
 * A cell this run would skip for another reason is left alone, so a rule
 * runs only where a sign-off is actually in question. The loop yields
 * between slices so a long book stays responsive.
 */
import type { CellData } from "@/hooks/useCells"
import { isUntouchedAiDraft } from "@/lib/review/batch-file-options"
import { batchValidateSkipReason, hasEnoughSignatures } from "@/lib/review/batch-validate-summary"
import type { TranslationRule } from "@/lib/parsers/types"
import type { LibraryLintResolver } from "@/lib/rules/effective-rules"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import { partitionInfractions } from "@/lib/rules/waivers"
import type { MemberScope } from "@/lib/sync/member-scopes"

/** Same budget the open file's background rule pass uses, so a book yields often enough to paint. */
const CHECK_SLICE_MS = 8

export interface OpenFlagsInBookArgs {
  cells: readonly CellData[]
  username: string
  myScopes: MemberScope[]
  activeLane: string
  allowSelfValidation?: boolean
  includeReadyCells: boolean
  /** Cells that already have enough signatures. Absent means include them. */
  includeSignedByOthers?: boolean
  /** How many signatures the project requires. Absent is 1. */
  validationCount?: number
  includeUntouchedAiDrafts: boolean
  /** Lane rules, including disabled ones. Disabled rules are not run. */
  projectRules: readonly TranslationRule[]
  rulesForCell: LibraryLintResolver["rulesForCell"]
  /** False when the library signature says no library rule can lint. */
  libraryMayLint: boolean
  now?: () => number
  yieldNow?: () => Promise<void>
  sliceMs?: number
}

function wouldSignOff(cell: CellData, args: OpenFlagsInBookArgs): boolean {
  if (batchValidateSkipReason(cell, args.username, args.myScopes, args.activeLane, {
    allowSelfValidation: args.allowSelfValidation,
  }) !== null) return false
  const untouched = isUntouchedAiDraft(cell)
  if (untouched && !args.includeUntouchedAiDrafts) return false
  if (!untouched) {
    const enough = hasEnoughSignatures(cell, args.validationCount)
    const includeSigned = args.includeSignedByOthers ?? true
    if ((enough && !includeSigned) || (!enough && !args.includeReadyCells)) return false
  }
  return true
}

function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * Cell ids in this book that carry an unresolved (non-waived) check.
 * Empty when no enabled project rule and no library rule can flag anything.
 */
export async function openFlagsInBook(args: OpenFlagsInBookArgs): Promise<ReadonlySet<string>> {
  const enabledRules = args.projectRules.filter((rule) => rule.enabled)
  if (enabledRules.length === 0 && !args.libraryMayLint) return new Set()

  const now = args.now ?? (() => performance.now())
  const yieldNow = args.yieldNow ?? yieldToPaint
  const sliceMs = args.sliceMs ?? CHECK_SLICE_MS
  const flagged = new Set<string>()
  let sliceStart = now()

  for (const cell of args.cells) {
    if (!wouldSignOff(cell, args)) continue
    const rules = args.rulesForCell(cell, cell.fileId, enabledRules)
    const found = checkRulesForCell(cell, cell.fileId, rules)
    if (found.length > 0 && partitionInfractions(found, cell.waivers).active.length > 0) {
      flagged.add(cell.id)
    }
    if (now() - sliceStart >= sliceMs) {
      await yieldNow()
      sliceStart = now()
    }
  }
  return flagged
}
