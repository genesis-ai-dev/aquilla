import type { ProjectWideSettings } from "@/lib/sync/project-settings"

/**
 * The value of one shared setting, or of one field of an object setting (the
 * drafting settings). (AQU-2262)
 *
 * Kept out of useProjectSettings so the many tests that stub that hook still
 * get the real reading when a setting saves.
 */
export function readSettingAt(settings: ProjectWideSettings | undefined, key: string, field?: string): unknown {
  const holder = (settings as Record<string, unknown> | undefined)?.[key]
  if (field === undefined) return holder
  return holder && typeof holder === "object" ? (holder as Record<string, unknown>)[field] : undefined
}
