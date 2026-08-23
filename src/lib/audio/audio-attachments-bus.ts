// Tiny per-file pub/sub so scattered audio producers (the recording modal in
// ProjectWorkspace, the TTS / clone buttons in EditorRow) can poke the
// per-file attachments read to refetch after they emit a cell.audio.* event —
// without threading a revalidate callback through every component.
//
// Mirrors the module-level coordinator pattern already used for active audio
// playback (audio-coordinator.ts) and TTS status (tts.ts).

import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { getOutboxFileAudioRecords, requeueOutboxEvents } from "@/lib/sync/outbox"

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

/**
 * Which slot of a cell a clip occupies. At most one clip per (cell, slot) is
 * selected, enforced by the projection's sibling-deselect.
 *
 * AQU-646: an OPEN string, not a two-value union. `cell_audio.slot` is
 * unconstrained TEXT and always has been, and extra target-audio tracks address
 * their takes by using the track's own id as the slot — so the set of legal
 * values is no longer knowable at compile time. The two well-known values are
 * `"recording"` (mic/upload takes, and the imported source clip, which are told
 * apart by the audioId seeding convention instead) and `"generatedVoice"`.
 *
 * Because this is now a plain string, the compiler no longer catches a
 * hard-coded `"recording"` written where a variable slot belongs. Read the
 * clip's own slot, or take it as an argument; never infer it.
 */
export type AudioSlot = string

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
 * `pendingSync` / `syncFailed` are VIEW flags the reader stamps onto the copy it
 * paints. They must never be stored on an overlay: callers routinely re-inject
 * an attachment they read back out of the merged view (the takes strip hands the
 * take it is displaying straight to `circle`), and a stored flag would keep
 * claiming "saving…" — or, post-AQU-924, "couldn't save" — long after the event
 * was delivered. The reader re-derives both from the outbox on every fetch.
 */
function withoutViewFlags(att: AudioAttachmentOut): AudioAttachmentOut {
  if (!att.pendingSync && !att.syncFailed) return att
  const { pendingSync: _pending, syncFailed: _failed, ...rest } = att
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
 * Optimistically resize a clip's trim window, so a dragged edge moves under the
 * pointer instead of waiting on flush + refetch.
 *
 * The partner of `cell.audio.trim`, and it mirrors that event's restraint: it
 * paints the two trim fields and NOTHING else — no selection claim above all.
 * Trimming used to ride a re-attach, whose projection sets `selected = 1`, so
 * trimming a non-selected generated-voice clip quietly promoted it over the
 * real take. `base` is the attachment as it should now read (the caller has it
 * in hand already — it had to look it up to know the clip's url and slot).
 */
export function injectOptimisticAudioTrim(
  fileId: string,
  cellId: string,
  base: AudioAttachmentOut,
  eventId?: string | Promise<string>,
): void {
  const attachment = withoutViewFlags(base)
  const byCell = cellMap(fileId)
  const list = byCell.get(cellId) ?? []

  // A pending delete outranks a trim — resizing a take the user just removed is
  // no reason to paint it back.
  if (list.some((s) => s.kind === "remove" && s.audioId === attachment.audioId)) return

  // A live intent for this clip keeps its own values and its claim; only the
  // window this call exists to deliver is stamped on. (Mirrors the merge in
  // the non-claiming attach path above.)
  const live = list.find((s) => s.kind === "attach" && s.att.audioId === attachment.audioId)
  if (live && live.kind === "attach") {
    live.att = {
      ...live.att,
      trimStartMs: attachment.trimStartMs,
      trimEndMs: attachment.trimEndMs,
    }
    attachEventBinding(fileId, live, eventId)
    broadcast(fileId, cellId, live)
    return
  }

  const shadow: OptimisticShadow = {
    key: nextShadowKey++,
    eventId: null,
    phase: "binding",
    graceStartedAt: Date.now(),
    kind: "attach",
    att: attachment,
    claimsSelection: false,
  }
  byCell.set(cellId, [...list, shadow])
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
//
// AQU-924: this rebuilds from every UNDELIVERED record — `failed` (quarantined /
// retry-exhausted) as well as `pending`. Rehydrating only the pending ones was
// half the silent-data-loss bug: an upload whose attach had been quarantined was
// skipped here, so after a reload the cell showed no take at all rather than a
// take that needs attention. The reader paints those as `syncFailed`.

const rehydratedFiles = new Set<string>()

/** @internal — tests. */
export function __resetShadowRehydrationForTests(): void {
  rehydratedFiles.clear()
}

/**
 * AQU-924: put a clip's stuck `cell.audio.*` events back on the queue.
 *
 * The retry surface a user needs for a failed take is ON THE TAKE, not buried in
 * the outbox inspector — they know "this recording didn't save", not which event
 * id carries it. Resolves the clip's undelivered records by `audioId` and revives
 * every `failed` one back to `pending`.
 *
 * Feedback is immediate without reaching the flusher: the bus poke here makes the
 * reader re-derive the clip's state, so the badge flips from "not saved" to
 * "saving" on the click. The send itself rides the flusher's normal cycle (it
 * cannot be nudged from here — `flushNow` lives behind OutboxProvider, which the
 * takes strip is not guaranteed to sit inside), which is honest: "saving" is
 * exactly what a requeued record is doing.
 *
 * Returns the number of records requeued, so the caller can tell a real retry
 * from a no-op (e.g. the record was discarded from the inspector meanwhile).
 */
export async function retryFailedAudioSync(
  projectId: string,
  fileId: string,
  cellId: string,
  audioId: string,
): Promise<number> {
  const records = await getOutboxFileAudioRecords(projectId, fileId)
  const stuck = records
    .filter((r) => r.status === "failed" && r.event.cellId === cellId)
    .filter((r) => (r.event.payload as { audioId?: unknown } | null)?.audioId === audioId)
    .map((r) => r.id)
  if (stuck.length === 0) return 0
  await requeueOutboxEvents(stuck)
  notifyAudioAttachmentsChanged(fileId)
  return stuck.length
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
      // AQU-924: only ATTACHES are rehydrated from a `failed` record. A stuck
      // remove has nothing at risk (the clip is still on the server), and
      // re-injecting it would hide that clip again on load only for the first
      // read to un-hide it — a flicker asserting a deletion that never
      // happened. Still-pending removes rehydrate as before.
      if (record.status !== "pending") continue
      // The slot isn't in the remove payload; "recording" vs "generatedVoice"
      // only matters for which selection the remove shadow clears, and the
      // read-side prune keys removes by audioId — recording covers both.
      injectOptimisticAudioRemove(fileId, cellId, audioId, "recording", record.id)
    }
  }
}
