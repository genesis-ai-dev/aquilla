import { useCallback } from "react"
import { getProject, updateProject } from "@/lib/store/project-index"
import { DEFAULT_SYSTEM_PROMPT, FRONTIER_CHAT_URL, resolveProvider } from "@/lib/completion/completion-service"
import type { ProjectRecord, CompletionSettings, CompletionProvider } from "@/lib/parsers/types"

/**
 * Build a full CompletionSettings from partial overrides, filling defaults.
 */
export function buildCompletionSettings(
  base: Partial<CompletionSettings> | undefined,
  overrides: Partial<CompletionSettings>,
): CompletionSettings {
  return {
    provider: overrides.provider ?? base?.provider ?? "frontier",
    endpoint: overrides.endpoint ?? base?.endpoint ?? "",
    apiKey: overrides.apiKey ?? base?.apiKey,
    model: overrides.model ?? base?.model ?? "",
    maxTokens: overrides.maxTokens ?? base?.maxTokens ?? 512,
    temperature: overrides.temperature ?? base?.temperature ?? 0.3,
    systemPrompt: overrides.systemPrompt ?? base?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    llmHealthPenalty: overrides.llmHealthPenalty ?? base?.llmHealthPenalty ?? 0.1,
  }
}

/**
 * Get the resolved provider for a given settings object.
 */
export { resolveProvider }
export { DEFAULT_SYSTEM_PROMPT, FRONTIER_CHAT_URL }

/**
 * A hook that provides a safe, race-free way to update completion settings
 * on a project. Always reads the latest from IDB before merging, so
 * multiple callers (checklist, settings page) don't overwrite each other.
 */
export function useSaveCompletionSettings(
  projectId: string | undefined,
  onUpdated: (p: ProjectRecord) => void,
) {
  const save = useCallback(
    async (overrides: Partial<CompletionSettings>) => {
      if (!projectId) return
      const latest = await getProject(projectId)
      if (!latest) return
      const merged = buildCompletionSettings(latest.completionSettings, overrides)
      const updated: ProjectRecord = { ...latest, completionSettings: merged }
      await updateProject(updated)
      onUpdated(updated)
    },
    [projectId, onUpdated],
  )

  return save
}
