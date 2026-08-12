// Per-file cell-audio attachments read. Vanilla useState + race-guarded
// effect (no React Query), matching useCellValidators. Subscribes to the
// audio-attachments bus so a local emit (recording / TTS / clone) refetches
// without prop-drilling a revalidate callback.
//
// SUB-48: local intent (the optimistic overlay) is re-applied over every fetch
// and its lifetime is anchored to the OUTBOX rather than a wall clock. The
// flusher backs off to 60s and background tabs throttle timers, so an event
// can sit queued for minutes; the old 30s TTL made freshly recorded takes
// vanish from the screen while they were safely on disk, then reappear when
// the queue finally drained. Now: while the event is queued the overlay is
// authoritative; once it leaves the queue a short grace window covers the
// projection/read lag; then server truth wins. Deletes get their own overlay
// so a removed clip can neither resurrect nor be "undeletable".

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import {
  SETTLED_GRACE_MS,
  UNBOUND_TTL_MS,
  fileHasLiveShadowEvents,
  getOptimisticShadows,
  markShadowsSettled,
  rehydrateShadowsFromOutbox,
  subscribeAudioAttachments,
  subscribeOptimisticAudioAttachment,
  type OptimisticShadow,
} from "@/lib/audio/audio-attachments-bus"
import { getOutboxRecords, subscribeToOutbox } from "@/lib/sync/outbox"
import { fetchFileAudioAttachments } from "@/lib/sync/cell-audio-read"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"

/** Coalescing window for outbox-driven refetches (the outbox notifies on every
 *  mutation app-wide; we only care that OUR file's events moved). */
const OUTBOX_REFETCH_DEBOUNCE_MS = 300

function emptyEntry(): CellAudioEntry {
  return { attachments: {}, selectedAudioId: null, selectedGeneratedVoiceAudioId: null, audioTimings: {} }
}

/** Paint one overlay onto an entry. `pending` marks the clip as not-yet-saved. */
function applyShadow(
  entry: CellAudioEntry | undefined,
  shadow: OptimisticShadow,
  pending: boolean,
): CellAudioEntry {
  const base = entry ?? emptyEntry()
  if (shadow.kind === "remove") {
    const attachments = { ...base.attachments }
    delete attachments[shadow.audioId]
    return {
      ...base,
      attachments,
      // Mirrors the projection's `deleted = 1, selected = 0`: the slot simply
      // empties — nothing is auto-promoted in its place.
      ...(shadow.slot === "recording" && base.selectedAudioId === shadow.audioId
        ? { selectedAudioId: null }
        : {}),
      ...(shadow.slot === "generatedVoice" && base.selectedGeneratedVoiceAudioId === shadow.audioId
        ? { selectedGeneratedVoiceAudioId: null }
        : {}),
    }
  }
  const att = shadow.att
  // The flag rides the APPLIED copy only — the stored overlay stays pristine so
  // confirmation comparisons never trip over it.
  const applied: AudioAttachmentOut = pending ? { ...att, pendingSync: true } : att
  return {
    ...base,
    attachments: { ...base.attachments, [att.audioId]: applied },
    ...(shadow.claimsSelection
      ? att.slot === "recording"
        ? { selectedAudioId: att.audioId }
        : { selectedGeneratedVoiceAudioId: att.audioId }
      : {}),
  }
}

/** Has the server read caught up with what this overlay was asserting? */
function shadowConfirmed(entry: CellAudioEntry | undefined, shadow: OptimisticShadow): boolean {
  if (shadow.kind === "remove") {
    // The read omits deleted rows, so absence IS the confirmation.
    return !entry?.attachments[shadow.audioId]
  }
  if (!entry) return false
  const att = shadow.att
  const server = entry.attachments[att.audioId]
  if (!server) return false
  if (shadow.claimsSelection) {
    const selected = att.slot === "recording" ? entry.selectedAudioId : entry.selectedGeneratedVoiceAudioId
    if (selected !== att.audioId) return false
  }
  if ((server.trimStartMs ?? null) !== (att.trimStartMs ?? null)) return false
  if ((server.trimEndMs ?? null) !== (att.trimEndMs ?? null)) return false
  // A duration-bearing overlay (a fresh take, or the heal re-attach) is NOT
  // confirmed by a server row that still lacks it — otherwise the chip snaps
  // back to fallback width the moment the read lands.
  if (att.durationMs != null && (server.durationMs ?? null) !== att.durationMs) return false
  // Label compared only when the overlay explicitly carries one — trim
  // re-injects omit it and the server keeps the existing name.
  if (att.label !== undefined && (server.label ?? null) !== att.label) return false
  return true
}

function keepShadow(
  shadow: OptimisticShadow,
  entry: CellAudioEntry | undefined,
  outboxStatus: Map<string, "pending" | "failed">,
  now: number,
): boolean {
  if (shadow.eventId) {
    const status = outboxStatus.get(shadow.eventId)
    // Still queued → this device owns the change; the overlay IS the truth.
    // Deliberately checked BEFORE confirmation: for a delete whose attach is
    // *also* still queued, the clip's absence from the server means "nothing
    // has landed yet", not "the delete happened" — confirming on that would
    // drop the overlay and let the take flash back when the attach projects.
    if (status === "pending") return true
    // Quarantined after repeated failures: it will not send without user
    // action, so the overlay must stop asserting something that isn't true.
    if (status === "failed") return false
  }
  if (shadowConfirmed(entry, shadow)) return false
  if (shadow.phase === "settled") return now - shadow.graceStartedAt <= SETTLED_GRACE_MS
  if (shadow.phase === "binding") return now - shadow.graceStartedAt <= UNBOUND_TTL_MS
  return true
}

export interface UseFileAudioAttachmentsResult {
  byCellId: Map<string, CellAudioEntry>
  isLoading: boolean
  revalidate: () => void
}

const EMPTY: Map<string, CellAudioEntry> = new Map()

export function useFileAudioAttachments(
  projectId: string | null,
  fileId: string | null,
): UseFileAudioAttachmentsResult {
  const { session } = useFrontierSession()
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  const getToken = useMemo(
    () => makeAudioSyncTokenFetcher(() => sessionRef.current),
    [],
  )
  // On a cold reload the session JWT isn't ready on first render, so the
  // initial fetch bails with no token and — because getToken is stable — never
  // retries on its own. Track the JWT so the fetch re-runs the moment auth
  // lands. (Symptom without this: zero `audio-attachments` requests on reload;
  // audio only appears after a generate pokes the bus.)
  const jwt = session?.jwt ?? null

  const [byCellId, setByCellId] = useState<Map<string, CellAudioEntry>>(EMPTY)
  const [isLoading, setIsLoading] = useState(false)
  const generationRef = useRef(0)
  // One-shot sweep so a settled overlay still prunes when nothing else pokes.
  const sweepRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doFetchRef = useRef<(() => Promise<void>) | null>(null)

  const doFetch = useCallback(async () => {
    // No project/file, or auth not ready yet → nothing to read. Gating on `jwt`
    // here (rather than only inside getToken) makes it a real dependency, so the
    // fetch re-runs the moment the session lands on a cold reload.
    if (!projectId || !fileId || !jwt) {
      setByCellId(EMPTY)
      return
    }
    // FORTIFY (SUB-48 across reloads): the shadow registry is memory-only but
    // the outbox is durable — rebuild shadows from still-queued cell.audio.*
    // events before the first read of the session, or a recording made just
    // before a refresh "vanishes" until the flusher delivers it. Idempotent
    // (once per file per session, keyed inside the bus).
    await rehydrateShadowsFromOutbox(projectId, fileId).catch(() => { /* best-effort */ })
    const gen = ++generationRef.current
    setIsLoading(true)
    try {
      const token = await getToken(projectId, fileId)
      if (!token) {
        if (gen === generationRef.current) setByCellId(EMPTY)
        return
      }
      const registry = getOptimisticShadows(fileId)
      const queuedIds: string[] = []
      for (const list of registry.values()) {
        for (const s of list) if (s.phase === "queued" && s.eventId) queuedIds.push(s.eventId)
      }
      // One batched IDB read per fetch, alongside the network read — the ids
      // are just this file's live overlays, so it stays a handful of gets.
      const [res, outboxRecords] = await Promise.all([
        fetchFileAudioAttachments(projectId, fileId, token),
        getOutboxRecords(queuedIds),
      ])
      if (gen !== generationRef.current) return // a newer fetch superseded us
      const map = new Map(Object.entries(res.cells))
      const now = Date.now()
      const outboxStatus = new Map(outboxRecords.map((r) => [r.id, r.status]))
      const departed = new Set(queuedIds.filter((id) => !outboxStatus.has(id)))
      markShadowsSettled(fileId, departed, now)
      for (const [cellId, shadows] of registry) {
        const live = shadows.filter((s) => keepShadow(s, map.get(cellId), outboxStatus, now))
        if (live.length === 0) {
          registry.delete(cellId)
          continue
        }
        registry.set(cellId, live)
        // Chronological replay so delete-then-rerecord composes correctly.
        let entry = map.get(cellId)
        for (const s of live) entry = applyShadow(entry, s, s.phase !== "settled")
        map.set(cellId, entry as CellAudioEntry)
      }
      setByCellId(map)
      // Re-arm a sweep for the EARLIEST grace deadline still outstanding.
      // Arming only on a fresh transition was wrong: two overlays settling a
      // few seconds apart share one timer, and the fetch it triggers sees no
      // new transition — so the younger overlay had nothing left to prune it
      // (the outbox subscription is closed by then, since every overlay is
      // settled). Recomputing from the survivors is self-healing: each pass
      // either drops a shadow or schedules the next deadline.
      let earliestDeadline = Infinity
      for (const list of registry.values()) {
        for (const s of list) {
          if (s.phase === "settled") earliestDeadline = Math.min(earliestDeadline, s.graceStartedAt + SETTLED_GRACE_MS)
        }
      }
      if (sweepRef.current) clearTimeout(sweepRef.current)
      sweepRef.current = null
      if (earliestDeadline !== Infinity) {
        sweepRef.current = setTimeout(
          () => {
            sweepRef.current = null
            void doFetchRef.current?.()
          },
          Math.max(250, earliestDeadline - now + 500),
        )
      }
    } catch {
      // Read failures degrade to "no attachments" — playback shows nothing
      // rather than the editor crashing. The next poke retries.
      if (gen === generationRef.current) setByCellId(EMPTY)
    } finally {
      if (gen === generationRef.current) setIsLoading(false)
    }
  }, [projectId, fileId, getToken, jwt])

  useEffect(() => {
    doFetchRef.current = doFetch
  }, [doFetch])

  useEffect(() => {
    void doFetch()
  }, [doFetch])

  useEffect(
    () => () => {
      if (sweepRef.current) clearTimeout(sweepRef.current)
      sweepRef.current = null
    },
    [],
  )

  // Refetch when a producer pokes this file's bus channel.
  useEffect(() => {
    if (!fileId) return
    return subscribeAudioAttachments(fileId, () => {
      void doFetch()
    })
  }, [fileId, doFetch])

  // The outbox moved (an event was delivered, retried, or quarantined). Only
  // our own live overlays care, so gate on that and coalesce — this fires on
  // every outbox mutation app-wide.
  useEffect(() => {
    if (!fileId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = subscribeToOutbox(() => {
      if (timer !== null) return
      if (!fileHasLiveShadowEvents(fileId)) return
      timer = setTimeout(() => {
        timer = null
        void doFetch()
      }, OUTBOX_REFETCH_DEBOUNCE_MS)
    })
    return () => {
      unsub()
      if (timer !== null) clearTimeout(timer)
    }
  }, [fileId, doFetch])

  // Optimistic overlays: a local producer (recording / TTS / take select /
  // trim / delete) just changed something. The bus records the overlay; here we
  // paint it immediately so the UI moves with zero round-trip.
  useEffect(() => {
    if (!fileId) return
    return subscribeOptimisticAudioAttachment(fileId, (cellId, shadow) => {
      setByCellId((prev) => {
        const next = new Map(prev)
        next.set(cellId, applyShadow(prev.get(cellId), shadow, true))
        return next
      })
    })
  }, [fileId])

  return { byCellId, isLoading, revalidate: doFetch }
}

// Fold the per-file audio read (`byCellId`) into a cell list, populating the
// audio fields play-queue / the editor read off `CellData` (attachments,
// selected slots, timings). Both the editor table and the playback bar hydrate
// from this single source so their notion of "what's voiced" can't drift.
export function mergeCellsWithAudio(
  cells: CellData[],
  byCellId: Map<string, CellAudioEntry>,
): CellData[] {
  if (byCellId.size === 0) return cells
  return cells.map((c) => {
    const entry = byCellId.get(c.id)
    if (!entry) return c
    const attachments: Record<string, CodexCellAttachment> = {}
    for (const [audioId, a] of Object.entries(entry.attachments)) {
      attachments[audioId] = {
        url: a.url,
        type: "audio",
        ...(a.voiceId ? { voiceId: a.voiceId } : {}),
        ...(a.referenceAudioId ? { referenceAudioId: a.referenceAudioId } : {}),
        ...(a.durationMs != null ? { durationMs: a.durationMs } : {}),
        // AQU-646: forward the trim window so consumers (transcription) can
        // address this cell's slice of a shared imported clip.
        ...(a.trimStartMs != null ? { trimStartMs: a.trimStartMs } : {}),
        ...(a.trimEndMs != null ? { trimEndMs: a.trimEndMs } : {}),
        // SUB-48: "saved here, not yet at the server" — drives the saving hint.
        ...(a.pendingSync ? { pendingSync: true as const } : {}),
      }
    }
    return {
      ...c,
      attachments,
      selectedAudioId: entry.selectedAudioId ?? undefined,
      selectedGeneratedVoiceAudioId: entry.selectedGeneratedVoiceAudioId ?? undefined,
      audioTimings: entry.audioTimings as Record<string, WordTiming[]>,
    }
  })
}
