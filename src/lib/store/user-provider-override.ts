/**
 * Per-user, per-device override for the AI completion provider. Stored in
 * localStorage because it's a personal credential that must not sync across
 * devices or projects. When set, this beats `project.completionSettings`
 * at request time inside `completion-service.complete()`.
 *
 * This is the *advanced* path: surfaced only in user Settings, never in the
 * onboarding wizard. The happy path is "sign in to Frontier — done."
 */

const KEY = "codex:userProviderOverride"

export interface UserProviderOverride {
  /** OpenAI-compatible base URL (e.g. "https://openrouter.ai/api/v1"). */
  endpoint: string
  /** Optional model id. Empty string means "let the provider pick". */
  model?: string
  /** Optional bearer token for authenticated endpoints. */
  apiKey?: string
}

export function getUserProviderOverride(): UserProviderOverride | null {
  if (typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UserProviderOverride>
    if (!parsed?.endpoint || typeof parsed.endpoint !== "string") return null
    return {
      endpoint: parsed.endpoint,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
    }
  } catch {
    return null
  }
}

export function setUserProviderOverride(override: UserProviderOverride): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(KEY, JSON.stringify(override))
}

export function clearUserProviderOverride(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(KEY)
}
