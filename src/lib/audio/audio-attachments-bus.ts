// Tiny per-file pub/sub so scattered audio producers (the recording modal in
// ProjectWorkspace, the TTS / clone buttons in EditorRow) can poke the
// per-file attachments read to refetch after they emit a cell.audio.* event —
// without threading a revalidate callback through every component.
//
// Mirrors the module-level coordinator pattern already used for active audio
// playback (audio-coordinator.ts) and TTS status (tts.ts).

type Listener = () => void

const listenersByFile = new Map<string, Set<Listener>>()

/** Subscribe to "attachments changed" pokes for one file. Returns unsubscribe. */
export function subscribeAudioAttachments(fileId: string, cb: Listener): () => void {
  let set = listenersByFile.get(fileId)
  if (!set) {
    set = new Set()
    listenersByFile.set(fileId, set)
  }
  set.add(cb)
  return () => {
    const s = listenersByFile.get(fileId)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) listenersByFile.delete(fileId)
  }
}

/** Notify subscribers that a file's audio attachments changed. */
export function notifyAudioAttachmentsChanged(fileId: string): void {
  listenersByFile.get(fileId)?.forEach((cb) => {
    try {
      cb()
    } catch {
      // a failing listener must not block the others
    }
  })
}
