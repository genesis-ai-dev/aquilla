export type DockRailPosition = "left" | "top"

const STORAGE_KEY = "codex:dockRailPosition"
const CHANGE_EVENT = "codex:dock-rail-position-changed"
const DEFAULT: DockRailPosition = "top"

export function getDockRailPosition(): DockRailPosition {
  if (typeof window === "undefined") return DEFAULT
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw === "left" ? "left" : DEFAULT
}

export function setDockRailPosition(position: DockRailPosition): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, position)
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: position }))
}

export function onDockRailPositionChange(handler: (position: DockRailPosition) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (e: Event) => handler((e as CustomEvent<DockRailPosition>).detail)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}
