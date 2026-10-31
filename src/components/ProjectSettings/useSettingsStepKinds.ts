/**
 * What undo and redo mean for the steps Project settings record. (AQU-2262)
 *
 * Mounted by Project settings AND by the workspace: a change made in settings
 * is usually undone later from the editor, or from another device that only
 * has the editor open. Registrations stack (registerStepKinds), so the two
 * mounted together are fine.
 *
 * - "settings.project": the shared settings, through whichever settings hook
 *   is mounted for the project (settings-access.ts).
 * - "settings.projectName": the project's name, through the rename endpoint
 *   (the server's name is the one every surface reads) and this browser's copy.
 * - "settings.device": a setting kept only in this browser's copy.
 */
import { useEffect, useRef } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { registerStepKinds } from "@/lib/history/history"
import { settingsProjectHandler } from "@/lib/history/edit-steps"
import { readProjectSettingsFor, writeProjectSettingsFor } from "@/lib/history/settings-access"
import { settingsStepHandlers, thisBrowser } from "@/lib/history/settings-steps"
import { getProject, patchProject } from "@/lib/store/project-index"
import { renameProject } from "@/lib/sync/cloud-projects"
import type { ProjectRecord } from "@/lib/parsers/types"

/** The settings each browser keeps for itself, on its copy of the project. */
export const DEVICE_SETTING_KEYS = ["audioMediaStrategy", "syncSettings", "decaySettings"] as const
export type DeviceSettingKey = (typeof DEVICE_SETTING_KEYS)[number]

/** Write one device setting into this browser's copy; undefined removes it. */
export function withDeviceSetting(record: ProjectRecord, key: string, value: unknown): ProjectRecord {
  const next = { ...record } as Record<string, unknown>
  if (value === undefined || value === null) delete next[key]
  else next[key] = value
  return next as unknown as ProjectRecord
}

export interface SettingsStepKindsOptions {
  /** The project as the page shows it, for a browser with no copy of its own
   *  yet (a project opened straight at its settings). */
  project?: ProjectRecord | null
  /** Undo or Redo changed the name: the page reads the project again. */
  onRenamed?: () => void
}

export function useSettingsStepKinds(projectId: string | null, options: SettingsStepKindsOptions = {}): void {
  const { session } = useFrontierSession()
  const jwtRef = useRef<string | null>(null)
  jwtRef.current = session?.jwt ?? null
  const optionsRef = useRef(options)
  optionsRef.current = options
  useEffect(() => {
    if (!projectId) return
    return registerStepKinds({
      ...settingsProjectHandler({
        readSettings: (keys) => readProjectSettingsFor(projectId, keys),
        writeSettings: (patch, opts) => writeProjectSettingsFor(projectId, patch, opts),
      }),
      ...settingsStepHandlers({
        readName: async () => ((await getProject(projectId)) ?? optionsRef.current.project)?.name ?? null,
        rename: async (name) => {
          const record = (await getProject(projectId)) ?? optionsRef.current.project
          if (!record) throw new Error("project not found")
          if (record.syncRole) {
            const jwt = jwtRef.current
            if (!jwt) throw new Error("signed out")
            await renameProject(jwt, projectId, name)
          }
          await patchProject(projectId, (p) => ({ ...p, name }))
          optionsRef.current.onRenamed?.()
        },
        readDevice: async (key) => {
          const record = await getProject(projectId)
          return record ? ((record as unknown as Record<string, unknown>)[key] ?? null) : undefined
        },
        writeDevice: async (key, value) => {
          await patchProject(projectId, (p) => withDeviceSetting(p, key, value))
        },
        browser: thisBrowser,
      }),
    })
  }, [projectId])
}
