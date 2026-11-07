// How far along a Paratext project on this computer is, read from its own book
// files: a verse counts as written when its line has text after the number,
// measured against the standard verse count of each canonical book. Counts are
// cached on this device by file hash; nothing is uploaded.

import { useEffect, useState } from "react"
import { paratextTauri } from "./tauri"
import { deriveUnits } from "./units"
import { LAST_VERSES } from "../audio/bulk-upload/verse-counts"
import type { BridgeProject } from "./use-paratext-discovery"

export type BookStatus = "not-started" | "in-progress" | "complete"

export interface BookProgress {
  code: string
  fileName: string
  /** Verses the book has: the standard count when known, else those the file lists. */
  verses: number
  written: number
  status: BookStatus
  /** The file could not be read or parsed; it counts as not started. */
  unreadable: boolean
}

export interface ProjectProgress {
  books: BookProgress[]
  verses: number
  written: number
}

export function bookStatus(verses: number, written: number): BookStatus {
  if (written === 0) return "not-started"
  return verses > 0 && written >= verses ? "complete" : "in-progress"
}

export function summarizeProgress(books: BookProgress[]): ProjectProgress {
  return {
    books,
    verses: books.reduce((n, b) => n + b.verses, 0),
    written: books.reduce((n, b) => n + b.written, 0),
  }
}

/** What a book file says about itself, before any standard to compare with. */
export interface BookCounts {
  /** Verses the file lists (a bridge "3-4" counts both). */
  listed: number
  /** Of those, the ones with text after the number. */
  written: number
}

/** "3" is one verse, "3-4" two, "3a" one. */
export function verseSpan(verse: string): number {
  const m = verse.match(/^(\d+)[a-z]?(?:-(\d+)[a-z]?)?$/i)
  if (!m) return 1
  return m[2] ? Math.max(1, Number(m[2]) - Number(m[1]) + 1) : 1
}

export function countBook(units: readonly { kind: string; chapter: number; verse: string; text: string }[]): BookCounts {
  let listed = 0
  let written = 0
  for (const u of units) {
    if (u.kind !== "verse" || u.chapter <= 0) continue
    const n = verseSpan(u.verse)
    listed += n
    if (u.text.replace(/\s+/g, "") !== "") written += n
  }
  return { listed, written }
}

/** The standard English verse count of a canonical book, or null when the
 *  project uses another numbering or the book is outside the 66. A file that
 *  lists only the verses someone has started would otherwise read as complete. */
export function standardVerses(code: string, versification: string): number | null {
  if (versification !== "4" && versification !== "") return null
  const chapters = LAST_VERSES[code]
  return chapters ? chapters.reduce((n, v) => n + v, 0) : null
}

export function toBookProgress(code: string, fileName: string, counts: BookCounts, versification: string): BookProgress {
  const standard = standardVerses(code, versification)
  const verses = standard === null ? counts.listed : Math.max(standard, counts.listed)
  const written = Math.min(counts.written, verses)
  return { code, fileName, verses, written, status: bookStatus(verses, written), unreadable: false }
}

// The counts only change when the file does, so they are kept by file hash:
// a project opens instantly after the first read, on this device only.
const CACHE_KEY = "aquilla.paratext.progress.v1"
type CacheEntry = { hash: string } & BookCounts

function readCache(): Record<string, CacheEntry> {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<string, CacheEntry> } catch { return {} }
}

function writeCache(cache: Record<string, CacheEntry>): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)) } catch { /* private mode or full: recompute next time */ }
}

async function readCounts(projectPath: string, fileName: string, cache: Record<string, CacheEntry>): Promise<BookCounts> {
  const key = `${projectPath}::${fileName}`
  const hash = await paratextTauri.hashFile(projectPath, fileName).catch(() => null)
  const hit = cache[key]
  if (hash && hit && hit.hash === hash) return { listed: hit.listed, written: hit.written }
  const set = await deriveUnits(await paratextTauri.readFile(projectPath, fileName))
  const counts = countBook(set.units)
  if (hash) cache[key] = { hash, ...counts }
  return counts
}

/** Reads every book of the project, one at a time so a 66-book project does
 *  not load the UI thread. `null` while reading. */
export function useParatextProgress(project: BridgeProject | null): ProjectProgress | null {
  const [result, setResult] = useState<{ path: string; progress: ProjectProgress } | null>(null)
  const path = project?.path ?? null
  const utf8 = project?.utf8 ?? false

  useEffect(() => {
    if (!project || !utf8) return
    let cancelled = false
    const run = async () => {
      const books: BookProgress[] = []
      const cache = readCache()
      for (const b of project.books) {
        try {
          books.push(toBookProgress(b.code, b.fileName, await readCounts(project.path, b.fileName, cache), project.settings.versification))
        } catch {
          books.push({ code: b.code, fileName: b.fileName, verses: 0, written: 0, status: "not-started", unreadable: true })
        }
        if (cancelled) return
      }
      writeCache(cache)
      if (!cancelled) setResult({ path: project.path, progress: summarizeProgress(books) })
    }
    void run()
    return () => { cancelled = true }
    // The project object is rebuilt on every scan; its path and book list are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, utf8, project?.books.map((b) => b.fileName).join("|")])

  return result && result.path === path ? result.progress : null
}
