import { useCallback, useSyncExternalStore, type MouseEvent } from "react"

/**
 * The desktop window is built with macOS's overlay title bar in
 * `src-tauri/src/lib.rs` (`title_bar_style(Overlay)` +
 * `traffic_light_position(16, 28)`): no native title strip, the webview runs
 * to the top edge, and the traffic lights float over our top-left corner,
 * spanning x≈16–68, y≈19–33 (centred on AppShell's 52px header midline).
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
 *  x (16) + the three buttons (~52) + breathing room. */
export const TRAFFIC_LIGHTS_WIDTH = 76
/** Vertical room: the buttons' bottom edge (y≈33) + breathing room. */
export const TRAFFIC_LIGHTS_HEIGHT = 40
/** Title-bar band for pages outside AppShell: the same 52px as AppShell's
 *  header, so the traffic lights sit centred in it there too. */
export const TITLEBAR_BAND_HEIGHT = 52

declare global {
  interface Window {
    /** Set by the native shell's init script when it built the window with
     *  the overlay title bar (src-tauri/src/titlebar.rs). */
    __AQUILLA_MAC_TITLEBAR_OVERLAY__?: boolean
  }
}

/** Asks the native side rather than sniffing the platform: the window has
 *  an overlay title bar exactly when the shell that built it says so. A
 *  newer web bundle hot-loaded into an older shell correctly reads false. */
export const isMacTitlebarOverlay = (): boolean =>
  typeof window !== "undefined" && window.__AQUILLA_MAC_TITLEBAR_OVERLAY__ === true

// ── Fullscreen state: one module-level store ───────────────────────────────
// Every route renders its own AppShell, so a per-mount `useState(false)` +
// async IPC would flash the inset layout on each navigation while in native
// fullscreen. One subscription for the app's lifetime; mounts read the last
// known value synchronously.
let fullscreen = false
let started = false
const listeners = new Set<() => void>()

/** A live drag-resize fires dozens of resize events a second; check once
 *  the window has settled instead of on every event. */
const FULLSCREEN_SETTLE_MS = 150
/** …and once more after the native fullscreen animation has surely ended,
 *  in case the settled check still caught macOS mid-transition. */
const FULLSCREEN_RECHECK_MS = 1000

function setFullscreen(next: boolean): void {
  if (next === fullscreen) return
  fullscreen = next
  for (const l of listeners) l()
}

function startFullscreenWatch(): void {
  if (started) return
  started = true
  // Dynamic import keeps @tauri-apps/api out of the browser bundle.
  void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const win = getCurrentWindow()
    // Only the newest check may write: replies can arrive out of order.
    let latest = 0
    const check = async () => {
      const mine = ++latest
      const next = await win.isFullscreen()
      if (mine === latest) setFullscreen(next)
    }
    let timers: Array<ReturnType<typeof setTimeout>> = []
    await check()
    // Entering/leaving native fullscreen always resizes the window.
    await win.onResized(() => {
      for (const t of timers) clearTimeout(t)
      timers = [
        setTimeout(() => { void check().catch(() => {}) }, FULLSCREEN_SETTLE_MS),
        setTimeout(() => { void check().catch(() => {}) }, FULLSCREEN_RECHECK_MS),
      ]
    })
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

/** The second press of a double click, waiting for its release. Scoped to
 *  that one press: cleared on the next mouseup wherever it lands. */
let zoomPress: { x: number; y: number; region: Element } | null = null

/**
 * Props that turn an element into a window drag handle on macOS desktop
 * (empty object elsewhere). Click-drag moves the window; double click does
 * what the user's "Double-click a window's title bar to" setting says
 * (native `titlebar_double_click`). Mirrors Tauri's macOS timing: that fires
 * on the second click's mouseup, and only if the pointer didn't move.
 */
export function useTitlebarDrag(enabled: boolean): TitlebarDragProps {
  const onMouseDown = useCallback((e: MouseEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.detail !== 1 && e.detail !== 2)) return
    if (!isTitlebarDragTarget(e.target, e.currentTarget)) return
    // preventDefault (below) keeps the browser from moving focus, so blur by
    // hand: clicking empty header space still ends an inline rename or a
    // cell edit, as it does in the browser build.
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) active.blur()
    // No text-selection cursor or caret. Propagation is left alone so
    // document-level outside-click closers still see the press.
    e.preventDefault()
    if (e.detail === 2) {
      zoomPress = { x: e.clientX, y: e.clientY, region: e.currentTarget }
      // Window listeners run after React's root listener, so the region's
      // own onMouseUp reads the press first.
      window.addEventListener("mouseup", () => { zoomPress = null }, { once: true })
      return
    }
    zoomPress = null
    void loadWindowApi().then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(() => {})
  }, [])
  const onMouseUp = useCallback((e: MouseEvent<HTMLElement>) => {
    const press = zoomPress
    zoomPress = null
    if (!press || press.region !== e.currentTarget) return
    if (e.button !== 0 || e.detail !== 2) return
    if (e.clientX !== press.x || e.clientY !== press.y) return
    if (!isTitlebarDragTarget(e.target, e.currentTarget)) return
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("titlebar_double_click"))
      .catch(() => {})
  }, [])
  return enabled ? { onMouseDown, onMouseUp } : {}
}
