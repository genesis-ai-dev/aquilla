import { useCallback, useSyncExternalStore, type MouseEvent } from "react"
import { isTauriRuntime } from "@/lib/offline/is-tauri"

/**
 * The desktop window is built with macOS's overlay title bar in
 * `src-tauri/src/lib.rs` (`title_bar_style(Overlay)` +
 * `traffic_light_position(16, 20)`): no native title strip, the webview runs
 * to the top edge, and the traffic lights float over our top-left corner.
 * The constants below mirror that position — change them together.
 * Windows/Linux keep their native title bar, so this is macOS + Tauri only.
 *
 * `overlay`  — the web app owns the top strip: it must offer a drag handle.
 * `inset`    — the traffic lights are on screen right now (they hide in
 *              native fullscreen), so the top-left must be kept clear.
 */
export interface MacTitlebarOverlay {
  overlay: boolean
  inset: boolean
}

/** Horizontal room the traffic lights take, from the window's left edge:
 *  `trafficLightPosition.x` (16) + the three buttons (~52) + breathing room. */
export const TRAFFIC_LIGHTS_WIDTH = 76
/** Vertical room: `trafficLightPosition.y` (20) + button height (~14) + 6. */
export const TRAFFIC_LIGHTS_HEIGHT = 40

/** macOS proper. iOS WebKit also says "like Mac OS X" in its UA, so rule out
 *  touch devices (iPadOS reports itself as "Macintosh" but has touch points). */
const isMacDesktop = (): boolean => {
  if (typeof navigator === "undefined") return false
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform
    ?? ""
  if (!/^Mac/i.test(platform)) return false
  return !/iPhone|iPad|iPod/i.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) <= 1
}

export const isMacTitlebarOverlay = (): boolean => isTauriRuntime() && isMacDesktop()

// ── Fullscreen state: one module-level store ───────────────────────────────
// Every route renders its own AppShell, so a per-mount `useState(false)` +
// async IPC would flash the inset layout on each navigation while in native
// fullscreen. One subscription for the app's lifetime; mounts read the last
// known value synchronously.
let fullscreen = false
let started = false
const listeners = new Set<() => void>()

function startFullscreenWatch(): void {
  if (started) return
  started = true
  // Dynamic import keeps @tauri-apps/api out of the browser bundle.
  void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const win = getCurrentWindow()
    const sync = async () => {
      const next = await win.isFullscreen()
      if (next === fullscreen) return
      fullscreen = next
      for (const l of listeners) l()
    }
    await sync()
    // Entering/leaving native fullscreen always resizes the window.
    await win.onResized(() => { void sync() })
  }).catch(() => {
    // Not fatal: worst case the inset stays applied in fullscreen.
  })
}

function subscribe(listener: () => void): () => void {
  startFullscreenWatch()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getFullscreen = () => fullscreen
const subscribeNoop = () => () => {}

export function useMacTitlebarOverlay(): MacTitlebarOverlay {
  const overlay = isMacTitlebarOverlay()
  const fs = useSyncExternalStore(overlay ? subscribe : subscribeNoop, getFullscreen, getFullscreen)
  return { overlay, inset: overlay && !fs }
}

/** Test seam: reset the module store between tests. */
export function __resetMacTitlebarStoreForTests(): void {
  fullscreen = false
  started = false
  listeners.clear()
}

// ── Window drag ────────────────────────────────────────────────────────────
// Tauri's own `data-tauri-drag-region` script is deliberately not used: its
// document-level mousedown handler calls `stopImmediatePropagation()`, which
// starves every outside-click closer registered on document (mention popup,
// username typeahead), and in "deep" mode it only recognises a fixed list of
// tags/roles as clickable, so a `div` with onClick would become a drag handle.
// This handler runs from React (on the root container, before document
// listeners), never stops propagation, and backs off from anything that looks
// interactive — including anything styled `cursor: pointer`.

const INTERACTIVE_TAGS = new Set([
  "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY", "OPTION",
  "VIDEO", "AUDIO", "IFRAME",
])
const INTERACTIVE_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
  "checkbox", "radio", "switch", "option", "combobox", "textbox", "searchbox",
  "slider", "spinbutton", "treeitem", "gridcell",
])

function isInteractive(el: Element): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName)) return true
  if (INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "")) return true
  if (el.hasAttribute("tabindex")) return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  // Escape hatch for anything the heuristics below would misread.
  if (el.getAttribute("data-titlebar-drag") === "false") return true
  // Catches the `div onClick` that no tag/role list can see.
  return getComputedStyle(el).cursor === "pointer"
}

/** True when the mousedown landed on chrome itself, not on a control in it. */
export function isTitlebarDragTarget(target: EventTarget | null, region: Element): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== region) {
    if (isInteractive(el)) return false
    el = el.parentElement
  }
  return el === region
}

type WindowApi = typeof import("@tauri-apps/api/window")
let windowApi: Promise<WindowApi> | null = null
const loadWindowApi = () => (windowApi ??= import("@tauri-apps/api/window"))

export interface TitlebarDragProps {
  onMouseDown?: (e: MouseEvent<HTMLElement>) => void
  onMouseUp?: (e: MouseEvent<HTMLElement>) => void
}

/**
 * Props that turn an element into a window drag handle on macOS desktop
 * (empty object elsewhere). Click-drag moves the window; double click zooms,
 * as the native title bar does. Mirrors Tauri's macOS timing: zoom fires on
 * the second click's mouseup, and only if the pointer didn't move.
 */
export function useTitlebarDrag(enabled: boolean): TitlebarDragProps {
  const onMouseDown = useCallback((e: MouseEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.detail !== 1 && e.detail !== 2)) return
    if (!isTitlebarDragTarget(e.target, e.currentTarget)) return
    // No text-selection cursor or caret. Propagation is left alone so
    // document-level outside-click closers still see the press.
    e.preventDefault()
    if (e.detail === 2) {
      zoomPress = { x: e.clientX, y: e.clientY }
      return
    }
    zoomPress = null
    void loadWindowApi().then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(() => {})
  }, [])
  const onMouseUp = useCallback((e: MouseEvent<HTMLElement>) => {
    const press = zoomPress
    zoomPress = null
    if (!press || e.button !== 0 || e.detail !== 2) return
    if (e.clientX !== press.x || e.clientY !== press.y) return
    if (!isTitlebarDragTarget(e.target, e.currentTarget)) return
    void loadWindowApi().then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize()).catch(() => {})
  }, [])
  return enabled ? { onMouseDown, onMouseUp } : {}
}

let zoomPress: { x: number; y: number } | null = null
