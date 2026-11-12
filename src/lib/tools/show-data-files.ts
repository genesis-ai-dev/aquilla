/**
 * apiRev 7: "Show extension data files". Extension data files (role
 * `extension-data`: alignments and other records an extension saves) are
 * hidden from the file list like the other companion files. A user can choose
 * to see them — a per-browser view preference, like the dock tab.
 */

import { useSyncExternalStore } from "react"

const KEY = "aquilla.extensions.showDataFiles"
const EVENT = "aquilla:show-data-files"

export function showExtensionDataFiles(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export function setShowExtensionDataFiles(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY, "1")
    else window.localStorage.removeItem(KEY)
  } catch {
    // Private mode: the choice lasts until reload.
  }
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  window.addEventListener("storage", cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener("storage", cb)
  }
}

export function useShowExtensionDataFiles(): boolean {
  return useSyncExternalStore(subscribe, showExtensionDataFiles, () => false)
}
