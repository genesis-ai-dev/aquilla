import { useEffect, useRef } from "react"

/**
 * Fire `onDrained` exactly once each time `pendingCount` transitions from a
 * positive value down to zero *for the same `key`* — i.e. the moment a batch of
 * queued work finishes draining.
 *
 * Used to trigger a single soft refetch after a bulk import's outbox commits
 * land, so the read model reconciles with the server projection without a
 * per-item fan-out. A starting value of 0 is not a drain (there was no prior
 * work), and a steady 0 never re-fires.
 *
 * `key` scopes the drain to one subject (e.g. the active file id). When it
 * changes, the count typically drops to another subject's value (often 0);
 * that is a subject switch, not a drain, so the baseline resets *without*
 * firing. Only a >0 → 0 transition while `key` stays constant counts.
 */
export function useReconcileOnDrain(
  pendingCount: number,
  key: string | null | undefined,
  onDrained: () => void,
): void {
  const prevRef = useRef(pendingCount)
  const keyRef = useRef(key)
  const onDrainedRef = useRef(onDrained)
  // Keep the latest callback without making it an effect dependency. Updated in
  // an effect (not during render) so the transition effect below always sees
  // the current callback — effects run in declaration order on each commit.
  useEffect(() => {
    onDrainedRef.current = onDrained
  }, [onDrained])
  useEffect(() => {
    const prev = prevRef.current
    const prevKey = keyRef.current
    prevRef.current = pendingCount
    keyRef.current = key
    // Subject switch: reset the baseline, never fire — the count belongs to a
    // different file now, so a drop to 0 isn't a drain of the previous one.
    if (key !== prevKey) return
    if (prev > 0 && pendingCount === 0) onDrainedRef.current()
  }, [pendingCount, key])
}
