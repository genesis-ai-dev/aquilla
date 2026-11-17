import { useCallback, useEffect, useSyncExternalStore, type MouseEvent } from "react"

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

// ── Layout insets (AppShell) ───────────────────────────────────────────────

export interface TitlebarInsetInput {
  /** The traffic lights are on screen (`MacTitlebarOverlay.inset`). */
  inset: boolean
  /** Narrow window: the sidebar opens as a sheet, not in flow. */
  mobileNav: boolean
  rtl: boolean
  /** The in-flow sidebar is collapsed to its icon rail. */
  chromeCollapsed: boolean
  /** …and that rail really is narrow (the resizable dock), not the w-56 org aside. */
  railIsNarrow: boolean
  collapsedRailWidth: number
}

export interface TitlebarInsets {
  /** Push the sidebar chrome row (or the sheet's) past the lights; its brand
   *  mark and beta chip give up their room. */
  insetSidebarRow: boolean
  /** Drop the collapsed rail's icon stack below the lights. */
  insetRail: boolean
  /** Left padding for AppShell's header band, in px. */
  headerInset: number
}

/**
 * Where the traffic lights land depends on the layout under them:
 *  - expanded sidebar: its chrome row — the brand mark gives up its slot
 *    (a native app's window already says whose it is; the org breadcrumb
 *    in the header still links home) and the row's start is pushed past
 *    the lights. The beta chip is dropped too, so the row still fits at
 *    the dock's 200px minimum;
 *  - collapsed rail: its icon stack drops below the lights. Only the
 *    resizable dock actually narrows to the collapsed width (the org aside
 *    stays w-56), so only then does the header clear the overhang;
 *  - no in-flow sidebar (narrow window): the header band starts at x=0.
 *    The sidebar opens as a sheet from the window's left edge instead, so
 *    the sheet's chrome row clears the lights the same way as the expanded
 *    sidebar's (the sheet is never a collapsed rail).
 * The lights stay at the window's physical top-left whatever the text
 * direction, so every inset is physical (paddingLeft, never inline-start).
 * In an RTL locale the in-flow sidebar flips to the right edge, leaving the
 * header to clear the lights; the sheet stays on the left (side="left").
 */
export function titlebarInsets(input: TitlebarInsetInput): TitlebarInsets {
  const { inset, mobileNav, rtl, chromeCollapsed, railIsNarrow, collapsedRailWidth } = input
  const sidebarAtLeft = !mobileNav && !rtl
  const headerInset = !inset
    ? 0
    : !sidebarAtLeft
      ? TRAFFIC_LIGHTS_WIDTH
      : railIsNarrow
        ? TRAFFIC_LIGHTS_WIDTH - collapsedRailWidth
        : 0
  return {
    insetSidebarRow: inset && !chromeCollapsed && (mobileNav || sidebarAtLeft),
    insetRail: inset && sidebarAtLeft && chromeCollapsed,
    headerInset,
  }
}

// ── Fullscreen state: one module-level store ───────────────────────────────
// Every route renders its own AppShell, so a per-mount `useState(false)` +
// async IPC would flash the inset layout on each navigation while in native
// fullscreen. One subscription for the app's lifetime; mounts read the last
// known value synchronously.
let fullscreen = false
let started = false

// Dynamic imports keep @tauri-apps/api out of the browser bundle. One cached
// load per module; the resolved window API is also kept synchronously so a
// mousedown can call startDragging in the same tick (see useTitlebarDrag).
type WindowApi = typeof import("@tauri-apps/api/window")
type CoreApi = typeof import("@tauri-apps/api/core")
let windowApi: Promise<WindowApi> | null = null
let windowApiLoaded: WindowApi | null = null
let coreApi: Promise<CoreApi> | null = null
function loadWindowApi(): Promise<WindowApi> {
  windowApi ??= import("@tauri-apps/api/window").then((m) => (windowApiLoaded = m), (err: unknown) => {
    windowApi = null
    throw err
  })
  return windowApi
}
function loadCoreApi(): Promise<CoreApi> {
  coreApi ??= import("@tauri-apps/api/core").catch((err: unknown) => {
    coreApi = null
    throw err
  })
  return coreApi
}
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
  void loadWindowApi().then(async ({ getCurrentWindow }) => {
    const win = getCurrentWindow()
    // Only the newest check may write: replies can arrive out of order. A
    // failed check is dropped; the next resize asks again.
    let latest = 0
    const check = () => {
      const mine = ++latest
      void win.isFullscreen().then((next) => {
        if (mine === latest) setFullscreen(next)
      }, () => {})
    }
    let timers: Array<ReturnType<typeof setTimeout>> = []
    check()
    // Entering/leaving native fullscreen always resizes the window.
    await win.onResized(() => {
      for (const t of timers) clearTimeout(t)
      timers = [setTimeout(check, FULLSCREEN_SETTLE_MS), setTimeout(check, FULLSCREEN_RECHECK_MS)]
    })
  }).catch(() => {
    // No resize listener (module or IPC not ready yet): let the next mount
    // try again rather than leaving the inset stuck on for the session.
    started = false
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
  windowApi = null
  windowApiLoaded = null
  coreApi = null
}

// ── Window drag ────────────────────────────────────────────────────────────
// Tauri's own `data-tauri-drag-region` script is deliberately not used: its
// document-level mousedown handler calls `stopImmediatePropagation()`, which
// starves every outside-click closer registered on document (mention popup,
// username typeahead), and in "deep" mode it only recognises a fixed list of
// tags/roles as clickable, so a `div` with onClick would become a drag handle.
// This handler runs from React (on the root container, before document
// listeners), never stops propagation, and backs off from anything that looks
// interactive — including any element React gave a click or press handler.

const INTERACTIVE_TAGS = new Set([
  "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY", "OPTION",
  "VIDEO", "AUDIO", "IFRAME",
])
const INTERACTIVE_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
  "checkbox", "radio", "switch", "option", "combobox", "textbox", "searchbox",
  "slider", "spinbutton", "treeitem", "gridcell",
])

const PRESS_HANDLERS = [
  "onClick", "onDoubleClick", "onMouseDown", "onMouseUp", "onPointerDown", "onPointerUp",
] as const

/** Catches the `div onClick` that no tag/role list can see. The app styles
 *  clickable things with the arrow cursor, so `cursor: pointer` can't be the
 *  tell; React keeps each host element's props on the node itself
 *  (`__reactProps$<id>`, React 17+), which is exactly the question asked. */
function hasReactPressHandler(el: Element): boolean {
  for (const key of Object.keys(el)) {
    if (!key.startsWith("__reactProps$")) continue
    const props = (el as unknown as Record<string, Record<string, unknown> | undefined>)[key]
    return PRESS_HANDLERS.some((name) => typeof props?.[name] === "function")
  }
  return false
}

function isInteractive(el: Element): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName)) return true
  if (INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "")) return true
  if (el.hasAttribute("tabindex")) return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  // Escape hatch for a listener added outside React.
  if (el.getAttribute("data-titlebar-drag") === "false") return true
  return hasReactPressHandler(el)
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
  // macOS only starts a window drag while the button is still down: load the
  // API ahead of the first press so the drag starts in the mousedown's tick.
  useEffect(() => {
    if (enabled) void loadWindowApi().catch(() => {})
  }, [enabled])
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
    const startDragging = (api: WindowApi) => api.getCurrentWindow().startDragging()
    if (windowApiLoaded) void startDragging(windowApiLoaded).catch(() => {})
    else void loadWindowApi().then(startDragging).catch(() => {})
  }, [])
  const onMouseUp = useCallback((e: MouseEvent<HTMLElement>) => {
    const press = zoomPress
    zoomPress = null
    if (!press || press.region !== e.currentTarget) return
    if (e.button !== 0 || e.detail !== 2) return
    if (e.clientX !== press.x || e.clientY !== press.y) return
    if (!isTitlebarDragTarget(e.target, e.currentTarget)) return
    void loadCoreApi()
      .then(({ invoke }) => invoke("titlebar_double_click"))
      .catch(() => {})
  }, [])
  return enabled ? { onMouseDown, onMouseUp } : {}
}
