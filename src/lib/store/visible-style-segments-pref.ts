/**
 * Device preference that paints each IDML style run as its own inline block
 * in the cell, so a translator can see which run the caret is in.
 *
 * Off unless the user opts in. A missing key reads as off, which is how every
 * cell looked before this preference existed.
 *
 * Key schema: `aq.visible-style-segments.v1` (value `"on"`; absent = off).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.visible-style-segments.v1"

const listeners = new Set<() => void>()

let cached: boolean | undefined

function notify(): void {
  for (const listener of listeners) listener()
}

function read(): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(STORAGE_KEY) === "on"
  } catch {
    return false
  }
}

function peek(): boolean {
  if (cached === undefined) cached = read()
  return cached
}

export function getVisibleStyleSegments(): boolean {
  return peek()
}

export function setVisibleStyleSegments(on: boolean): void {
  cached = on
  if (typeof localStorage !== "undefined") {
    try {
      if (on) localStorage.setItem(STORAGE_KEY, "on")
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // quota / access denied — the in-memory cache still reflects the edit
    }
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useVisibleStyleSegments(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}

export interface VisibleStyleSegmentLabels {
  regular: string
  bold: string
  italic: string
  boldItalic: string
}

/** Quote a label so it is a legal CSS `content` string. */
export function cssContentString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`
}

const LABEL_VARS: Record<keyof VisibleStyleSegmentLabels, string> = {
  regular: "--aq-style-label-regular",
  bold: "--aq-style-label-bold",
  italic: "--aq-style-label-italic",
  boldItalic: "--aq-style-label-bold-italic",
}

/**
 * The editor paints segments with CSS on `documentElement`, so one write
 * covers the source column, the target read surface, and the live editor.
 */
export function applyVisibleStyleSegmentChrome(
  on: boolean,
  labels: VisibleStyleSegmentLabels,
): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.toggleAttribute("data-visible-style-segments", on)
  for (const [key, name] of Object.entries(LABEL_VARS) as Array<[keyof VisibleStyleSegmentLabels, string]>) {
    if (on) root.style.setProperty(name, cssContentString(labels[key]))
    else root.style.removeProperty(name)
  }
}

export function resetVisibleStyleSegmentsCacheForTests(): void {
  cached = undefined
}
