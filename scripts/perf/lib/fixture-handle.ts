/**
 * The seeded Big Bible fixture's handle (AQU-1868).
 *
 * `seed-big-bible.ts` writes it; `measure.ts` and `presence-load.ts` read it.
 * Without it every measurement run would have to re-seed 31k cells (minutes)
 * or be told a project id by hand, which is how a "before" and an "after" run
 * end up measuring two different projects.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Repo-relative by default; `.perf/` is gitignored — a handle is local state. */
export const DEFAULT_HANDLE_PATH = ".perf/big-bible.json"

export interface SeededFileHandle {
  id: string
  name: string
  bookCode: string
  cells: number
  /** A few (cellId, target head eventId) pairs, for chaining measured commits. */
  commitTargets: Array<{ cellId: string; parentEventId: string }>
}

export interface BigBibleHandle {
  harness: "big-bible"
  seededAt: string
  target: { authBase: string; syncBase: string }
  username: string
  projectId: string
  projectName: string
  lanes: Array<{ id: string; role: string; legacyTag: string | null; language: string | null }>
  files: SeededFileHandle[]
  stats: {
    files: number
    cells: number
    chapters: number
    verses: number
    headings: number
    translated: number
    secondLane: number
    historyCommits: number
    audioAttachments: number
  }
}

export function writeHandle(handlePath: string, handle: BigBibleHandle): void {
  mkdirSync(path.dirname(path.resolve(handlePath)), { recursive: true })
  writeFileSync(path.resolve(handlePath), `${JSON.stringify(handle, null, 2)}\n`, "utf8")
}

export function readHandle(handlePath: string): BigBibleHandle {
  const resolved = path.resolve(handlePath)
  let raw: string
  try {
    raw = readFileSync(resolved, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No seeded fixture at ${resolved}. Run \`pnpm perf:seed\` first (or pass --handle <path>).`,
        { cause: error },
      )
    }
    throw error
  }
  const handle = JSON.parse(raw) as BigBibleHandle
  if (handle?.harness !== "big-bible" || !handle.projectId) {
    throw new Error(`${resolved} is not a Big Bible fixture handle`)
  }
  return handle
}
