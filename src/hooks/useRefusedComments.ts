import { useEffect, useState } from "react"
import { peekOutboxBatch, subscribeToOutbox } from "@/lib/sync/outbox"
import {
  commentRefusalsIn,
  sameCommentRefusals,
  type CommentRefusal,
} from "@/lib/sync/comment-refusals"

const EMPTY: CommentRefusal[] = []

/**
 * AQU-1957: reactive view of this project's `comment.*` events the outbox has
 * given up on. See `comment-refusals.ts` for why the comment surface needs its
 * own reader rather than the generic forbidden banner: the banner says a change
 * wasn't saved, but only the event's own death tells `useComments` to take the
 * optimistic comment back out of the thread.
 *
 * Reads from the outbox (like `useRefusedFileEvents`) rather than a flush
 * callback, so a refusal is caught whichever flush path burned the record.
 */
export function useRefusedComments(projectId: string | null): CommentRefusal[] {
  const [refusals, setRefusals] = useState<CommentRefusal[]>(EMPTY)

  useEffect(() => {
    if (!projectId) {
      setRefusals(EMPTY)
      return
    }
    let cancelled = false

    async function refresh() {
      const all = await peekOutboxBatch(1000)
      if (cancelled || !projectId) return
      const next = commentRefusalsIn(all, projectId)
      setRefusals((prev) => (sameCommentRefusals(prev, next) ? prev : next))
    }

    void refresh()
    const unsub = subscribeToOutbox(() => void refresh())
    return () => {
      cancelled = true
      unsub()
    }
  }, [projectId])

  return refusals
}
