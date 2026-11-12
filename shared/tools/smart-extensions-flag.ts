/**
 * AQU-1937: the per-project "Smart Extensions" feature switch, stored as
 * `smartExtensionsEnabled` in the project's settings blob (project_settings,
 * no migration). OFF unless explicitly true, so merging Smart Extensions
 * changes no project until a Maintainer turns it on.
 */

export const SMART_EXTENSIONS_SETTING = "smartExtensionsEnabled"

export function smartExtensionsEnabledIn(settings: unknown): boolean {
  return typeof settings === "object" && settings !== null && (settings as Record<string, unknown>)[SMART_EXTENSIONS_SETTING] === true
}

/** Parse a stored settings blob (JSON text or an object) and read the switch. */
export function smartExtensionsEnabledInRaw(raw: unknown): boolean {
  if (typeof raw === "string") {
    try {
      return smartExtensionsEnabledIn(JSON.parse(raw))
    } catch {
      return false
    }
  }
  return smartExtensionsEnabledIn(raw)
}
