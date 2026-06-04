// Bulk projection fold for the D1→Neon migration.
//
// The serial path (sync-worker rebuild.ts / pg-build-projections.ts) replays
// events through buildEventProjectionStmts, emitting one SQL statement per
// event and executing them one-per-round-trip. Over the WAN link to Neon that
// is ~60ms × ~8M statements ≈ days. This module instead folds each project's
// event log down to its FINAL projection rows in memory, so the bulk builder
// can COPY them to Neon in a handful of round-trips.
//
// Correctness contract: foldProjection(events) must produce the SAME cells /
// cell_validators / files / comments rows that the canonical per-event replay
// would. That is asserted byte-for-byte in fold-projection.test.ts against the
// real buildEventProjectionStmts path running on PGlite (same Postgres engine).
//
// Scope: the legacy GitLab import only emits six event kinds (verified against
// the imported 14.4M-event corpus):
//   source.cell.create, target.cell.commit, cell.validate,
//   file.create, comment.create, comment.resolve
// There are NO deletes, reorders, source-commits, unvalidates, waivers, audio,
// or backtranslations — so cells/validators are only ever added or updated,
// never removed. Any other kind throws (fail loud) rather than silently drop.

import { contentHash, CHAIN_MUTATING_KINDS } from "../../sync-worker/src/events/event-projection"

export interface FoldEvent {
  id: string
  projectId: string
  fileId: string | null
  cellId: string | null
  parentId: string | null
  kind: string
  author: string
  payload: Record<string, unknown>
  serverTs: number
  serverSeq: number
}

export type Row = Record<string, unknown>
export interface ProjectionRows {
  cells: Row[]
  cell_validators: Row[]
  files: Row[]
  comments: Row[]
}

function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

const cellKey = (projectId: string, fileId: string, cellId: string, side: string) =>
  `${projectId}\0${fileId}\0${cellId}\0${side}`
const childKey = (e: FoldEvent) =>
  `${e.projectId}\0${e.fileId ?? ""}\0${e.cellId ?? ""}\0${e.parentId ?? "<null>"}`

/**
 * Fold one project's events into final projection rows. Events may arrive in
 * any order; we sort by (server_seq, server_ts, id) to match the canonical
 * replay, then apply the AD-2 first-child-of-parent winner rule exactly as
 * rebuild.ts does.
 */
export function foldProjection(events: FoldEvent[]): ProjectionRows {
  const sorted = [...events].sort(
    (a, b) => a.serverSeq - b.serverSeq || a.serverTs - b.serverTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  const winningChildAt = new Map<string, string>()
  const cells = new Map<string, Row>()
  const validators = new Map<string, Row>()
  const files = new Map<string, Row>()
  const comments = new Map<string, Row>()

  for (const e of sorted) {
    // AD-2: first chain event at a (project,file,cell,parent) slot wins; later
    // siblings stay in the event log but never touch the projection. The guard
    // applies ONLY to chain-mutating kinds — matching the live route
    // (route.ts: `isChainMutating ? isWinningChild(...) : true`). cell.validate
    // is NOT chain-mutating, so it always projects even though it shares the
    // (cell, parent=NULL) slot with the source.cell.create. (rebuild.ts applies
    // the guard to every cell event and thus wrongly drops validates.)
    if (e.cellId && CHAIN_MUTATING_KINDS.has(e.kind)) {
      const k = childKey(e)
      const winner = winningChildAt.get(k)
      if (!winner) winningChildAt.set(k, e.id)
      else if (winner !== e.id) continue
    }
    apply(e, { cells, validators, files, comments })
  }

  // Derive cells.validated / endorsement_count from the final validator set:
  // a target cell is validated iff some validator endorses its CURRENT chain
  // head (cell_validators.event_id === cells.event_id). Mirrors the SQL the
  // cell.validate projection runs.
  const endorsements = new Map<string, number>()
  for (const v of validators.values()) {
    const k = `${v.project_id}\0${v.file_id}\0${v.cell_id}\0${v.event_id}`
    endorsements.set(k, (endorsements.get(k) ?? 0) + 1)
  }
  for (const c of cells.values()) {
    if (c.side !== "target") continue
    const n = endorsements.get(`${c.project_id}\0${c.file_id}\0${c.cell_id}\0${c.event_id}`) ?? 0
    c.endorsement_count = n
    c.validated = n > 0 ? 1 : 0
  }

  return {
    cells: [...cells.values()],
    cell_validators: [...validators.values()],
    files: [...files.values()],
    comments: [...comments.values()],
  }
}

interface State {
  cells: Map<string, Row>
  validators: Map<string, Row>
  files: Map<string, Row>
  comments: Map<string, Row>
}

function apply(e: FoldEvent, s: State): void {
  const p = e.payload
  switch (e.kind) {
    case "source.cell.create": {
      if (!e.fileId) throw new Error(`${e.kind} ${e.id} missing fileId`)
      const cellId = (p.cellId as string) ?? e.cellId
      if (!cellId) throw new Error(`${e.kind} ${e.id} missing cellId`)
      const value = (p.value as string) ?? ""
      s.cells.set(cellKey(e.projectId, e.fileId, cellId, "source"), {
        project_id: e.projectId,
        file_id: e.fileId,
        cell_id: cellId,
        side: "source",
        value,
        value_html: (p.valueHtml as string) ?? null,
        type: (p.type as string) ?? null,
        canonical_ref: (p.canonicalRef as string) ?? null,
        anchor_cell_id: (p.anchorCellId as string) ?? null,
        event_id: e.id,
        source_event_id: null,
        last_editor: e.author,
        last_edit_at: e.serverTs,
        validated: 0,
        endorsement_count: 0,
        word_count: countWords(value),
        content_hash: contentHash(value),
        start_ms: (p.startMs as number) ?? null,
        end_ms: (p.endMs as number) ?? null,
        medium: (p.medium as string) ?? null,
        sequence_index: (p.sequenceIndex as number) ?? null,
        transcription: (p.transcription as string) ?? null,
        camera_state: (p.cameraState as string) ?? null,
      })
      return
    }
    case "target.cell.commit": {
      if (!e.fileId || !e.cellId) throw new Error(`${e.kind} ${e.id} missing fileId/cellId`)
      const value = (p.value as string) ?? ""
      const key = cellKey(e.projectId, e.fileId, e.cellId, "target")
      const existing = s.cells.get(key)
      // UPSERT: first commit INSERTs the target row (start_ms/end_ms/type/etc.
      // default null since the client never emits target.cell.create); later
      // commits UPDATE the value-bearing columns and reset validation.
      const base: Row = existing ?? {
        project_id: e.projectId,
        file_id: e.fileId,
        cell_id: e.cellId,
        side: "target",
        type: null,
        canonical_ref: null,
        anchor_cell_id: null,
        start_ms: null,
        end_ms: null,
        medium: null,
        sequence_index: null,
        transcription: null,
        camera_state: null,
      }
      s.cells.set(key, {
        ...base,
        value,
        value_html: (p.valueHtml as string) ?? null,
        event_id: e.id,
        source_event_id: (p.sourceEventId as string) ?? null,
        last_editor: e.author,
        last_edit_at: e.serverTs,
        word_count: countWords(value),
        content_hash: contentHash(value),
        validated: 0,
        endorsement_count: 0,
      })
      return
    }
    case "cell.validate": {
      if (!e.fileId || !e.cellId) throw new Error(`${e.kind} ${e.id} missing fileId/cellId`)
      const key = `${e.projectId}\0${e.fileId}\0${e.cellId}\0${e.author}`
      const existing = s.validators.get(key)
      // ON CONFLICT ... WHERE excluded.decided_ts > decided_ts: only a strictly
      // newer decision overwrites.
      if (existing && !(e.serverTs > (existing.decided_ts as number))) return
      s.validators.set(key, {
        project_id: e.projectId,
        file_id: e.fileId,
        cell_id: e.cellId,
        event_id: (p.editEventId as string) ?? null,
        username: e.author,
        decided_ts: e.serverTs,
      })
      return
    }
    case "file.create": {
      if (!e.fileId) throw new Error(`file.create ${e.id} missing fileId`)
      const langMeta: Record<string, string> = {}
      if (p.sourceLanguage) langMeta.sourceLanguage = p.sourceLanguage as string
      if (p.targetLanguage) langMeta.targetLanguage = p.targetLanguage as string
      if (p.orderedBy) langMeta.orderedBy = p.orderedBy as string
      // ON CONFLICT(id) DO UPDATE name/kind/event_id/meta — last writer wins.
      s.files.set(e.fileId, {
        id: e.fileId,
        project_id: e.projectId,
        name: p.name as string,
        role: null,
        kind: (p.fileType as string) ?? null,
        book_code: null,
        source_file_id: null,
        anchor_file_id: null,
        event_id: e.id,
        cell_count: 0,
        approved_count: 0,
        word_count: 0,
        last_edit_at: null,
        created_by: e.author,
        // canonical file.create uses now(); these are import-time stamps, not
        // projection semantics, so the parity check excludes them.
        created_at: e.serverTs,
        updated_at: e.serverTs,
        meta: JSON.stringify(langMeta),
      })
      return
    }
    case "comment.create": {
      const scope = p.scope as { kind: string; fileId?: string; cellId?: string }
      const commentId = p.commentId as string
      // ON CONFLICT(comment_id) DO NOTHING — first writer wins.
      if (s.comments.has(commentId)) return
      s.comments.set(commentId, {
        comment_id: commentId,
        project_id: e.projectId,
        scope_kind: scope.kind,
        file_id: scope.kind === "cell" || scope.kind === "file" ? (scope.fileId ?? null) : null,
        cell_id: scope.kind === "cell" ? (scope.cellId ?? null) : null,
        parent_comment_id: (p.parentCommentId as string) ?? null,
        body: p.body as string,
        resolved: 0,
        author_id: e.author,
        author_label: e.author,
        created_at: e.serverTs,
        updated_at: e.serverTs,
        deleted_at: null,
      })
      return
    }
    case "comment.resolve": {
      const commentId = p.commentId as string
      const c = s.comments.get(commentId)
      // Only top-level, non-deleted comments resolve (parent_comment_id IS NULL).
      if (!c || c.parent_comment_id != null || c.deleted_at != null) return
      c.resolved = p.resolved ? 1 : 0
      c.updated_at = e.serverTs
      return
    }
    default:
      throw new Error(`foldProjection: unhandled event kind "${e.kind}" (event ${e.id})`)
  }
}
