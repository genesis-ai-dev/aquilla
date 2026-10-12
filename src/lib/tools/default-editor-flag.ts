/**
 * Whether the first-party "Aquilla Editor" extension is the DEFAULT editor.
 * OFF by default: the Aquilla native (built-in) editor is everyone's default.
 * The extension editor proves the whole editor can be built as a Smart
 * Extension; it is always installed into the project (so it can be picked),
 * but a user only edits with it after opting in.
 *
 * Ways to opt in, in order:
 * - the "Edit with" picker, per file or "Use for every file in this project"
 *   (editor-choice.ts) — the product's opt-in, remembered per user + project;
 * - localStorage `aquilla.extensions.defaultEditor` = "on" (per browser; "off"
 *   forces the native default back). `E2E_EDITOR=extension` sets it so the
 *   core journeys run against the extension editor;
 * - build env `VITE_EXTENSION_DEFAULT_EDITOR=on`.
 * Either way the native editor stays one switch away ("Standard editor").
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
  return envValue === "on"
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}
