/**
 * bible-document-view-pref — device-scoped preferences for the Bible document
 * layout (AQU-2559): which files open as a document rather than a table, and
 * which panes that layout shows.
 *
 * The layout is chosen per file: a translator drafting one book in the
 * document may still review another in the table. The panes are one setting
 * for the device, because they are about the screen, not the book.
 *
 * Key schema: `aq.bible-document-view.v1` (JSON; absent = table, source pane
 * shown, export preview hidden, linked scrolling on).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.bible-document-view.v1"

export interface BibleDocumentViewPref {
  /** File ids that open in the document layout. */
  files: Record<string, true>
  source: boolean
  preview: boolean
  linked: boolean
}

const DEFAULTS: BibleDocumentViewPref = { files: {}, source: true, preview: false, linked: true }

const listeners = new Set<() => void>()
let cached: BibleDocumentViewPref | undefined

function read(): BibleDocumentViewPref {
  if (typeof localStorage === "undefined") return DEFAULTS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<BibleDocumentViewPref>
    return {
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      source: parsed.source !== false,
      preview: parsed.preview === true,
      linked: parsed.linked !== false,
    }
  } catch {
    return DEFAULTS
  }
}

function peek(): BibleDocumentViewPref {
  if (cached === undefined) cached = read()
  return cached
}

function write(next: BibleDocumentViewPref): void {
  cached = next
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // quota / access denied — the in-memory cache still reflects the change
    }
  }
  for (const l of listeners) l()
}

export function setBibleDocumentViewForFile(fileId: string, document: boolean): void {
  const files = { ...peek().files }
  if (document) files[fileId] = true
  else delete files[fileId]
  write({ ...peek(), files })
}

export function setBibleDocumentPanes(patch: Partial<Pick<BibleDocumentViewPref, "source" | "preview" | "linked">>): void {
  write({ ...peek(), ...patch })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useBibleDocumentViewPref(): BibleDocumentViewPref {
  return useSyncExternalStore(subscribe, peek, () => DEFAULTS)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetBibleDocumentViewPrefForTests(): void {
  cached = undefined
}
