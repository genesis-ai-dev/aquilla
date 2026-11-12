import { useSyncExternalStore } from "react"

declare const __APP_SHA__: string

const POLL_MS = 60_000

// One poller for the whole app, however many places show the indicator
// (the left-rail VersionTag, the floating VersionBadge, the navigation
// watcher). The flag is sticky: once a newer build is seen it stays set
// until the page reloads, which is the only thing that can pick it up.
let available = false
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

async function check() {
  try {
    const res = await fetch(`/version.json?_=${Date.now()}`, { cache: "no-store" })
    if (!res.ok) return
    const { sha } = (await res.json()) as { sha?: string }
    if (sha && sha !== __APP_SHA__ && !available) {
      available = true
      for (const listener of listeners) listener()
    }
  } catch {
    /* network blip — retry next tick */
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer && !import.meta.env.DEV) timer = setInterval(() => void check(), POLL_MS)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** True once a build newer than this one is deployed. Polls /version.json every minute. */
export function useUpdateCheck(): boolean {
  return useSyncExternalStore(subscribe, () => available, () => false)
}

/** Test seam: pretend the poller saw a newer build (or reset it). */
export function __setUpdateAvailableForTests(value: boolean) {
  available = value
  for (const listener of listeners) listener()
}

/**
 * Where a reload must never happen on its own: the editor. An edit in
 * flight lives in the outbox (IndexedDB) and would survive, but the
 * contributor's place, selection and focus lock would not.
 */
export function isEditorPath(pathname: string): boolean {
  return /^\/project\/[^/]+\/editor(\/|$)/.test(pathname)
}

/** Focusable things you cannot type prose into. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit",
])

/**
 * AQU-2335 — the other half of "a new build never interrupts input".
 * `isEditorPath` guards the editor *route*; this guards the *keystroke*,
 * wherever it is being typed: a cell editor, the agent composer, a comment
 * box, any form field. The update flag is sticky, so a reload skipped here
 * is only deferred — the next navigation with the caret out of a field
 * takes the new build. A click on the indicator still reloads at once:
 * that is the user asking for it.
 */
export function isTypingSomewhere(doc: Document | undefined = globalThis.document): boolean {
  const el = doc?.activeElement
  if (!el) return false
  if (el.tagName === "TEXTAREA") return true
  if (el.tagName === "INPUT") {
    return !NON_TEXT_INPUT_TYPES.has((el.getAttribute("type") ?? "text").toLowerCase())
  }
  // TipTap (cell editor, agent composer) and any other rich-text surface.
  if ("isContentEditable" in el && (el as HTMLElement).isContentEditable) return true
  return el.getAttribute("role") === "textbox"
}
