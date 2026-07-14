import { useEffect, useRef } from "react"

/**
 * Fire `onDrained` exactly once each time `pendingCount` transitions from a
 * positive value down to zero — i.e. the moment a batch of queued work finishes
 * draining.
 *
 * Used to trigger a single soft refetch after a bulk import's outbox commits
 * land, so the read model reconciles with the server projection without a
 * per-item fan-out. A starting value of 0 is not a drain (there was no prior
 * work), and a steady 0 never re-fires.
 */
export function useReconcileOnDrain(pendingCount: number, onDrained: () => void): void {
  const prevRef = useRef(pendingCount)
  const onDrainedRef = useRef(onDrained)
  // Keep the latest callback without making it an effect dependency. Updated in
  // an effect (not during render) so the transition effect below always sees
  // the current callback — effects run in declaration order on each commit.
  useEffect(() => {
    onDrainedRef.current = onDrained
  }, [onDrained])
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = pendingCount
    if (prev > 0 && pendingCount === 0) onDrainedRef.current()
  }, [pendingCount])
}
