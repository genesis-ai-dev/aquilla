// Tiny per-file pub/sub so scattered audio producers (the recording modal in
// ProjectWorkspace, the TTS / clone buttons in EditorRow) can poke the
// per-file attachments read to refetch after they emit a cell.audio.* event —
// without threading a revalidate callback through every component.
//
// Mirrors the module-level coordinator pattern already used for active audio
// playback (audio-coordinator.ts) and TTS status (tts.ts).

import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { getOutboxFileAudioRecords } from "@/lib/sync/outbox"

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

// ── Optimistic overlay channel ────────────────────────────────────────────
// A producer (recording modal, TTS, take select, trim, delete) enqueues a
// cell.audio.* event to the outbox, which returns *before* the server projects
// it. A plain notify→refetch therefore reads stale state and the UI reverts.
// Producers hand the intended result to this channel; readers paint it at once
// and keep re-applying it over every fetch until the server catches up.
//
// SUB-48 — the overlay's lifetime is anchored to the OUTBOX, not a wall clock.
// The flusher backs off to 60s and background tabs throttle timers, so an
// event can legitimately sit queued for minutes; a wall-clock TTL made freshly
// recorded takes evaporate from the screen while they were perfectly safe on
// disk. Phases:
//   binding  — injected; the event id hasn't arrived yet (emit still pending).
//              Bounded by UNBOUND_TTL_MS so a never-emitted overlay can't
//              pin a lie forever.
//   queued   — bound to an event id that is still in the outbox. NEVER expires:
//              this device owns that change until it is delivered.
//   settled  — the event has left the outbox (delivered, or quarantined).
//              Lives SETTLED_GRACE_MS longer to cover the projection/read lag,
//              then yields to server truth.

export type AudioSlot = "recording" | "generatedVoice"

export type ShadowPhase = "binding" | "queued" | "settled"

interface ShadowCore {
  /** Stable identity for late binding / removal, independent of array order. */
  key: number
  eventId: string | null
  phase: ShadowPhase
  /** Anchor for the phase's deadline: inject time while `binding`, and reset
   *  to "now" at the moment a fetch first observes the event left the outbox. */
  graceStartedAt: number
}

export type OptimisticShadow = ShadowCore &
  (
    | {
        kind: "attach"
        att: AudioAttachmentOut
        /** Only the NEWEST shadow per slot claims that slot's selection — an
         *  older select superseded by a later one keeps its attachment visible
         *  but must never resurrect its selection once the newer one lands. */
        claimsSelection: boolean
      }
    | { kind: "remove"; audioId: string; slot: AudioSlot }
  )

/** How long an overlay outlives its event's departure from the outbox. */
export const SETTLED_GRACE_MS = 12_000
/** How long an overlay that never learned its event id may survive. */
export const UNBOUND_TTL_MS = 15_000

type OptimisticListener = (cellId: string, shadow: OptimisticShadow) => void

const optimisticByFile = new Map<string, Set<OptimisticListener>>()
/** fileId → cellId → shadows, in chronological order (replay order matters:
 *  delete-then-rerecord must compose to "the new take"). */
const shadowsByFile = new Map<string, Map<string, OptimisticShadow[]>>()
let nextShadowKey = 1

/** Subscribe to optimistic overlay changes for one file. Returns unsubscribe. */
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

function broadcast(fileId: string, cellId: string, shadow: OptimisticShadow): void {
  optimisticByFile.get(fileId)?.forEach((cb) => {
    try {
      cb(cellId, shadow)
    } catch {
      // a failing listener must not block the others
    }
  })
}

function cellMap(fileId: string): Map<string, OptimisticShadow[]> {
  let byCell = shadowsByFile.get(fileId)
  if (!byCell) {
    byCell = new Map()
    shadowsByFile.set(fileId, byCell)
  }
  return byCell
}

/** Late-bind an event id once its emit resolves (no-op if the shadow is gone). */
function bindShadowEvent(fileId: string, key: number, eventId: string): void {
  const byCell = shadowsByFile.get(fileId)
  if (!byCell) return
  for (const list of byCell.values()) {
    const shadow = list.find((s) => s.key === key)
    if (!shadow) continue
    if (shadow.phase === "binding") {
      shadow.eventId = eventId
      shadow.phase = "queued"
    }
    return
  }
}

function dropShadowByKey(fileId: string, key: number): boolean {
  const byCell = shadowsByFile.get(fileId)
  if (!byCell) return false
  for (const [cellId, list] of byCell) {
    const i = list.findIndex((s) => s.key === key)
    if (i === -1) continue
    const next = [...list.slice(0, i), ...list.slice(i + 1)]
    if (next.length === 0) byCell.delete(cellId)
    else byCell.set(cellId, next)
    return true
  }
  return false
}

/**
 * Wire an overlay to the event that will make it real. Callers that already
 * awaited their emit pass the id; callers that paint BEFORE awaiting (so the
 * UI moves with zero latency) pass the emit promise itself. A rejected emit
 * means the change never happened — the overlay is dropped and readers are
 * poked so server truth wins.
 */
function attachEventBinding(
  fileId: string,
  shadow: OptimisticShadow,
  eventId?: string | Promise<string>,
): void {
  if (typeof eventId === "string") {
    shadow.eventId = eventId
    shadow.phase = "queued"
    return
  }
  if (!eventId) return // stays `binding`; UNBOUND_TTL_MS bounds the exposure
  void eventId.then(
    (id) => bindShadowEvent(fileId, shadow.key, id),
    () => {
      if (dropShadowByKey(fileId, shadow.key)) notifyAudioAttachmentsChanged(fileId)
    },
  )
}

/**
 * `pendingSync` is a VIEW flag the reader stamps onto the copy it paints. It
 * must never be stored on an overlay: callers routinely re-inject an
 * attachment they read back out of the merged view (the takes strip hands the
 * take it is displaying straight to `circle`), and a stored flag would keep
 * claiming "saving…" long after the event was delivered.
 */
function withoutViewFlags(att: AudioAttachmentOut): AudioAttachmentOut {
  if (!att.pendingSync) return att
  const { pendingSync: _ignored, ...rest } = att
  return rest
}

/** Optimistically surface a just-created/selected attachment for one cell.
 *
 * `opts.claimSelection: false` paints the attachment's data without touching
 * which take is active — for metadata-only updates (the duration measure
 * backfill), where promoting an arbitrary take would be a real bug.
 *
 * A non-claiming inject is also deliberately NON-DESTRUCTIVE, because it can
 * land in the middle of a long batch while the user is doing things:
 *   - it never cancels a pending DELETE of the same clip (a metadata write is
 *     no reason to resurrect a take the user just removed);
 *   - it never supersedes a live intent for the same clip — it stamps its
 *     fields onto that intent instead, so a selection or trim made mid-batch
 *     keeps its claim and its own values.
 * A claiming inject keeps the original supersede-outright semantics: it
 * represents a NEW user intent, which really should win.
 */
export function injectOptimisticAudioAttachment(
  fileId: string,
  cellId: string,
  incoming: AudioAttachmentOut,
  eventId?: string | Promise<string>,
  opts?: { claimSelection?: boolean },
): void {
  const claimSelection = opts?.claimSelection ?? true
  const attachment = withoutViewFlags(incoming)
  const byCell = cellMap(fileId)
  const list = byCell.get(cellId) ?? []

  if (!claimSelection) {
    // The user's delete outranks a metadata write — drop this paint entirely.
    if (list.some((s) => s.kind === "remove" && s.audioId === attachment.audioId)) return
    const live = list.find(
      (s) => s.kind === "attach" && s.att.audioId === attachment.audioId && s.att.slot === attachment.slot,
    )
    if (live && live.kind === "attach") {
      // Merge onto the live intent: keep ITS values (a mid-batch trim/select),
      // take only the measured duration this inject exists to deliver.
      live.att = { ...live.att, durationMs: attachment.durationMs }
      attachEventBinding(fileId, live, eventId)
      broadcast(fileId, cellId, live)
      return
    }
  }

  const kept = list.filter(
    (s) =>
      // Same clip + slot: this injection supersedes the older one outright.
      !(s.kind === "attach" && s.att.audioId === attachment.audioId && s.att.slot === attachment.slot) &&
      // A pending delete of this very clip is contradicted by re-attaching it.
      !(s.kind === "remove" && s.audioId === attachment.audioId),
  )
  if (claimSelection) {
    // Older intents in this slot keep their attachment but surrender the claim.
    for (const s of kept) {
      if (s.kind === "attach" && s.att.slot === attachment.slot) s.claimsSelection = false
    }
  }
  const shadow: OptimisticShadow = {
    key: nextShadowKey++,
    eventId: null,
    phase: "binding",
    graceStartedAt: Date.now(),
    kind: "attach",
    att: attachment,
    claimsSelection: claimSelection,
  }
  byCell.set(cellId, [...kept, shadow])
  attachEventBinding(fileId, shadow, eventId)
  broadcast(fileId, cellId, shadow)
}

/**
 * Optimistically hide a just-deleted clip. Also neutralises any live attach
 * overlay for the same clip — without this, deleting a take you just recorded
 * left its attach overlay painting the take back for the rest of its lifetime
 * ("I deleted it and it came back / it won't delete").
 */
export function injectOptimisticAudioRemove(
  fileId: string,
  cellId: string,
  audioId: string,
  slot: AudioSlot,
  eventId?: string | Promise<string>,
): void {
  const byCell = cellMap(fileId)
  const list = byCell.get(cellId) ?? []
  const kept = list.filter(
    (s) =>
      !(s.kind === "attach" && s.att.audioId === audioId) &&
      !(s.kind === "remove" && s.audioId === audioId),
  )
  const shadow: OptimisticShadow = {
    key: nextShadowKey++,
    eventId: null,
    phase: "binding",
    graceStartedAt: Date.now(),
    kind: "remove",
    audioId,
    slot,
  }
  byCell.set(cellId, [...kept, shadow])
  attachEventBinding(fileId, shadow, eventId)
  broadcast(fileId, cellId, shadow)
}

/** The live overlay map for a file (cellId → shadows). Readers may prune it. */
export function getOptimisticShadows(fileId: string): Map<string, OptimisticShadow[]> {
  return shadowsByFile.get(fileId) ?? new Map()
}

/** True when this file has any overlay still waiting on its event. */
export function fileHasLiveShadowEvents(fileId: string): boolean {
  const byCell = shadowsByFile.get(fileId)
  if (!byCell) return false
  for (const list of byCell.values()) {
    for (const s of list) if (s.phase !== "settled") return true
  }
  return false
}

/**
 * Move every `queued` overlay whose event is no longer in the outbox into its
 * grace window. Write-once per shadow, so concurrent readers converge instead
 * of restarting each other's clocks. Returns true if anything transitioned.
 */
export function markShadowsSettled(
  fileId: string,
  absentEventIds: ReadonlySet<string>,
  now: number,
): boolean {
  const byCell = shadowsByFile.get(fileId)
  if (!byCell || absentEventIds.size === 0) return false
  let changed = false
  for (const list of byCell.values()) {
    for (const s of list) {
      if (s.phase !== "queued" || !s.eventId) continue
      if (!absentEventIds.has(s.eventId)) continue
      s.phase = "settled"
      s.graceStartedAt = now
      changed = true
    }
  }
  return changed
}

/** Drop every overlay for a file (used by tests). */
export function clearOptimisticShadows(fileId: string): void {
  shadowsByFile.delete(fileId)
}

// ── Rehydration from the durable outbox (fortify round) ─────────────────────
// This registry is memory-only, but the outbox it anchors to survives reloads
// — so a still-queued attach used to VANISH from the takes strip and timeline
// after a refresh until the flusher delivered it (minutes, in backoff),
// breaking SUB-48's "a recording stays on screen until it is actually saved".
// On a file's first read of the session, rebuild the shadows from the queued
// events themselves; the existing queued-phase lifecycle then takes over.

const rehydratedFiles = new Set<string>()

/** @internal — tests. */
export function __resetShadowRehydrationForTests(): void {
  rehydratedFiles.clear()
}

export async function rehydrateShadowsFromOutbox(projectId: string, fileId: string): Promise<void> {
  const key = `${projectId}/${fileId}`
  if (rehydratedFiles.has(key)) return
  rehydratedFiles.add(key)
  const records = await getOutboxFileAudioRecords(projectId, fileId)
  for (const record of records) {
    const event = record.event
    const cellId = event.cellId
    if (!cellId) continue
    const payload = (event.payload ?? {}) as Record<string, unknown>
    if (event.kind === "cell.audio.attach") {
      const audioId = payload.audioId
      const url = payload.url
      const slot = payload.slot
      if (typeof audioId !== "string" || typeof url !== "string") continue
      if (slot !== "recording" && slot !== "generatedVoice") continue
      injectOptimisticAudioAttachment(
        fileId,
        cellId,
        {
          audioId,
          url,
          slot,
          mimeType: typeof payload.mimeType === "string" ? payload.mimeType : null,
          voiceId: typeof payload.voiceId === "string" ? payload.voiceId : null,
          referenceAudioId: typeof payload.referenceAudioId === "string" ? payload.referenceAudioId : null,
          durationMs: typeof payload.durationMs === "number" ? payload.durationMs : null,
          label: typeof payload.label === "string" ? payload.label : null,
          trimStartMs: typeof payload.trimStartMs === "number" ? payload.trimStartMs : null,
          trimEndMs: typeof payload.trimEndMs === "number" ? payload.trimEndMs : null,
        },
        record.id,
      )
    } else if (event.kind === "cell.audio.remove") {
      const audioId = payload.audioId
      if (typeof audioId !== "string") continue
      // The slot isn't in the remove payload; "recording" vs "generatedVoice"
      // only matters for which selection the remove shadow clears, and the
      // read-side prune keys removes by audioId — recording covers both.
      injectOptimisticAudioRemove(fileId, cellId, audioId, "recording", record.id)
    }
  }
}
