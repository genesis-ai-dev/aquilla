/**
 * Whether the first-party "Aquilla Editor" extension is the DEFAULT editor
 * (and gets installed into the project on open). On by default.
 *
 * Off switches, in order:
 * - localStorage `aquilla.extensions.defaultEditor` = "off" (per browser;
 *   "on" forces it on),
 * - build env `VITE_EXTENSION_DEFAULT_EDITOR=off`. The e2e stack sets this so
 *   the existing editor smoke journeys keep exercising the built-in editor they
 *   were written for; the extension-editor specs opt back in per page.
 * Either way the built-in editor stays one switch away ("Standard editor").
 */

export const DEFAULT_EDITOR_FLAG_KEY = "aquilla.extensions.defaultEditor"

export function defaultEditorExtensionEnabled(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
  envValue: string | undefined = import.meta.env.VITE_EXTENSION_DEFAULT_EDITOR as string | undefined,
): boolean {
  try {
    const local = storage?.getItem(DEFAULT_EDITOR_FLAG_KEY)
    if (local === "on") return true
    if (local === "off") return false
  } catch {
    // blocked storage → fall through to the build default
  }
  return envValue !== "off"
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}
