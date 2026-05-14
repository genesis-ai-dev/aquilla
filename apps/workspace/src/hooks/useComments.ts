// Phase 2b: comments dropped from v1 event grammar (see 03-data-model.md);
// stubbed. Future v1.x feature.
//
// Comments and threads were Yjs-resident in Phase 2a — extractThreadsFromCell
// walked a Y.Map<unknown> on each cell. In Phase 2b we've pulled cells out of
// Y.Doc and onto the sync-worker projection, but the v1 event grammar does
// not include `comment.*` / `thread.*` kinds (deferred to v1.x). To avoid
// shipping a half-server / half-client comments surface that users would
// expect to sync, this hook returns empty data and no-op mutators. The UI
// surface (CommentsPage, comments column in EditorTable) stays compiled and
// renders the empty-state message its existing logic already handles.

import { useMemo } from "react"
import type { CommentThread } from "@/lib/parsers/types"

export type UseCommentsApi = {
  addThread: (cellId: string, firstMessage: string) => void
  addMessage: (cellId: string, threadId: string, text: string) => void
  resolveThread: (cellId: string, threadId: string, closingMessage?: string) => void
  reopenThread: (cellId: string, threadId: string) => void
}

const NOOP_API: UseCommentsApi = {
  addThread: () => {
    /* phase 2b: comments stubbed; no-op until v1.x event grammar lands */
  },
  addMessage: () => {
    /* phase 2b: comments stubbed */
  },
  resolveThread: () => {
    /* phase 2b: comments stubbed */
  },
  reopenThread: () => {
    /* phase 2b: comments stubbed */
  },
}

/**
 * Stub: returns no-op mutators. Mutations from this hook used to push into
 * the file's Y.Doc; under Phase 2b they silently no-op. The signature is
 * preserved so ProjectWorkspace / CommentsPage compile without changes
 * until Phase 2c, when these callers move onto the outbox-based event API.
 *
 * Doc and username are accepted (and ignored) so consumers retain the
 * "doc-bound" call shape; both will be removed when the v1.x comments
 * feature lands.
 */
export function useComments(
  _doc: unknown,
  _username: string,
): UseCommentsApi & { threads: CommentThread[] } {
  // Memoize the empty array so React.memo'd consumers don't re-render on
  // every parent render due to a fresh `threads` reference.
  const threads = useMemo<CommentThread[]>(() => [], [])
  return { ...NOOP_API, threads }
}

/**
 * Stub: returns an empty thread list regardless of input. Pre-Phase 2b this
 * walked a Y.Map<unknown> off the cell; now there is no cell-level Y.Map.
 */
export function extractThreadsFromCell(_cell: unknown): CommentThread[] {
  return []
}
