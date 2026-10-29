// AQU-2259: the team's AI drafting settings, as the SPA reads and writes them.
//
// The stored shape and its validation live in db/shared/drafting-settings.ts
// (shared with both workers). This module is the SPA's side: turning a
// `CompletionSettings` (a form, or this browser's old copy) into the shared
// value, laying the shared value over a record, and deciding whether this
// browser's old values should be uploaded once.
//
// THE KEY NEVER MOVES. `apiKey` on the record is the project's AI key for this
// device; it stays there, alongside the personal and organization keys
// (project > personal > org, `resolveApiKey`). Nothing here copies it into
// the shared value, and the server refuses one there.

import type { CompletionSettings } from "@/lib/parsers/types"
import { buildCompletionSettings } from "@/hooks/useCompletionSettings"
import {
  DEFAULT_COMPLETION_MAX_TOKENS,
  normalizeCompletionMaxTokens,
  resolveProvider,
} from "@/lib/completion/completion-service"
import { DEFAULT_APPROVED_EXAMPLE_COUNT } from "@/lib/completion/prompt-build"
import { DEFAULT_COMPLETION_BATCH_SIZE } from "../../../db/shared/completion-batch"
import {
  DRAFTING_SETTINGS_FIELDS,
  readDraftingSettings,
  type DraftingSettings,
} from "../../../db/shared/drafting-settings"

export type { DraftingSettings } from "../../../db/shared/drafting-settings"

/** What every field means when nobody has set it. */
const DRAFTING_DEFAULTS: Required<DraftingSettings> = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: DEFAULT_COMPLETION_MAX_TOKENS,
  temperature: 0.3,
  llmHealthPenalty: 0.1,
  top_k: DEFAULT_APPROVED_EXAMPLE_COUNT,
  contextSize: "medium",
  useOnlyValidatedExamples: true,
  main_chat_language: "",
  fewShotExampleFormat: "source-and-target",
  completionBatchSize: DEFAULT_COMPLETION_BATCH_SIZE,
  validationBatchSize: 0,
}

/**
 * The drafting fields of a set of completion settings, as the shared value:
 * every field present, normalised the way drafting reads it, and nothing that
 * is not a drafting field — so never the AI key or the written instructions.
 * A value the shared settings would refuse (out of range) is left out, so it
 * reads as its default instead of failing the save.
 */
export function draftingSettingsFrom(settings: Partial<CompletionSettings> | undefined): DraftingSettings {
  const full = buildCompletionSettings(settings, {})
  return readDraftingSettings({
    provider: settings ? resolveProvider(full) : DRAFTING_DEFAULTS.provider,
    endpoint: full.endpoint.trim(),
    model: full.model,
    maxTokens: normalizeCompletionMaxTokens(full.maxTokens),
    temperature: full.temperature,
    llmHealthPenalty: full.llmHealthPenalty,
    top_k: full.top_k,
    contextSize: full.contextSize,
    useOnlyValidatedExamples: true,
    main_chat_language: full.main_chat_language,
    fewShotExampleFormat: full.fewShotExampleFormat,
    completionBatchSize: full.completionBatchSize ?? DRAFTING_DEFAULTS.completionBatchSize,
    validationBatchSize: full.validationBatchSize ?? DRAFTING_DEFAULTS.validationBatchSize,
  }) ?? {}
}

/**
 * Do these values say anything the defaults don't? The endpoint only counts
 * for a custom provider (the platform provider ignores it), and "validated
 * examples only" is always on, so neither alone makes a browser's copy worth
 * uploading.
 */
export function draftingDiffersFromDefaults(settings: DraftingSettings): boolean {
  for (const field of DRAFTING_SETTINGS_FIELDS) {
    if (field === "useOnlyValidatedExamples") continue
    if (field === "endpoint" && settings.provider !== "custom") continue
    const value = settings[field]
    if (value === undefined) continue
    if (value !== DRAFTING_DEFAULTS[field]) return true
  }
  return false
}

/**
 * The record's completion settings with the team's drafting settings laid
 * over them. Each drafting field comes from the shared value, or its default
 * when the team left it unset — never from this browser's copy. Only the two
 * things the shared value never carries come from the record: this device's
 * project AI key and the instructions (which the top-level `systemPrompt`
 * overlays separately).
 */
export function applyDraftingSettings(
  local: CompletionSettings | undefined,
  shared: DraftingSettings,
): CompletionSettings {
  return buildCompletionSettings(undefined, {
    ...shared,
    ...(local?.apiKey !== undefined ? { apiKey: local.apiKey } : {}),
    ...(local?.systemPrompt !== undefined ? { systemPrompt: local.systemPrompt } : {}),
  })
}

/**
 * The one-time upload (AQU-2259). Before the drafting settings were shared,
 * each browser kept its own. When someone who may change project settings
 * opens the project, the server has no drafting settings yet, and their
 * browser holds values that differ from the defaults, those values become the
 * team's. The first browser to do so wins; after that the shared value is the
 * only one anybody reads. Returns what to upload, or null.
 */
export function draftingSettingsToUpload(args: {
  canEdit: boolean
  serverDrafting: unknown
  local: CompletionSettings | undefined
}): DraftingSettings | null {
  if (!args.canEdit) return null
  if (args.serverDrafting != null) return null
  if (!args.local) return null
  const candidate = draftingSettingsFrom(args.local)
  return draftingDiffersFromDefaults(candidate) ? candidate : null
}
