/**
 * chapter-page-pref — last open chapter page per file.
 *
 * AQU-1087 pages the editor one chapter at a time. The picker selection is
 * React state, so a reload would otherwise drop the translator back on
 * chapter 1. Persist the last page (and optional subsection) in localStorage
 * keyed by fileId; restore it when the editor remounts or the file changes.
 *
 * Key schema: `aq.chapter-page-pref.v1`
 */

const STORAGE_KEY = "aq.chapter-page-pref.v1"

export interface ChapterPagePref {
  key: string
  subsectionKey?: string
}

type PrefMap = Record<string, ChapterPagePref>

const snapshotCache = new Map<string, ChapterPagePref | null>()

function load(): PrefMap {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as PrefMap
  } catch {
    return {}
  }
}

function save(map: PrefMap): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota / access denied — in-memory cache still reflects the edit
  }
}

function parsePref(value: unknown): ChapterPagePref | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.key !== "string" || record.key.length === 0) return null
  const pref: ChapterPagePref = { key: record.key }
  if (typeof record.subsectionKey === "string" && record.subsectionKey.length > 0) {
    pref.subsectionKey = record.subsectionKey
  }
  return pref
}

function peek(fileId: string): ChapterPagePref | null {
  if (snapshotCache.has(fileId)) return snapshotCache.get(fileId) ?? null
  const fromLs = parsePref(load()[fileId])
  snapshotCache.set(fileId, fromLs)
  return fromLs
}

export function getChapterPagePref(fileId: string): ChapterPagePref | null {
  return peek(fileId)
}

export function setChapterPagePref(fileId: string, pref: ChapterPagePref): void {
  const next = parsePref(pref)
  if (!next) return
  const map = load()
  map[fileId] = next
  save(map)
  snapshotCache.set(fileId, next)
}

/** Test helper: forget cached snapshots so a fresh localStorage is read. */
export function resetChapterPagePrefCacheForTests(): void {
  snapshotCache.clear()
}
