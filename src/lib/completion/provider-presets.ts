// AQU-796: one source of truth for the BYO-provider preset list.
//
// The project-level AI settings (`ProjectSettings.tsx`) and the user-level
// personal override (`settings/PersonalProviderSection.tsx`) both let a user
// point Aquilla at their own OpenAI-compatible endpoint. They used to hold
// their own (or, for the personal surface, no) preset list, so the two could
// drift. Both now render from the list below.
//
// NOTE: the *product* question of what is user- vs org- vs project-scoped is
// still open (AQU-796 item 2, HITL) — this module only keeps the preset data
// from diverging, it does not decide the scope split.

import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

export interface ProviderPreset {
  id: string
  /** Literal brand name — i18n-exempt, shown verbatim in every locale. */
  label?: string
  /** Translated label, for the non-brand entries ("Local", "Custom"). */
  labelKey?: MessageKey
  endpoint: string
  requiresKey: boolean
  keyHint?: string
}

// The non-brand entries carry `labelKey`. The rest are brand names —
// i18n-exempt, left untranslated in every locale like any other
// product/company name (OpenRouter and OpenAI are already in ATOMIC_TERMS;
// Groq/Together AI/Mistral/DeepSeek aren't yet, but are the same kind of
// string).
export const CUSTOM_PRESETS: ProviderPreset[] = [
  { id: "local", labelKey: "projectSettings.advancedLlm.presetLocalLabel", endpoint: "http://localhost:8000", requiresKey: false },
  { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", requiresKey: true, keyHint: "sk-or-..." },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", requiresKey: true, keyHint: "sk-..." },
  { id: "groq", label: "Groq", endpoint: "https://api.groq.com/openai/v1", requiresKey: true, keyHint: "gsk_..." },
  { id: "together", label: "Together AI", endpoint: "https://api.together.xyz/v1", requiresKey: true },
  { id: "mistral", label: "Mistral", endpoint: "https://api.mistral.ai/v1", requiresKey: true },
  { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com/v1", requiresKey: true },
  { id: "custom", labelKey: "projectSettings.advancedLlm.presetCustomLabel", endpoint: "", requiresKey: false },
]

/** The id of the "user types their own URL" entry. Selecting it never rewrites
 * whatever the user has already entered. */
export const CUSTOM_PRESET_ID = "custom"

/** Resolves a preset's display label: translated when `labelKey` is set, else
 * the literal (untranslated brand name). */
export function presetLabel(t: TFunction, preset: Pick<ProviderPreset, "label" | "labelKey">): string {
  return preset.labelKey ? t(preset.labelKey) : (preset.label ?? "")
}

export function findPreset(id: string): ProviderPreset | undefined {
  return CUSTOM_PRESETS.find((p) => p.id === id)
}

/**
 * Which preset an endpoint belongs to. An empty endpoint reads as `local`
 * (the first entry / default), a prefix match wins over nothing, and anything
 * unrecognised is `custom`.
 *
 * This derives the *picker's* value from the endpoint — it never derives the
 * endpoint from the picker, so typing in the endpoint field can't cause the
 * field's own value to be rewritten mid-keystroke (AQU-796 item 3: caret
 * jumps).
 */
export function presetIdForEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "").toLowerCase()
  if (!trimmed) return "local"
  for (const p of CUSTOM_PRESETS) {
    if (!p.endpoint) continue
    const base = p.endpoint.toLowerCase()
    if (trimmed === base || trimmed.startsWith(base)) return p.id
  }
  return CUSTOM_PRESET_ID
}

/**
 * The endpoint a preset selection should apply. Picking `custom` keeps what
 * the user already typed; every other preset pre-fills its own URL so a
 * BYO-key setup never requires hand-typing a full endpoint.
 */
export function endpointForPresetChange(presetId: string, currentEndpoint: string): string {
  const preset = findPreset(presetId)
  if (!preset) return currentEndpoint
  return preset.id === CUSTOM_PRESET_ID ? currentEndpoint : preset.endpoint
}
