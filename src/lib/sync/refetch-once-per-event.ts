import type { AppliedEventFrame, LiveApplier } from "./live-apply"

/** Event ids remembered before the oldest are dropped; a forgotten id only
 *  costs the read it would have saved. */
const REMEMBERED_MAX = 2000

/**
 * AQU-2655: a frame without rows is refetched once per EVENT, not once per
 * copy of its frame.
 *
 * A write of this tab reaches the live applier twice: in the POST /events
 * response (`applied[]`) and as its own socket echo. Both copies carry the
 * same event id, and both arrive after the event was projected. When the
 * frame carries rows that is harmless (the second copy re-applies the same
 * rows or is ignored by sequence), but a frame WITHOUT rows — every
 * `cell.audio.*` event, or a request over the server's rows cap — made each
 * copy call `revalidateCell`, so one write cost two `GET …/cells` of the
 * same cell. The first read already starts after the projection, so the
 * second one could only return the same rows.
 *
 * The second copy still reports "refetch" (nothing landed from the frame
 * itself), so callers that keep fallbacks for an unlanded frame keep them.
 */
export function refetchOncePerEvent(inner: LiveApplier): LiveApplier {
  const refetched = new Set<string>()
  return {
    apply(frame: AppliedEventFrame) {
      if (frame.cell && !frame.rows && refetched.has(frame.id)) return "refetch"
      const result = inner.apply(frame)
      if (result === "refetch") {
        if (refetched.size >= REMEMBERED_MAX) {
          for (const oldest of refetched) {
            refetched.delete(oldest)
            if (refetched.size < REMEMBERED_MAX / 2) break
          }
        }
        refetched.add(frame.id)
      }
      return result
    },
    reset() {
      refetched.clear()
      inner.reset()
    },
  }
}
