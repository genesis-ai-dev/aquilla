// Module-level registry for the imperative voice entry points.
//
// EditorTable (and the per-cell AI-status popovers) call into voice features
// through plain function imports — `openVoiceModalFromAnywhere` to surface the
// voice library, `handleVoiceDropOnCell` when a voice chip is dropped on a row.
// These callers don't hold project/session context, so a host component that
// does (VoiceController, mounted in ProjectWorkspace) registers the real
// handlers here on mount and the standalone functions delegate to whatever is
// currently registered. When no host is mounted they degrade to no-ops.

/** DnD payload key carrying a voice id from a draggable chip to a cell row. */
export const VOICE_DRAG_MIME = "application/x-frontier-voice-id"

type OpenModalFn = (focus?: "apiKey") => void
type DropFn = (cellId: string, voiceId: string) => Promise<void>

export interface VoiceActions {
  openModal: OpenModalFn
  drop: DropFn
}

let current: VoiceActions | null = null

/** Register the live voice handlers. Returns an unregister fn for cleanup. */
export function registerVoiceActions(actions: VoiceActions): () => void {
  current = actions
  return () => {
    if (current === actions) current = null
  }
}

/** Open the project's voice library. `focus` pins a recovery affordance. */
export function openVoiceModalFromAnywhere(focus?: "apiKey"): void {
  current?.openModal(focus)
}

/** Generate + attach a voice for `cellId` using the dropped `voiceId`. */
export function handleVoiceDropOnCell(cellId: string, voiceId: string): Promise<void> {
  return current?.drop(cellId, voiceId) ?? Promise.resolve()
}
