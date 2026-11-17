/**
 * Files a source link replaced the source of, whose IDML translations still
 * have to be placed into the new source.
 *
 * "Replace the source in my existing file" (AQU-1679) writes the upstream's
 * source — protected HTML and slot metadata — onto the file's own cells and
 * leaves every target as it was. For an IDML file whose upstream was imported
 * from a different package than this file (a re-import that changed which runs
 * are editable, a publisher's later edition), the kept translations are then
 * the shell of the OLD source: export refuses them ("changed a protected IDML
 * anchor … editability") until each one is placed into the new runs.
 *
 * A re-import of the same file runs that placement itself, right after the
 * reconcile (`alignReimportedIdmlFile`, called from `emitParsedFile`). A link
 * cannot: the join happens inside the sync worker, and the model that places
 * the words is configured in the workspace. So the two link flows record here
 * which of the project's own files took a linked source, and the workspace
 * runs the same placement over the IDML ones among them
 * (`useAdoptedIdmlAlignment`), with the same progress line a re-import shows.
 *
 * Persisted: the Source & sync card is a different page from the editor, and
 * the editor is where the placement runs. Cleared per file once it has run.
 *
 * Key schema: `aq.link-adopted-idml-align.v1` (JSON map of project id → file ids).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.link-adopted-idml-align.v1"

type PendingByProject = Readonly<Record<string, readonly string[]>>

const EMPTY: PendingByProject = {}
const NONE: readonly string[] = []
const listeners = new Set<() => void>()
let cached: PendingByProject | undefined

function read(): PendingByProject {
  if (typeof localStorage === "undefined") return EMPTY
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY
    const map: Record<string, readonly string[]> = {}
    for (const [projectId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0)
      if (ids.length > 0) map[projectId] = ids
    }
    return map
  } catch {
    return EMPTY
  }
}

function peek(): PendingByProject {
  if (!cached) cached = read()
  return cached
}

function write(next: PendingByProject): void {
  cached = next
  if (typeof localStorage !== "undefined") {
    try {
      if (Object.keys(next).length === 0) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // quota / access denied — the in-memory map still reflects the edit
    }
  }
  for (const listener of listeners) listener()
}

export function subscribeAdoptedIdmlAlignment(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A link request that named `fileIds` (this project's own files) as taking
 * their source from the upstream was accepted. The join itself may still be
 * pending on the server — the workspace syncs before it places anything.
 */
export function markAdoptedFilesForIdmlAlignment(
  projectId: string,
  fileIds: readonly string[],
): void {
  const ids = fileIds.filter((id) => id.length > 0)
  if (ids.length === 0) return
  const current = peek()
  const merged = [...new Set([...(current[projectId] ?? NONE), ...ids])]
  if (merged.length === (current[projectId] ?? NONE).length) return
  write({ ...current, [projectId]: merged })
}

/** The placement for `fileId` ran (or the file turned out not to need one). */
export function clearAdoptedFileIdmlAlignment(projectId: string, fileId: string): void {
  const current = peek()
  const ids = current[projectId]
  if (!ids || !ids.includes(fileId)) return
  const remaining = ids.filter((id) => id !== fileId)
  const next: Record<string, readonly string[]> = { ...current }
  if (remaining.length === 0) delete next[projectId]
  else next[projectId] = remaining
  write(next)
}

export function adoptedFilesAwaitingIdmlAlignment(projectId: string): readonly string[] {
  return peek()[projectId] ?? NONE
}

export function useAdoptedFilesAwaitingIdmlAlignment(
  projectId: string | null | undefined,
): readonly string[] {
  const map = useSyncExternalStore(subscribeAdoptedIdmlAlignment, peek, () => EMPTY)
  return projectId ? map[projectId] ?? NONE : NONE
}

/** Test-only: drop the in-memory copy so the next read comes from storage. */
export function reloadAdoptedIdmlAlignmentForTests(): void {
  cached = undefined
  for (const listener of listeners) listener()
}

/** Test-only: module state would otherwise leak between cases. */
export function resetAdoptedIdmlAlignmentForTests(): void {
  cached = undefined
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  }
  for (const listener of listeners) listener()
}
