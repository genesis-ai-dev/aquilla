/**
 * Whether the first-party "Aquilla editor (Smart Extension)" is the DEFAULT
 * editor for a user who never chose one. ON by default (Daniel, 2026-10-12):
 * shipping the extension as the default forces every future editor change to
 * stay possible through the Smart Extensions API, so anything others build on
 * it can do whatever the built-in editor can.
 *
 * The original "Aquilla editor" (native) is always one click away for ANY
 * user — "Use the original Aquilla editor" beside "Edit with", remembered per
 * user and project (editor-choice.ts), never gated by role or extension
 * permissions — and it is the fallback whenever the extension fails to load.
 *
 * Overrides, in order:
 * - localStorage `aquilla.extensions.defaultEditor` = "off" (native default
 *   for this browser) / "on";
 * - build env `VITE_EXTENSION_DEFAULT_EDITOR=off`. The e2e stack pins it off so
 *   the native-editor journeys keep exercising the native editor;
 *   `E2E_EDITOR=extension` sets the localStorage override back on.
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
