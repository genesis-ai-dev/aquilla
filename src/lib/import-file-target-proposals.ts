/**
 * AQU-1673 — stage a file-scoped target import as PROPOSALS instead of
 * committing it.
 *
 * Partners often already hold candidate translations for a file (an earlier
 * tool, a consultant, an external MT pass) and want them reviewed, not
 * written. The direct importer (`applyEBibleTargetImport`) emits
 * `target.cell.commit` straight into the outbox — the text lands as committed
 * target text. This path instead compiles the SAME matched rows into
 * `SetTranslation` commands and stages ONE changeset through the session
 * changeset route, so every value arrives as a staged proposal behind the
 * human approval gate and is approved exactly like an agent proposal.
 *
 * Two deliberate differences from the direct path:
 *
 * 1. **No optimistic patch.** Nothing is committed, so the editor must keep
 *    showing the current translations. Painting proposals into cells would be
 *    the exact lie this feature exists to avoid.
 * 2. **No AD-2 parent handling.** The direct path has to chain each commit on
 *    the cell's current head (and AQU-1669 is what dropping an unchainable
 *    cell quietly cost). Prepare computes preconditions from the live heads
 *    server-side, so there is no parent to resolve here and no unchainable
 *    class of cell — a head that moves before approval surfaces as the
 *    changeset going `stale`, which is the gate working.
 */

import { prepareSessionChangeset, type SetTranslationCommandInput } from "@/lib/agent/changeset-api"
import { t } from "@/lib/i18n/standalone"
import type { FileTargetMatchedCell } from "@/lib/import-file-target"

/** Longest `fileName` the worker accepts on import provenance — mirrors
 *  sync-worker's `IMPORTED_ORIGIN_FILENAME_MAX`. Over-long upload names are
 *  trimmed here rather than failing a whole staging on validation. */
export const IMPORT_ORIGIN_FILENAME_MAX = 256

export interface StageTargetProposalsResult {
  /** Cells staged as proposals in the changeset. */
  stagedCount: number
  /** Cells dropped because the incoming value already equals the current
   *  translation — a no-op proposal is noise in a reviewer's queue. */
  skippedUnchangedCount: number
  /** The staged changeset's id, or null when every row was a no-op (nothing
   *  was staged, so there is no changeset to review). */
  changesetId: string | null
}

/** True when the incoming value would not change the cell. Compared on
 *  trimmed text: the importers already trim incoming rows, and a difference of
 *  trailing whitespace alone is not a translation a reviewer should be asked
 *  to approve. */
export function isUnchangedProposal(cell: Pick<FileTargetMatchedCell, "incomingText" | "currentText">): boolean {
  return cell.incomingText.trim() === cell.currentText.trim()
}

/**
 * Stage the selected matched cells as one changeset of proposals.
 *
 * `selectedCellIds` is the set the user ticked in the review step — the same
 * input the direct path takes, so the two modes review identically and differ
 * only in where the text lands.
 */
export async function stageTargetImportAsProposals(
  matched: readonly FileTargetMatchedCell[],
  selectedCellIds: Set<string>,
  ctx: {
    jwt: string
    projectId: string
    /** Destination lane; empty/absent means the project's default lane. */
    targetLang?: string
    /** Name of the uploaded file, recorded as each proposal's provenance. */
    sourceFileName: string
  },
): Promise<StageTargetProposalsResult> {
  const selected = matched.filter((m) => selectedCellIds.has(m.cellId))
  const toStage = selected.filter((m) => !isUnchangedProposal(m))
  const skippedUnchangedCount = selected.length - toStage.length

  if (toStage.length === 0) {
    return { stagedCount: 0, skippedUnchangedCount, changesetId: null }
  }

  // One timestamp for the whole import: every proposal in this changeset came
  // from the same upload, so they share one provenance stamp.
  const importOrigin = {
    fileName: ctx.sourceFileName.slice(0, IMPORT_ORIGIN_FILENAME_MAX),
    importedAt: Date.now(),
  }
  const commands: SetTranslationCommandInput[] = toStage.map((cell) => ({
    kind: "SetTranslation",
    fileId: cell.fileId,
    cellId: cell.cellId,
    value: cell.incomingText,
    // Omit for the default lane — the worker rejects '' as a lane id.
    ...(ctx.targetLang ? { laneId: ctx.targetLang } : {}),
    importOrigin,
  }))

  const changeset = await prepareSessionChangeset(ctx.jwt, ctx.projectId, commands)
  if (changeset.status !== "staged") {
    // Prepare answered, but not with a reviewable plan (e.g. it came back
    // already stale). Nothing is written either way; say so rather than
    // reporting a staging the reviewer will never find in their queue.
    throw new Error(t("importExport.proposals.notStaged", { status: changeset.status }))
  }
  return {
    stagedCount: toStage.length,
    skippedUnchangedCount,
    changesetId: changeset.id,
  }
}
