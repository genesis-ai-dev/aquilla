// How far along a Paratext project on this computer is, read from its own book
// files: a verse counts as written when its line has text after the number.
// Nothing is cached or uploaded; the numbers are recomputed on every open.

import { useEffect, useState } from "react"
import { paratextTauri } from "./tauri"
import { deriveUnits } from "./units"
import type { BridgeProject } from "./use-paratext-discovery"

export type BookStatus = "not-started" | "in-progress" | "complete"

export interface BookProgress {
  code: string
  fileName: string
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

async function readBook(projectPath: string, code: string, fileName: string): Promise<BookProgress> {
  try {
    const set = await deriveUnits(await paratextTauri.readFile(projectPath, fileName))
    const verses = set.units.filter((u) => u.kind === "verse" && u.chapter > 0)
    const written = verses.filter((u) => u.text.replace(/\s+/g, "") !== "").length
    return { code, fileName, verses: verses.length, written, status: bookStatus(verses.length, written), unreadable: false }
  } catch {
    return { code, fileName, verses: 0, written: 0, status: "not-started", unreadable: true }
  }
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
      for (const b of project.books) {
        books.push(await readBook(project.path, b.code, b.fileName))
        if (cancelled) return
      }
      if (!cancelled) setResult({ path: project.path, progress: summarizeProgress(books) })
    }
    void run()
    return () => { cancelled = true }
    // The project object is rebuilt on every scan; its path and book list are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, utf8, project?.books.map((b) => b.fileName).join("|")])

  return result && result.path === path ? result.progress : null
}
