import type { CompletionProvider } from "@/lib/parsers/types"

/**
 * Snapshot of every non-flag field in the ProjectSettings form. Used to
 * compare loaded-from-store state against in-flight edits. Experimental
 * flags are deliberately excluded — they persist immediately on toggle
 * and so are never part of "unsaved changes."
 */
export interface SettingsFormSnapshot {
  name: string
  sourceLanguage: string
  targetLanguage: string
  username: string
  provider: CompletionProvider
  endpoint: string
  apiKey: string
  model: string
  maxTokens: number
  temperature: number
  systemPrompt: string
  llmHealthPenalty: number
  autoSyncEnabled: boolean
  autoSyncInterval: number
}

export function isSettingsDirty(
  loaded: SettingsFormSnapshot | null,
  current: SettingsFormSnapshot,
): boolean {
  if (!loaded) return false
  const keys = Object.keys(loaded) as (keyof SettingsFormSnapshot)[]
  for (const k of keys) {
    if (loaded[k] !== current[k]) return true
  }
  return false
}
