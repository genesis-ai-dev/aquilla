// Pure mapping: legacy Codex comment threads (.project/comments.json) →
// Aquilla comment.create / comment.resolve events.
//
// Each legacy thread anchors to a cell via `cellId.uri` (the file path) +
// `cellId.cellId` (the cell's metadata.id = the aquilla cell_id). Deleted
// threads and deleted comments are dropped; a resolved thread emits one
// comment.resolve on the thread root. Ids are deterministic (keyed on the
// legacy comment/thread ids), so re-runs are idempotent.

import type { CodexCommentThread } from "../codex-editor/types"
import { fileIdFor, commentCreateEventId, commentResolveEventId } from "./ids"
import type { IngestEvent } from "./types"

function stemFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined
  const base = uri.split("/").pop()
  if (!base) return undefined
  return base.replace(/\.(codex|source)$/i, "")
}

export interface CommentMapOptions {
  projectId: string
  projectKey: string
  fallbackTs: number
}

export function mapComments(parsed: unknown, opts: CommentMapOptions): IngestEvent[] {
  const { projectId, projectKey, fallbackTs } = opts
  const events: IngestEvent[] = []

  // Tolerate both legacy container shapes: a JSON array of threads, or an
  // object keyed by thread id (the desktop wrote both over its history).
  const threads: CodexCommentThread[] = Array.isArray(parsed)
    ? (parsed as CodexCommentThread[])
    : parsed && typeof parsed === "object"
      ? (Object.values(parsed) as CodexCommentThread[])
      : []

  for (const thread of threads) {
    const del = thread.deletionEvent?.[thread.deletionEvent.length - 1]
    if (del?.deleted) continue

    const cellId = thread.cellId?.cellId
    const stem = stemFromUri(thread.cellId?.uri)
    if (!cellId || !stem) continue
    const fileId = fileIdFor(projectKey, stem)

    const live = (thread.comments ?? []).filter((c) => !c.deleted)
    if (live.length === 0) continue
    const rootId = live[0].id

    live.forEach((c, i) => {
      events.push({
        id: commentCreateEventId(projectId, c.id),
        kind: "comment.create",
        fileId,
        cellId,
        parentId: null,
        author: c.author?.name || "unknown",
        clientTs: typeof c.timestamp === "number" ? c.timestamp : fallbackTs,
        payload: {
          commentId: c.id,
          scope: { kind: "cell", fileId, cellId },
          body: c.body,
          parentCommentId: i === 0 ? null : rootId,
        },
      })
    })

    const res = thread.resolvedEvent?.[thread.resolvedEvent.length - 1]
    if (res?.resolved) {
      events.push({
        id: commentResolveEventId(projectId, thread.id),
        kind: "comment.resolve",
        fileId,
        cellId,
        parentId: null,
        author: res.author?.name || "unknown",
        clientTs: typeof res.timestamp === "number" ? res.timestamp : fallbackTs,
        payload: { commentId: rootId, resolved: true },
      })
    }
  }

  return events
}
