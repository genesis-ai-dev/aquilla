import { useRef } from "react"

/**
 * Keep the previous value's identity while a recomputed one is equal to it
 * (AQU-2654, decision 0013 "a row's props are stable").
 *
 * For a derived map or list that is rebuilt on every store emit but usually
 * comes out the same: handing the rebuilt object to a memoized child re-renders
 * it for nothing. `isEqual` should be cheap next to the render it saves.
 */
export function useStableValue<T>(value: T, isEqual: (previous: T, next: T) => boolean): T {
  const ref = useRef(value)
  // Idempotent for a given `value`, so a render React throws away is harmless.
  // eslint-disable-next-line react-hooks/refs -- the previous result is the whole point of this hook
  if (!Object.is(ref.current, value) && !isEqual(ref.current, value)) ref.current = value
  // eslint-disable-next-line react-hooks/refs -- see above
  return ref.current
}

/** Same keys, and `valuesEqual` (default `Object.is`) for every value. */
export function mapsEqual<K, V>(
  a: ReadonlyMap<K, V> | undefined,
  b: ReadonlyMap<K, V> | undefined,
  valuesEqual: (x: V, y: V) => boolean = Object.is,
): boolean {
  if (a === b) return true
  if (!a || !b || a.size !== b.size) return false
  for (const [key, value] of a) {
    if (!b.has(key)) return false
    if (!valuesEqual(value, b.get(key) as V)) return false
  }
  return true
}

/** Same own keys, and `Object.is` for every value. For small plain records. */
export function shallowEqualObjects<T extends object>(a: T, b: T): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a) as Array<keyof T>
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) return false
  }
  return true
}
