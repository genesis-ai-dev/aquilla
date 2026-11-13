/**
 * AQU-1555 — one-time rename of the pre-rebrand `codex*` browser-local keys.
 *
 * Every browser-local preference key was renamed off the old `codex` app name
 * in August 2026 (`codex:onboardingComplete` → `aquilla:onboardingComplete`,
 * `codex.setupInProgress.<projectId>` → `aquilla.setupInProgress.<projectId>`,
 * `codex-theme` → `aquilla-theme`, …) with no migration, so a browser that used
 * the app before that upgrade still holds the old keys while every reader looks
 * at the new ones — the user silently gets defaults instead of their settings.
 * This moves each leftover key to its current name on the next load.
 *
 * It must run before `claimLegacyClientLocalStorage` (the account-scoping
 * bridge in `@/lib/frontier/client-local-storage`): that bridge only recognises
 * already-renamed keys, so a value still sitting under `codex:` would never
 * reach its owner-scoped home.
 */

/** The rename only replaced the namespace, so each separator survives as-is. */
const LEGACY_PREFIXES = ["codex:", "codex.", "codex-"] as const

const LEGACY_NAMESPACE = "codex"
const CURRENT_NAMESPACE = "aquilla"

/**
 * Keys whose feature was retired alongside the rename: there is nothing to
 * carry forward, and renaming them would resurrect dead data under a live name.
 * `codex-color-theme` held an accent preset, and accent presets were replaced
 * by the brand's neutral light/dark palettes.
 */
const RETIRED_KEYS = new Set<string>(["codex-color-theme"])

/** The current name for a legacy key, or `null` if it is not one of ours. */
function currentNameFor(key: string): string | null {
  if (!LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))) return null
  return CURRENT_NAMESPACE + key.slice(LEGACY_NAMESPACE.length)
}

/**
 * Rename every leftover `codex*` key to its `aquilla*` name. Returns how many
 * values were carried across, for logging and tests.
 *
 * Idempotent: once it has run, no `codex*` key is left for it to find, so a
 * later call writes nothing. A value already stored under the current name wins
 * — the legacy copy is older by construction, so it is dropped rather than
 * allowed to overwrite a newer preference.
 */
export function migrateLegacyCodexLocalStorageKeys(): number {
  if (typeof localStorage === "undefined") return 0
  try {
    // Collected before mutating: removing a key reshuffles the live index.
    const legacyKeys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== null && currentNameFor(key) !== null) legacyKeys.push(key)
    }

    let migrated = 0
    for (const legacyKey of legacyKeys) {
      if (RETIRED_KEYS.has(legacyKey)) {
        localStorage.removeItem(legacyKey)
        continue
      }
      const currentKey = currentNameFor(legacyKey)
      if (currentKey === null) continue
      const value = localStorage.getItem(legacyKey)
      if (value !== null && localStorage.getItem(currentKey) === null) {
        localStorage.setItem(currentKey, value)
        migrated += 1
      }
      localStorage.removeItem(legacyKey)
    }
    return migrated
  } catch {
    // Disabled or full storage: reading defaults for one more load beats
    // failing the boot on a best-effort browser-local rename.
    return 0
  }
}
