// AQU-2263: which AI key is in use right now, for the line every key field
// and key-choosing screen shows ("Using this project's key (this device
// only)", "Using your own key (Preferences)", …).
//
// A READING of the rules the requests follow, never a second copy of them:
// the drafting target is resolveEffectiveCompletionSettings (a project's own
// provider beats your Preferences override, which beats the platform
// provider), and the key is resolveApiKey (project > personal > organization).
// Nothing here changes how a key is stored or chosen.
//
// The Gemini voice key: resolveApiKey would fall back to the organization's
// key, but no voice request passes it one (synthesizeForCell's `orgApiKey` has
// no caller, and only Maintainers can read the key at all), so an organization
// key on its own is not in use. The line says so rather than claiming it is.

import type { CompletionSettings } from "@/lib/parsers/types"
import type { UserProviderOverride } from "@/lib/store/user-provider-override"
import {
  customProviderNeedsKey,
  projectUsesOwnProvider,
  resolveEffectiveCompletionSettings,
} from "@/lib/completion/completion-service"

export type CompletionKeyInUse =
  /** The platform provider: no key. */
  | "platform"
  /** This project's own key, kept on this device. */
  | "project-key"
  /** Your own key, saved in this browser from a project's key field. */
  | "personal-key"
  /** Your own provider and key from Preferences → AI provider keys. */
  | "preferences"
  /** Your own provider from Preferences, which needs no key. */
  | "preferences-no-key"
  /** This project's own provider, which needs no key. */
  | "no-key-needed"
  /** The provider needs a key and none is set. */
  | "missing"

export function completionKeyInUse(input: {
  /** The project's saved completion settings (the team's provider, this device's key). */
  settings: Partial<Pick<CompletionSettings, "provider" | "endpoint" | "apiKey">> | undefined
  override: UserProviderOverride | null | undefined
  /** The key saved in this browser by "Save across my projects". */
  personalKey: string | undefined
}): CompletionKeyInUse {
  const base = { provider: "frontier", endpoint: "", ...input.settings } as CompletionSettings
  const resolved = resolveEffectiveCompletionSettings(base, input.override)
  const own = projectUsesOwnProvider(base)
  const viaOverride = !own && resolved !== base
  if (!own && !viaOverride) return "platform"
  const endpoint = (resolved.endpoint ?? "").trim()
  if (resolved.apiKey?.trim()) return viaOverride ? "preferences" : "project-key"
  if (input.personalKey?.trim()) return "personal-key"
  if (customProviderNeedsKey(endpoint)) return "missing"
  return viaOverride ? "preferences-no-key" : "no-key-needed"
}

export type GeminiKeyInUse = "project-key" | "personal-key" | "org-unused" | "missing"

export function geminiKeyInUse(input: {
  /** This project's saved Gemini key on this device. */
  projectKey: string | undefined
  /** The Gemini key saved in this browser by "Save across my projects". */
  personalKey: string | undefined
  /** Whether the organization has saved a Gemini key (its value may be hidden). */
  orgHasKey: boolean
}): GeminiKeyInUse {
  if (input.projectKey?.trim()) return "project-key"
  if (input.personalKey?.trim()) return "personal-key"
  return input.orgHasKey ? "org-unused" : "missing"
}
