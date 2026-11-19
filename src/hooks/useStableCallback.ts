import { useCallback, useInsertionEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"

/**
 * A callback whose identity never changes but which always runs the newest
 * `fn` (AQU-2654, decision 0013 "a row's props are stable").
 *
 * For handlers a memoized list row is given: a parent callback that closes
 * over data (a corpus, a cache) is rebuilt whenever that data changes, and
 * handing the new identity to every row re-renders every row for a function
 * none of them calls until the user acts. The ref is written in an insertion
 * effect, so it is current before any layout effect or event handler runs.
 *
 * Only for callbacks that are CALLED (event handlers, effects). When a
 * consumer uses the identity as a "the answer may have changed" signal — a
 * getter listed in a `useMemo` — pair it with `useChangeSignal` below, or the
 * consumer goes stale.
 *
 * `undefined` stays `undefined`, so `onX?.()` and `Boolean(onX)` gates keep
 * their meaning.
 */
export function useStableCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result
export function useStableCallback<Args extends unknown[], Result>(
  fn: ((...args: Args) => Result) | undefined,
): ((...args: Args) => Result) | undefined
export function useStableCallback<Args extends unknown[], Result>(
  fn: ((...args: Args) => Result) | undefined,
): ((...args: Args) => Result) | undefined {
  const ref = useRef(fn)
  useInsertionEffect(() => {
    ref.current = fn
  })
  const stable = useCallback((...args: Args): Result => {
    // Only reachable while `fn` is defined at the call site's last render; a
    // caller that kept the function past that gets `undefined`, as `fn?.()` would.
    return ref.current?.(...args) as Result
  }, [])
  return fn ? stable : undefined
}

/** A counter consumers can subscribe to. See `useChangeSignal`. */
export interface ChangeSignal {
  subscribe: (listener: () => void) => () => void
  getVersion: () => number
}

function createChangeSignal(): ChangeSignal & { bump: () => void } {
  let version = 0
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    bump() {
      version += 1
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * A stable object whose version bumps when any of `values` changes identity.
 *
 * The other half of `useStableCallback` for GETTERS: the parent hands rows a
 * stable getter plus this signal, and only a row that is showing the getter's
 * answer subscribes (`useChangeSignalVersion(signal, enabled)`) and lists the
 * version beside the getter in its memo deps. A change then re-renders that
 * row alone instead of every row.
 */
export function useChangeSignal(values: readonly unknown[]): ChangeSignal {
  const [signal] = useState(createChangeSignal)
  const seenRef = useRef(values)
  // A layout effect, not an insertion effect: the bump re-renders subscribed
  // rows, and by now `useStableCallback`'s refs already hold the new getters.
  useLayoutEffect(() => {
    const seen = seenRef.current
    const changed = seen.length !== values.length || values.some((value, index) => !Object.is(value, seen[index]))
    if (!changed) return
    seenRef.current = values
    signal.bump()
  })
  return signal
}

const subscribeToNothing = () => () => {}
const versionZero = () => 0

/** The signal's version while `enabled`; a constant 0 (and no subscription) otherwise. */
export function useChangeSignalVersion(signal: ChangeSignal | undefined, enabled: boolean): number {
  const live = enabled && signal !== undefined
  return useSyncExternalStore(
    live ? signal.subscribe : subscribeToNothing,
    live ? signal.getVersion : versionZero,
  )
}
