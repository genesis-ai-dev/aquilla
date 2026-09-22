import { buildCellData, type CellData } from "@/hooks/useCells"
import { getSessionRevision, loadSession } from "@/lib/frontier/session-store"
import {
  fetchContextualDrafts,
  fetchContextualRunActivity,
  ContextualAuthError,
  type ContextualDraftRecord,
  type ContextualRunRecord,
} from "@/lib/contextual/transport"
import { fetchAllFileCells, fetchCellsByIds, fetchFile } from "@/lib/sync/cells-read"
import type { CellRow, FileSummary } from "@/lib/sync/cells-read-types"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import { canPerform } from "@/lib/sync/role-policy"
import { emitCellValidate, emitTargetCellCommit } from "@/lib/sync/events-emit"
import { flushOutboxBatch } from "@/lib/sync/outbox-flush"
import { getOutboxRecords } from "@/lib/sync/outbox"
import { fetchProjectSettingsResult } from "@/lib/sync/project-settings"
import { shouldAutoValidateHumanEdit } from "@/lib/review/auto-validation"
import { resolveIdmlEditorConfiguration, validateIdmlEditorCommit } from "@/lib/richtext/idml-editor"

export class DraftReviewError extends Error {
  readonly code: "stale" | "queued" | "locked" | "unavailable" | "readOnly" | "rejected"
  constructor(code: DraftReviewError["code"]) {
    super(code)
    this.code = code
  }
}

export interface DraftReviewSnapshot {
  file: FileSummary
  drafts: ContextualDraftRecord[]
  cells: ReadonlyMap<string, CellData>
  documentOrder: ReadonlyMap<string, number>
  roleLevel: number
  username: string
}

export function reviewCell(rows: CellRow[], cellId: string, fileId: string, lane: string, username: string): CellData {
  return buildCellData(
    cellId,
    rows.find((row) => row.cellId === cellId && row.side === "source"),
    rows.find((row) => row.cellId === cellId && row.side === "target" && (row.targetLang ?? "") === lane),
    fileId, username, 1, undefined,
  )
}

async function reviewSession() {
  const session = await loadSession()
  if (!session?.jwt) throw new ContextualAuthError()
  return session
}

export async function loadDraftReview(projectId: string, run: ContextualRunRecord): Promise<DraftReviewSnapshot> {
  const session = await reviewSession()
  const lane = run.targetLang ?? ""
  const mint = await fetchSyncToken(session.jwt, projectId, run.fileId)
  const [file, allDrafts, activity] = await Promise.all([
    fetchFile(projectId, run.fileId, mint.token),
    fetchContextualDrafts(projectId, run.fileId, lane),
    // The file-list helper deliberately treats 404/501 as []; review must not
    // turn an unavailable backend into a false "everything reviewed" state.
    fetchContextualRunActivity(projectId, run.runId, { draftStatus: "proposed", draftLimit: 1 }),
  ])
  if (!activity.run || activity.run.runId !== run.runId || activity.run.fileId !== run.fileId ||
    (activity.run.targetLang ?? "") !== lane || file.fileId !== run.fileId || file.projectId !== projectId) {
    throw new DraftReviewError("unavailable")
  }
  if (file.deletedAt) throw new DraftReviewError("unavailable")
  if (allDrafts.some((draft) => !draft.runId)) throw new DraftReviewError("unavailable")
  const drafts = allDrafts.filter((draft) => draft.runId === run.runId)
  if (drafts.length === 0 && (activity.draftCounts?.proposed ?? 0) > 0) {
    throw new DraftReviewError("unavailable")
  }
  const [rows, sourceRows] = drafts.length
    ? await Promise.all([
      fetchCellsByIds(projectId, run.fileId, drafts.map((draft) => draft.cellId), mint.token, lane || undefined),
      // Targeted reads preserve REQUEST order, not document order. The source
      // stream is the same paginated anchor-chain order used by the editor.
      fetchAllFileCells(projectId, run.fileId, mint.token, "source", lane || undefined),
    ])
    : [[], []]
  return {
    file, drafts: allDrafts, roleLevel: mint.role.level, username: session.username,
    documentOrder: new Map(sourceRows.map((row, index) => [row.cellId, index])),
    cells: new Map(drafts.map((draft) => [
      draft.cellId, reviewCell(rows, draft.cellId, run.fileId, lane, session.username),
    ])),
  }
}

export interface DraftReviewCommit {
  eventId: string
  value: string
  validationEventId?: string
  validationNeeded: boolean
  /** Authentication revision at enqueue; a retry must never cross accounts. */
  sessionRevision: number
}

interface AcceptDraftArgs {
  projectId: string
  run: ContextualRunRecord
  draft: ContextualDraftRecord
  cell: CellData
  text: string
  /** Store immediately after durable enqueue, including when upload fails. */
  onQueued: (commit: DraftReviewCommit) => void
  queued?: DraftReviewCommit
  checkLock: () => boolean
  isCurrent: () => boolean
}

/** The same typed event → durable outbox → projection path as a human edit.
 * Never PATCH a proposal, mark it applied, or mutate run ownership/leases. */
export async function acceptDraftReview(args: AcceptDraftArgs): Promise<void> {
  const { projectId, run, draft, cell, onQueued } = args
  const lane = run.targetLang ?? ""
  const revision = getSessionRevision()
  const session = await reviewSession()
  const mint = await fetchSyncToken(session.jwt, projectId, run.fileId)
  const assertCurrent = () => {
    if (!args.isCurrent() || revision !== getSessionRevision()) throw new DraftReviewError("stale")
    if (args.checkLock()) throw new DraftReviewError("locked")
  }
  assertCurrent()
  if (!canPerform("target.cell.commit", mint.role.level)) throw new DraftReviewError("readOnly")
  let queued = args.queued
  if (queued && queued.sessionRevision !== revision) throw new DraftReviewError("stale")
  if (!queued) {
    const [drafts, rows, settings] = await Promise.all([
      fetchContextualDrafts(projectId, run.fileId, lane),
      fetchCellsByIds(projectId, run.fileId, [draft.cellId], mint.token, lane || undefined),
      fetchProjectSettingsResult(session.jwt, projectId),
    ])
    assertCurrent()
    if (!settings.ok) throw new Error(settings.message)
    const current = drafts.find((entry) => entry.draftId === draft.draftId && entry.runId === run.runId)
    const fresh = reviewCell(rows, draft.cellId, run.fileId, lane, session.username)
    if (!current || current.cellId !== draft.cellId || current.text !== draft.text ||
      !fresh.sourceEventId || fresh.sourceEventId !== cell.sourceEventId ||
      fresh.targetEventId !== cell.targetEventId) {
      throw new DraftReviewError("stale")
    }
    const invalid = validateIdmlEditorCommit(
      resolveIdmlEditorConfiguration(fresh.metadata, fresh.originalHtml), args.text,
    )
    if (invalid) throw new Error(invalid)
    const eventId = await emitTargetCellCommit({
      projectId, fileId: run.fileId, cellId: draft.cellId,
      parentId: fresh.targetEventId ?? fresh.sourceEventId ?? null,
      sourceEventId: fresh.sourceEventId,
      value: args.text, valueHtml: args.text, author: session.username, targetLang: lane,
    })
    queued = {
      eventId,
      value: args.text,
      sessionRevision: revision,
      validationNeeded: settings.value !== null && shouldAutoValidateHumanEdit({
        value: args.text,
        canValidate: canPerform("cell.validate", mint.role.level),
        allowSelfValidation: settings.value.settings.allowSelfValidation,
        roleLevel: mint.role.level,
      }),
    }
    onQueued(queued)
  }

  let refused = false
  let stale = false
  const getTokenForFile = async (eventProject: string, eventFile: string) => {
    assertCurrent()
    const token = await fetchSyncToken(session.jwt, eventProject, eventFile)
    assertCurrent()
    return { token: token.token, status: 200 }
  }
  const outcome = await flushOutboxBatch({
    getTokenForFile,
    onRejected: (entries) => { refused ||= entries.some((entry) =>
      entry.id === queued.eventId || entry.id === queued.validationEventId,
    ) },
    onStaleSiblings: (entries) => { stale ||= entries.some((entry) => entry.id === queued.eventId) },
    onStaleSource: (entries) => { stale ||= entries.some((entry) => entry.id === queued.eventId) },
  })
  if (stale) throw new DraftReviewError("stale")
  if (refused) throw new DraftReviewError("rejected")
  const remaining = await getOutboxRecords([queued.eventId])
  if (remaining.some((record) => record.status === "failed")) throw new DraftReviewError("rejected")
  if (outcome.networkError || outcome.authError || remaining.length) {
    throw new DraftReviewError("queued")
  }
  assertCurrent()
  const rows = await fetchCellsByIds(projectId, run.fileId, [draft.cellId], mint.token, lane || undefined)
  assertCurrent()
  const confirmed = reviewCell(rows, draft.cellId, run.fileId, lane, session.username)
  if (confirmed.targetEventId !== queued.eventId) throw new DraftReviewError("stale")
  if (queued.validationNeeded) {
    if (!queued.validationEventId) {
      queued.validationEventId = await emitCellValidate({
        projectId, fileId: run.fileId, cellId: draft.cellId,
        editEventId: queued.eventId, author: session.username, targetLang: lane,
      })
      onQueued({ ...queued })
    }
    const validation = await flushOutboxBatch({
      getTokenForFile,
      onRejected: (entries) => { refused ||= entries.some((entry) => entry.id === queued.validationEventId) },
    })
    if (refused || validation.networkError || validation.authError ||
      (await getOutboxRecords([queued.validationEventId])).length) throw new DraftReviewError("queued")
  }
}
