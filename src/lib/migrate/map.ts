// Pure mapping: legacy Codex source/target notebooks → a deterministic,
// idempotent stream of Aquilla events.
//
// Per file pair:
//   file.create                           (one)
//   source.cell.create                    (one per cell, in canonical order)
//   target.cell.commit                    (one per value-edit — full history,
//                                          original author + legacy timestamp)
//
// Pairing: source (.source) and target (.codex) cells share `metadata.id`.
// Canonical order + structural (milestone) cells come from the target file;
// the source side is matched in by id. Ids are deterministic (see ids.ts), so
// re-running yields the identical stream — the server's INSERT OR IGNORE makes
// the whole thing idempotent.

import type { CodexNotebookFile, CodexCell, EditHistory } from "../codex-editor/types"
import {
  fileIdFor,
  fileCreateEventId,
  sourceCellCreateEventId,
  targetCommitEventId,
  validateEventId,
} from "./ids"
import type { IngestEvent } from "./types"

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
}

function canonicalRefOf(cell: CodexCell): string | undefined {
  const gr = cell.metadata.data?.globalReferences
  if (gr && gr.length > 0) return gr[0]
  return cell.metadata.cellLabel ?? undefined
}

function earliestEditTs(cell: CodexCell | undefined): number | undefined {
  const edits = cell?.metadata.edits
  if (!edits || edits.length === 0) return undefined
  let min = Infinity
  for (const e of edits) {
    if (typeof e.timestamp === "number" && e.timestamp < min) min = e.timestamp
  }
  return Number.isFinite(min) ? min : undefined
}

const isValueEdit = (e: EditHistory): boolean => e.editMap?.[0] === "value"
const editValueHtml = (e: EditHistory): string =>
  typeof e.value === "string" ? e.value : String(e.value ?? "")

export interface FilePairInput {
  /** Stem shared by the source/target pair (UUID suffix included), used for
   *  the deterministic file id and as the display name, e.g.
   *  "TheChosen_101_en_52-aa53cdc6-17ed-4420-8466-a0746b". */
  relPath: string
  name: string
  /** Parsed `.source` notebook (absent for target-only files). */
  source?: CodexNotebookFile
  /** Parsed `.codex` notebook (absent for source-only files). */
  target?: CodexNotebookFile
}

export interface MapOptions {
  projectId: string
  projectKey: string
  sourceLanguage?: string
  targetLanguage?: string
  /** `author` for synthetic events (file.create, source.cell.create) and the
   *  fallback when an edit carries no author (mirrors mapEditHistory's
   *  "git-import" default). */
  fallbackAuthor: string
  /** `clientTs` for synthetic events lacking a legacy timestamp. */
  fallbackTs: number
}

/** Map one source/target file pair to its deterministic event stream. */
export function mapFilePairToEvents(pair: FilePairInput, opts: MapOptions): IngestEvent[] {
  const { projectId, projectKey, fallbackAuthor, fallbackTs } = opts
  const fileId = fileIdFor(projectKey, pair.relPath)
  const events: IngestEvent[] = []

  events.push({
    id: fileCreateEventId(projectId, fileId),
    kind: "file.create",
    fileId,
    cellId: null,
    parentId: null,
    author: fallbackAuthor,
    clientTs: fallbackTs,
    payload: {
      name: pair.name,
      fileType: "codex",
      ...(opts.sourceLanguage ? { sourceLanguage: opts.sourceLanguage } : {}),
      ...(opts.targetLanguage ? { targetLanguage: opts.targetLanguage } : {}),
    },
  })

  const orderedCells = pair.target?.cells ?? pair.source?.cells ?? []
  const sourceById = new Map<string, CodexCell>()
  for (const c of pair.source?.cells ?? []) sourceById.set(c.metadata.id, c)
  const targetById = new Map<string, CodexCell>()
  for (const c of pair.target?.cells ?? []) targetById.set(c.metadata.id, c)

  let prevCellId: string | null = null
  for (const ordered of orderedCells) {
    const cellId = ordered.metadata.id
    const s = sourceById.get(cellId)
    const t = targetById.get(cellId)
    const anchorCell = s ?? t ?? ordered

    // Source text: the paired source value, falling back to the cell's own
    // value (so structural/milestone cells still carry a label on the source
    // side) and finally empty.
    const srcHtml = s?.value ?? ordered.value ?? ""
    const srcCreateId = sourceCellCreateEventId(projectId, fileId, cellId)
    events.push({
      id: srcCreateId,
      kind: "source.cell.create",
      fileId,
      cellId,
      parentId: null,
      author: fallbackAuthor,
      clientTs: earliestEditTs(s) ?? fallbackTs,
      payload: {
        cellId,
        anchorCellId: prevCellId,
        value: stripHtml(srcHtml),
        ...(srcHtml ? { valueHtml: srcHtml } : {}),
        type: anchorCell.metadata.type,
        ...(canonicalRefOf(anchorCell) ? { canonicalRef: canonicalRefOf(anchorCell) } : {}),
        ...(anchorCell.metadata.data ? { metadata: anchorCell.metadata.data } : {}),
      },
    })
    prevCellId = cellId

    if (!t) continue

    const valueEdits = (t.metadata.edits ?? [])
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => isValueEdit(e))

    if (valueEdits.length === 0) {
      // No value-history. Emit one synthetic commit for a real (non-structural)
      // translation that exists but predates the edit ledger; skip milestones.
      if (t.value && t.value.trim() !== "" && t.metadata.type !== "milestone") {
        events.push({
          id: targetCommitEventId(projectId, fileId, cellId, 0),
          kind: "target.cell.commit",
          fileId,
          cellId,
          parentId: srcCreateId,
          author: fallbackAuthor,
          clientTs: fallbackTs,
          payload: { value: stripHtml(t.value), valueHtml: t.value, sourceEventId: srcCreateId },
        })
      }
      continue
    }

    // Full history: one commit per value-edit, chained. First parent is the
    // source create (establishing the AD-9 source pin); then each prior commit.
    let parent = srcCreateId
    let headEdit: EditHistory | undefined
    for (const { e, i } of valueEdits) {
      const html = editValueHtml(e)
      const id = targetCommitEventId(projectId, fileId, cellId, i)
      events.push({
        id,
        kind: "target.cell.commit",
        fileId,
        cellId,
        parentId: parent,
        author: e.author || fallbackAuthor,
        clientTs: typeof e.timestamp === "number" ? e.timestamp : fallbackTs,
        payload: { value: stripHtml(html), valueHtml: html, sourceEventId: srcCreateId },
      })
      parent = id
      headEdit = e
    }

    // Validations: only those on the HEAD value-edit "stick" — the projection
    // flips cells.validated to 1 only when editEventId == the cell's current
    // chain head (= the last commit, `parent`). Original validator + timestamp
    // preserved; soft-deleted validators are dropped.
    for (const v of headEdit?.validatedBy ?? []) {
      if (v.isDeleted) continue
      events.push({
        id: validateEventId(projectId, fileId, cellId, v.username),
        kind: "cell.validate",
        fileId,
        cellId,
        parentId: null,
        author: v.username,
        clientTs: typeof v.creationTimestamp === "number" ? v.creationTimestamp : fallbackTs,
        payload: { editEventId: parent },
      })
    }
  }

  return events
}
