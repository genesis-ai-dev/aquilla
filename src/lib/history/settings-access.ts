/**
 * How a history step reaches a project's shared settings. (AQU-1767 phase 2)
 *
 * The settings live behind `useProjectSettings` (a hook: its own server
 * snapshot, write queue and conflict handling), but a settings step is undone
 * from wherever the person presses Undo — usually the workspace, long after
 * the settings page closed. Every mounted settings hook registers a reader and
 * a writer for its project here, and the step's handler uses whichever is
 * mounted. The writes go through the hook's own patch, so they get the same
 * version check, optimistic apply and broadcast as a save from the page.
 */

export interface SettingsAccessor {
  read(): Record<string, unknown>
  write(patch: Record<string, unknown>): Promise<void>
}

const accessors = new Map<string, Set<SettingsAccessor>>()

export function registerSettingsAccessor(projectId: string, accessor: SettingsAccessor): () => void {
  let set = accessors.get(projectId)
  if (!set) {
    set = new Set()
    accessors.set(projectId, set)
  }
  set.add(accessor)
  return () => {
    const current = accessors.get(projectId)
    current?.delete(accessor)
    if (current && current.size === 0) accessors.delete(projectId)
  }
}

function first(projectId: string | null): SettingsAccessor | null {
  if (!projectId) return null
  const set = accessors.get(projectId)
  return set ? ([...set][set.size - 1] ?? null) : null
}

/** The named settings as they stand now, or null when none can be read. */
export function readProjectSettingsFor(projectId: string | null, keys: readonly string[]): Record<string, unknown> | null {
  const accessor = first(projectId)
  if (!accessor) return null
  const all = accessor.read()
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = all[key]
  return out
}

/** Write a patch through a mounted settings hook. Throws when it did not save. */
export async function writeProjectSettingsFor(projectId: string | null, patch: Record<string, unknown>): Promise<void> {
  const accessor = first(projectId)
  if (!accessor) throw new Error("project settings are not available")
  await accessor.write(patch)
}
