import { useCallback, useMemo, useRef } from "react"

/**
 * AQU-1531: a focus request the sidebar's file filter answers whenever it is
 * mounted — including when the request is what mounts it.
 *
 * The Agent workbench's "Choose file" button asks the dock to show the Files
 * panel. When that panel was already showing, the ask changed nothing and the
 * click read as dead. The decided behaviour is that the click always lands the
 * keyboard cursor in the panel's "Filter files…" box, whether the panel was
 * already up, collapsed, or showing Search/Voices.
 *
 * That needs a handoff rather than a plain ref: the dock only mounts the active
 * panel, so on a collapsed/other-panel click the filter does not exist yet at
 * click time. `request()` focuses it when it is there and otherwise remembers
 * the ask; `register()` (called by the filter on mount) answers a remembered
 * one. Both are refs, so neither a request nor a registration re-renders.
 */
export interface FileFilterFocusHandle {
  /** Focus the file filter now, or as soon as it mounts. */
  request: () => void
  /** Called by the file filter with its focuser on mount, and `null` on unmount. */
  register: (focus: (() => void) | null) => void
}

export function useFileFilterFocus(): FileFilterFocusHandle {
  const focusRef = useRef<(() => void) | null>(null)
  const pendingRef = useRef(false)

  const request = useCallback(() => {
    if (focusRef.current) {
      pendingRef.current = false
      focusRef.current()
      return
    }
    pendingRef.current = true
  }, [])

  const register = useCallback((focus: (() => void) | null) => {
    focusRef.current = focus
    if (!focus || !pendingRef.current) return
    pendingRef.current = false
    focus()
  }, [])

  return useMemo(() => ({ request, register }), [request, register])
}
