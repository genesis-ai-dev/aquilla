import { useCallback } from "react"
import { getProject, updateProject } from "@/lib/store/project-index"
import { DEFAULT_SYSTEM_PROMPT, FRONTIER_CHAT_URL, resolveProvider } from "@/lib/completion/completion-service"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"

/**
 * Build a full CompletionSettings from partial overrides, filling defaults.
 *
 * `systemPrompt` intentionally defaults to "" (not DEFAULT_SYSTEM_PROMPT).
 * Otherwise saving any other field — say, the AI provider — would silently
 * mark the project as having custom instructions, completing the "Set AI
 * instructions" checklist step the user never touched. Consumers (see
 * useCompletion, InstructionsSection) already fall back to
 * DEFAULT_SYSTEM_PROMPT at read time, so leaving it blank here is safe.
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
    systemPrompt: overrides.systemPrompt ?? base?.systemPrompt ?? "",
    llmHealthPenalty: overrides.llmHealthPenalty ?? base?.llmHealthPenalty ?? 0.1,
    // AQU-408: these v1 retrieval-tuning keys were previously omitted here,
    // so every save silently reset them to their factory defaults (or, when
    // called with only e.g. a systemPrompt override, dropped whatever the
    // user had set entirely) — the ProjectSettings.tsx Save Changes handler
    // funnels every completion-settings edit through this function.
    top_k: overrides.top_k ?? base?.top_k ?? 15,
    contextSize: overrides.contextSize ?? base?.contextSize ?? "medium",
    useOnlyValidatedExamples: overrides.useOnlyValidatedExamples ?? base?.useOnlyValidatedExamples ?? false,
    main_chat_language: overrides.main_chat_language ?? base?.main_chat_language ?? "",
    fewShotExampleFormat: overrides.fewShotExampleFormat ?? base?.fewShotExampleFormat ?? "source-and-target",
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
