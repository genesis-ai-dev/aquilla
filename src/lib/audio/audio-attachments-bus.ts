// Tiny per-file pub/sub so scattered audio producers (the recording modal in
// ProjectWorkspace, the TTS / clone buttons in EditorRow) can poke the
// per-file attachments read to refetch after they emit a cell.audio.* event —
// without threading a revalidate callback through every component.
//
// Mirrors the module-level coordinator pattern already used for active audio
// playback (audio-coordinator.ts) and TTS status (tts.ts).

import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

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

// ── Optimistic injection channel ──────────────────────────────────────────
// A producer (recording modal, TTS) emits a cell.audio.attach event to the
// outbox, which returns *before* the server projects it. A plain
// notify→refetch therefore reads stale (no clip) and the gutter mic stays a
// mic until a manual reload. This channel lets the producer hand the read hook
// the attachment it just created so `hasAudio` flips immediately; the eventual
// refetch reconciles it with server truth.

type OptimisticListener = (cellId: string, attachment: AudioAttachmentOut) => void

const optimisticByFile = new Map<string, Set<OptimisticListener>>()

/** Subscribe to optimistic attachment injections for one file. Returns unsubscribe. */
export function subscribeOptimisticAudioAttachment(
  fileId: string,
  cb: OptimisticListener,
): () => void {
  let set = optimisticByFile.get(fileId)
  if (!set) {
    set = new Set()
    optimisticByFile.set(fileId, set)
  }
  set.add(cb)
  return () => {
    const s = optimisticByFile.get(fileId)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) optimisticByFile.delete(fileId)
  }
}

/** Optimistically surface a just-created attachment for one cell in `fileId`. */
export function injectOptimisticAudioAttachment(
  fileId: string,
  cellId: string,
  attachment: AudioAttachmentOut,
): void {
  recordShadow(fileId, cellId, attachment)
  optimisticByFile.get(fileId)?.forEach((cb) => {
    try {
      cb(cellId, attachment)
    } catch {
      // a failing listener must not block the others
    }
  })
}

// ── Shadow registry (round 8d) ────────────────────────────────────────────
// Injections are retained MODULE-LEVEL, not per hook instance: a reader that
// mounts AFTER the inject (e.g. the recording modal opened right after an
// upload) must still see the attachment on its first fetch — the outbox
// flusher posts on a ~5s timer, so that fetch reads pre-projection state.
// Readers re-apply unconfirmed shadows over every fetch and prune confirmed/
// expired ones (see useFileAudioAttachments.shadowConfirmed).

export interface OptimisticShadow {
  att: AudioAttachmentOut
  appliedAt: number
  /** Only the NEWEST shadow per slot claims the slot's selection — an older
   *  select superseded by a later one must never resurrect it. */
  claimsSelection: boolean
}

const shadowsByFile = new Map<string, Map<string, OptimisticShadow[]>>()

function recordShadow(fileId: string, cellId: string, att: AudioAttachmentOut): void {
  let byCell = shadowsByFile.get(fileId)
  if (!byCell) {
    byCell = new Map()
    shadowsByFile.set(fileId, byCell)
  }
  const shadows = byCell.get(cellId) ?? []
  byCell.set(cellId, [
    ...shadows
      .filter((s) => s.att.audioId !== att.audioId || s.att.slot !== att.slot)
      .map((s) => (s.att.slot === att.slot ? { ...s, claimsSelection: false } : s)),
    { att, appliedAt: Date.now(), claimsSelection: true },
  ])
}

/** The live shadow map for a file (cellId → shadows). Readers may prune it. */
export function getOptimisticShadows(fileId: string): Map<string, OptimisticShadow[]> {
  return shadowsByFile.get(fileId) ?? new Map()
}

/** Drop every shadow for a file (used by tests). */
export function clearOptimisticShadows(fileId: string): void {
  shadowsByFile.delete(fileId)
}
