import { useEffect, useRef } from "react"

/**
 * Run `onCancel` once when the component really unmounts, not when React
 * StrictMode (dev) simulates an unmount/remount right after the first mount.
 *
 * A plain `useEffect(() => () => cancel(), [])` fires on StrictMode's fake
 * unmount too: a headless run would settle "cancelled" before its frame even
 * loaded (AQU-1937: the Door43 importer's Resource choices came back empty on
 * the dev stack). The check is deferred a tick; a remount in between keeps the
 * component alive.
 */
export function useCancelOnUnmount(onCancel: () => void): void {
  const cb = useRef(onCancel)
  useEffect(() => {
    cb.current = onCancel
  }, [onCancel])
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      setTimeout(() => {
        if (!alive.current) cb.current()
      }, 0)
    }
  }, [])
}
