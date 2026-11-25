import { useEffect, useRef, useState } from "react"
import { createChangeSignal, type ChangeSignal } from "./useStableCallback"

/**
 * Returns a trailing-debounced copy of `value` that only updates after `value`
 * has stopped changing for `delayMs`.
 *
 * Why this exists: several heavy whole-project derivations (the BT glosser, the
 * interlinear alignment model, the few-shot search index) rebuild from scratch
 * whenever the project corpus changes. During bulk AI completion ("complete
 * all"), every committed cell mutates that corpus, so a naive memo rebuilds all
 * of them ~twice per cell — a storm that allocates GB/s and OOM-crashes the tab
 * (537MB→2.4GB sawtooth observed live). These derivations don't need to be live
 * mid-batch (they feed back-translation + interlinear display, not the edit or
 * the completion request itself), so feeding them a debounced corpus coalesces
 * the storm into a single rebuild once the batch pauses.
 *
 * The first value is returned immediately (no initial delay); only subsequent
 * changes are debounced. Identity is preserved between debounce windows so
 * downstream `useMemo`/effect deps don't see spurious changes.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  // Hold the latest value in a ref so the first effect run can short-circuit
  // (mount) without scheduling a timer.
  const isFirst = useRef(true)

  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false
      return
    }
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}

/** A debounced value that is read on demand. See `useDebouncedSource`. */
export interface DebouncedSource<T> {
  /** The value as of the last debounce window. */
  get: () => T
  /** Bumps when `get()` starts returning a new value. */
  signal: ChangeSignal
}

/**
 * `useDebouncedValue` without the render (AQU-2655).
 *
 * `useDebouncedValue` keeps the debounced copy in state, so the component that
 * calls it renders once more when the debounce fires. When that component is
 * the workspace and the copy only feeds getters and effects, that render is
 * the whole tree for nothing. This keeps the copy outside React state: callers
 * read `get()` when they need the value, and a consumer that shows a result
 * derived from it subscribes to `signal` (`useChangeSignalVersion`).
 *
 * The returned object is stable for the component's lifetime. The first value
 * is available at once; later changes land after `delayMs` of quiet.
 */
export function useDebouncedSource<T>(value: T, delayMs: number): DebouncedSource<T> {
  const [source] = useState(() => {
    let current = value
    const signal = createChangeSignal()
    return {
      get: () => current,
      signal: signal as ChangeSignal,
      set(next: T) {
        if (Object.is(next, current)) return
        current = next
        signal.bump()
      },
    }
  })
  useEffect(() => {
    const id = setTimeout(() => source.set(value), delayMs)
    return () => clearTimeout(id)
  }, [source, value, delayMs])
  return source
}
