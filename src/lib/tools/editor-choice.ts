/**
 * Smart Extensions: which editor a user edits a file with — the standard
 * editor or an extension that declares the `editor` mount. Remembered per
 * user and project, per file, with an optional project-wide default. A local
 * preference (localStorage), like the dock tab and editor lens.
 */

export const STANDARD_EDITOR = "standard"

export interface EditorChoiceState {
  /** Project-wide choice: an extension id or "standard" (null = the default). */
  project: string | null
  /** Per-file choice: an extension id or "standard". Wins over the default. */
  files: Record<string, string>
}

const EMPTY: EditorChoiceState = { project: null, files: {} }

export function editorChoiceKey(username: string, projectId: string): string {
  return `aquilla.extensions.editor.v1:${username}:${projectId}`
}

export function readEditorChoice(username: string, projectId: string, storage: Storage | null = safeStorage()): EditorChoiceState {
  if (!storage) return EMPTY
  try {
    const raw = storage.getItem(editorChoiceKey(username, projectId))
    if (!raw) return EMPTY
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return EMPTY
    const obj = parsed as Record<string, unknown>
    const files: Record<string, string> = {}
    if (obj.files && typeof obj.files === "object") {
      for (const [k, v] of Object.entries(obj.files as Record<string, unknown>)) if (typeof v === "string") files[k] = v
    }
    return { project: typeof obj.project === "string" ? obj.project : null, files }
  } catch {
    return EMPTY
  }
}

export function writeEditorChoice(username: string, projectId: string, state: EditorChoiceState, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(editorChoiceKey(username, projectId), JSON.stringify(state))
  } catch {
    // quota / private mode — the in-memory choice still applies this session
  }
}

/** The editor to use for `fileId`, given which editor extensions are installed.
 *  With no remembered choice the default applies: the first-party editor
 *  extension when it is installed (`defaultEditor`), else the standard editor.
 *  A remembered extension that is no longer installed falls back to it too. */
export function resolveEditor(
  state: EditorChoiceState,
  fileId: string,
  installed: readonly string[],
  defaultEditor: string | null = null,
): string {
  const fallback = defaultEditor && installed.includes(defaultEditor) ? defaultEditor : STANDARD_EDITOR
  const pick = state.files[fileId] ?? state.project ?? fallback
  return pick === STANDARD_EDITOR || installed.includes(pick) ? pick : fallback
}

/** Choose an editor for one file, or (wholeProject) as the project default. */
export function chooseEditor(state: EditorChoiceState, fileId: string, editorId: string, wholeProject: boolean): EditorChoiceState {
  if (wholeProject) {
    // A project-wide pick clears per-file overrides so it takes effect
    // everywhere. "standard" is stored explicitly: it must win over a
    // default editor extension.
    return { project: editorId, files: {} }
  }
  return { ...state, files: { ...state.files, [fileId]: editorId } }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}
