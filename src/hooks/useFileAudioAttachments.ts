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
  learnShadowLanes,
  markShadowsSettled,
  rehydrateShadowsFromOutbox,
  shadowInLane,
  subscribeAudioAttachments,
  subscribeOptimisticAudioAttachment,
  type OptimisticShadow,
} from "@/lib/audio/audio-attachments-bus"
import { getOutboxRecords, subscribeToOutbox } from "@/lib/sync/outbox"
import { fetchFileAudioAttachments } from "@/lib/sync/cell-audio-read"
import {
  slotSelections,
  type AudioAttachmentOut,
  type CellAudioEntry,
  type FileAudioAttachmentsResponse,
} from "@/lib/sync/cell-audio-read-types"
import { createRequestCoalescer } from "@/lib/request-coalescer"
import { GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"

/** Coalescing window for outbox-driven refetches (the outbox notifies on every
 *  mutation app-wide; we only care that OUR file's events moved). */
const OUTBOX_REFETCH_DEBOUNCE_MS = 300

/**
 * AQU-2132: backoff for a read that could not answer — a sync-token mint that
 * returned null, or a GET that threw. Nothing else re-runs this read on its
 * own (its deps are stable once the session lands, and the bus and the outbox
 * only poke on a local change), so without a retry ONE failed read on page
 * load is permanent for the tab: every surface that counts audio off this map
 * reads text figures until the user happens to touch a take. Mirrors
 * `FETCH_RETRY_DELAYS_MS` in useActiveCellStore, shorter because this read is
 * one GET rather than a paginated stream.
 */
const READ_RETRY_DELAYS_MS = [400, 1200, 3000] as const

function emptyEntry(): CellAudioEntry {
  return {
    attachments: {},
    selectedBySlot: {},
    selectedAudioId: null,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  }
}

/**
 * Re-derive the two named pointers from the slot map. (AQU-646 stage 3)
 *
 * Every write below goes to `selectedBySlot` and then comes back through here,
 * exactly as the server does it. Writing the pointers directly is what the old
 * code did, and it is why any slot that was not literally `"recording"` claimed
 * `selectedGeneratedVoiceAudioId` — an `if/else` where a lookup belonged.
 */
function withProjections(entry: CellAudioEntry): CellAudioEntry {
  return {
    ...entry,
    selectedAudioId: entry.selectedBySlot?.[RECORDING_SLOT] ?? null,
    selectedGeneratedVoiceAudioId: entry.selectedBySlot?.[GENERATED_VOICE_SLOT] ?? null,
  }
}

/** How the overlay's own sync state should be painted onto the clip it asserts.
 *  "saving" → still queued (safe, in flight); "failed" → the event will not send
 *  without user action (AQU-924); "settled" → stop annotating, server truth is
 *  arriving. */
export type ShadowSyncView = "saving" | "failed" | "settled"

/** Paint one overlay onto an entry. `sync` marks the clip's save state. */
function applyShadow(
  entry: CellAudioEntry | undefined,
  shadow: OptimisticShadow,
  sync: ShadowSyncView,
): CellAudioEntry {
  const base = entry ?? emptyEntry()
  if (shadow.kind === "deselect") {
    // Mirrors the projection's `selected = 0` for the whole slot: the slot
    // simply empties, its takes stay listed (2026-09-28).
    const selectedBySlot = { ...slotSelections(base) }
    delete selectedBySlot[shadow.slot]
    return withProjections({ ...base, selectedBySlot })
  }
  if (shadow.kind === "remove") {
    const attachments = { ...base.attachments }
    delete attachments[shadow.audioId]
    // SLOT-AGNOSTIC: drop whichever slot's selection this audioId held.
    //
    // The remove EVENT carries no slot (its payload is `{ audioId }` and the
    // projection's UPDATE is not slot-scoped), so the shadow's slot was only
    // ever a guess — and `rehydrateShadowsFromOutbox` guesses `"recording"`
    // unconditionally when rebuilding one from the outbox. Keying on the
    // audioId, which is what the server keys on, removes the guess entirely.
    const selectedBySlot = { ...slotSelections(base) }
    for (const [slot, audioId] of Object.entries(selectedBySlot)) {
      if (audioId === shadow.audioId) delete selectedBySlot[slot]
    }
    // Mirrors the projection's `deleted = 1, selected = 0`: the slot simply
    // empties — nothing is auto-promoted in its place.
    return withProjections({ ...base, attachments, selectedBySlot })
  }
  const att = shadow.att
  // The flag rides the APPLIED copy only — the stored overlay stays pristine so
  // confirmation comparisons never trip over it.
  const applied: AudioAttachmentOut =
    sync === "saving"
      ? { ...att, pendingSync: true }
      : sync === "failed"
        ? { ...att, syncFailed: true }
        : att
  // AQU-924: a FAILED overlay keeps its attachment but surrenders its selection
  // claim. Those two halves of "this clip is here and it's the active one" fail
  // differently: the attachment is the only surviving record that the clip
  // exists (dropping it is the data loss), while the selection is a claim the
  // server will never agree with — asserting it would report the cell as voiced
  // to progress counts, export and playback on the strength of an event that
  // never landed. So the take stays listed and badged "not saved", and which
  // take is *active* reverts to server truth.
  const claimsSelection = shadow.claimsSelection && sync !== "failed"
  return withProjections({
    ...base,
    attachments: { ...base.attachments, [att.audioId]: applied },
    // A MAP WRITE, not an if/else. The old branch sent every slot that was not
    // literally "recording" to the generated-voice pointer, so a take on an
    // added track optimistically claimed a selection belonging to a different
    // track entirely.
    // NORMALISED EITHER WAY. `withProjections` re-derives the two named
    // pointers from this map, so handing it an absent map — which is what a
    // server response predating `selectedBySlot` gives — would derive nulls and
    // wipe a selection the server had actually reported. The overlay must be
    // able to add nothing without subtracting anything.
    selectedBySlot: claimsSelection
      ? { ...slotSelections(base), [att.slot]: att.audioId }
      : slotSelections(base),
  })
}

/** Has the server read caught up with what this overlay was asserting? */
function shadowConfirmed(entry: CellAudioEntry | undefined, shadow: OptimisticShadow): boolean {
  if (shadow.kind === "deselect") return !entry || !slotSelections(entry)[shadow.slot]
  if (shadow.kind === "remove") {
    // The read omits deleted rows, so absence IS the confirmation.
    return !entry?.attachments[shadow.audioId]
  }
  if (!entry) return false
  const att = shadow.att
  const server = entry.attachments[att.audioId]
  if (!server) return false
  if (shadow.claimsSelection) {
    if (slotSelections(entry)[att.slot] !== att.audioId) return false
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
  // THE POSITION, same rule as the label (2026-08-27). A drag's overlay is
  // nothing BUT its position — every other field it copies verbatim from the
  // server row it overlays — so without this line every comparison above was
  // trivially equal and the FIRST read after a drag "confirmed" it: the chip
  // snapped back to the old spot until the real save landed, and a rejected
  // placement vanished with no not-saved badge at all. Gated on `undefined`
  // exactly like the label, because trim and attach overlays legitimately
  // omit it and must not be held hostage to a position they never asserted.
  if (att.targetOffsetMs !== undefined && (server.targetOffsetMs ?? null) !== att.targetOffsetMs)
    return false
  return true
}

/** AQU-924: which save state to paint for a surviving overlay. A `failed` outbox
 *  record outranks the phase — a quarantined attach is neither "saving" nor
 *  settling into server truth, and mislabelling it "saving" would promise a
 *  delivery that is never coming. */
function syncViewFor(
  shadow: OptimisticShadow,
  outboxStatus: Map<string, "pending" | "failed">,
): ShadowSyncView {
  if (shadow.eventId && outboxStatus.get(shadow.eventId) === "failed") return "failed"
  return shadow.phase !== "settled" ? "saving" : "settled"
}

function keepShadow(
  shadow: OptimisticShadow,
  entry: CellAudioEntry | undefined,
  outboxStatus: Map<string, "pending" | "failed">,
  now: number,
  /** AQU-1978: false for another lane's overlay. This read holds none of that
   *  lane's server truth, so it cannot confirm the overlay — only the outbox
   *  and the clock retire it here. */
  inLane = true,
): boolean {
  if (shadow.eventId) {
    const status = outboxStatus.get(shadow.eventId)
    // Still queued → this device owns the change; the overlay IS the truth.
    // Deliberately checked BEFORE confirmation: for a delete whose attach is
    // *also* still queued, the clip's absence from the server means "nothing
    // has landed yet", not "the delete happened" — confirming on that would
    // drop the overlay and let the take flash back when the attach projects.
    if (status === "pending") return true
    // AQU-924: quarantined / retry-exhausted. This used to return false, on the
    // reasoning that the overlay "must stop asserting something that isn't
    // true" — but dropping it is what turned a failed upload into SILENT DATA
    // LOSS: the take vanished from the strip and timeline on the very next read
    // (and stayed gone after reload), while its bytes sat in R2 and its event
    // sat undelivered in the outbox. This device still owns the change, so the
    // overlay is kept — repainted as `syncFailed` rather than "saving", which is
    // the honest assertion: "this take exists here and has NOT reached the
    // server." It is the user's cue (and the inspector's Retry target) instead
    // of an empty cell. It stops being painted only when the record leaves the
    // outbox — delivered (confirmed below) or explicitly discarded.
    //
    // ATTACH only. A failed REMOVE is the mirror case and keeps the OLD rule:
    // nothing is at risk when a delete fails to apply (the clip is still on the
    // server), so continuing to hide it would assert a deletion that never
    // happened — and unlike an attach there is no attachment to badge, so the
    // lie would be silent. Letting the clip reappear IS the honest signal.
    if (status === "failed") return shadow.kind === "attach"
  }
  if (inLane && shadowConfirmed(entry, shadow)) return false
  if (shadow.phase === "settled") return now - shadow.graceStartedAt <= SETTLED_GRACE_MS
  if (shadow.phase === "binding") return now - shadow.graceStartedAt <= UNBOUND_TTL_MS
  return true
}

export interface UseFileAudioAttachmentsResult {
  byCellId: Map<string, CellAudioEntry>
  isLoading: boolean
  /** True once this file has an answer: its first read came back (or failed),
   *  or there is nothing to read — no file, or nobody signed in. Until then an
   *  empty map means "not read yet", not "no recordings"; a refetch never
   *  turns it false again. */
  hasLoaded: boolean
  revalidate: () => void
}

const EMPTY: Map<string, CellAudioEntry> = new Map()

// Shared across every mounted instance (ProjectWorkspace mounts this hook
// three times for the same file). Callers that arrive within the join window
// share the in-flight request; a later poke waits for it and runs ONE fresh
// follow-up so it is never answered with pre-write data. No TTL — every
// settled fetch is a real read.
const attachmentsCoalescer = createRequestCoalescer<FileAudioAttachmentsResponse | null>({ joinWindowMs: 250 })

/**
 * `lane` (AQU-1591) is the target-language lane whose takes to read: its own
 * dubs plus the shared programme audio, which belongs to every lane the way
 * source text does. Omitting it reads every lane's takes — the pre-lane wire —
 * and `''` is the default lane, a real lane and a different request.
 *
 * It is part of the read key AND of the coalescer key. Those are the two places
 * a lane can be dropped silently: a stale `settledKey` would report another
 * lane's answer as loaded, and a coalescer keyed on project/file alone would
 * hand the second lane to open a file the FIRST lane's takes, within the join
 * window, with no request of its own to show for it.
 */
export function useFileAudioAttachments(
  projectId: string | null,
  fileId: string | null,
  lane?: string,
): UseFileAudioAttachmentsResult {
  const { session, loading: sessionLoading } = useFrontierSession()
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
  // The project/file whose read last came back. Keyed rather than a boolean so
  // a file switch reads as "not loaded" at once, with no reset to forget.
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const laneKey = lane ?? "\u0000all"
  const readKey = projectId && fileId ? `${projectId}/${fileId}/${laneKey}` : null
  /**
   * Is the map on hand the answer for the file on screen?
   *
   * AQU-2132: `readKey === null` used to count as answered. That is right for
   * the case it was written for — no file open, nothing to read — and wrong
   * for the one that happens on every reload of `/project/:id/file/:fileId`:
   * the file id is on the URL from the first render while `project?.id` is
   * still null, because `useProject` is server-only with no IDB fallback. For
   * those renders the hook reported an EMPTY map as authoritative for a file
   * that IS open, so every surface counting audio off it was told "nothing is
   * recorded" rather than "not read yet" — and a fabricated `0 recorded`
   * overrides the server's figures, which are the only ones that know the
   * truth until this read lands (see `mergeFileProgress`).
   *
   * `settledKey === readKey` was the same mistake by another route: before the
   * project resolves BOTH are null, so the comparison answered true on its own.
   * Hence the explicit `readKey !== null`.
   *
   * So: nothing to read at all — no file open, or nobody signed in — is
   * answered. Anything else is answered only once THIS key's read has settled,
   * which `finally` does whether the read succeeded or failed (AQU-2111's 3G
   * finding: the per-line gutter must not wait forever).
   */
  const nothingToRead = !fileId || (!jwt && !sessionLoading)
  const hasLoaded = nothingToRead || (readKey !== null && settledKey === readKey)
  const generationRef = useRef(0)
  // One-shot sweep so a settled overlay still prunes when nothing else pokes.
  const sweepRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doFetchRef = useRef<(() => Promise<void>) | null>(null)
  // AQU-2132: the bounded retry for a read that could not answer, and the read
  // key the attempt counter belongs to so a new file gets its own budget.
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryAttemptsRef = useRef(0)
  const retryKeyRef = useRef<string | null>(null)
  /** The read key whose answer `byCellId` currently holds. A failure for THIS
   *  key must leave that answer alone — a transient error is not news that the
   *  takes went away — while a failure for a different file or lane must blank
   *  it, because the old map is then a lie about the file on screen. */
  const answeredKeyRef = useRef<string | null>(null)

  const cancelRetry = useCallback(() => {
    if (retryRef.current) clearTimeout(retryRef.current)
    retryRef.current = null
  }, [])

  const doFetch = useCallback(async () => {
    // No project/file, or auth not ready yet → nothing to read. Gating on `jwt`
    // here (rather than only inside getToken) makes it a real dependency, so the
    // fetch re-runs the moment the session lands on a cold reload.
    if (!projectId || !fileId || !jwt) {
      cancelRetry()
      setByCellId(EMPTY)
      return
    }
    // FORTIFY (SUB-48 across reloads): the shadow registry is memory-only but
    // the outbox is durable — rebuild shadows from still-queued cell.audio.*
    // events before the first read of the session, or a recording made just
    // before a refresh "vanishes" until the flusher delivers it. Idempotent
    // (once per file per session, keyed inside the bus).
    //
    // AQU-2160: claim the turn BEFORE awaiting. On a direct link the editor
    // reads the default lane and then the lane it opens in, back to back; a
    // turn claimed after the await went to whichever rehydrate finished last,
    // so the default lane's read could supersede the right one and settle
    // under the wrong key.
    const gen = ++generationRef.current
    await rehydrateShadowsFromOutbox(projectId, fileId).catch(() => { /* best-effort */ })
    if (gen !== generationRef.current) return // a newer fetch superseded us
    const key = `${projectId}/${fileId}/${laneKey}`
    // A fresh read supersedes any pending retry, and owns the attempt budget.
    cancelRetry()
    if (retryKeyRef.current !== key) {
      retryKeyRef.current = key
      retryAttemptsRef.current = 0
    }
    /**
     * This read could not answer. That is NOT "this file has no recordings",
     * and publishing an empty map said exactly that — to the editor footer,
     * the chapter picker and the open file's sidebar chapter grid, all three of
     * which count audio off this map. `hasLoaded` still flips in `finally`, so
     * the per-line gutter does not wait forever (AQU-2111's 3G finding); what
     * changes is that the empty map is no longer the last word.
     */
    const failRead = (): void => {
      if (answeredKeyRef.current !== key) setByCellId(EMPTY)
      const attempt = retryAttemptsRef.current
      if (attempt >= READ_RETRY_DELAYS_MS.length) return
      retryAttemptsRef.current = attempt + 1
      retryRef.current = setTimeout(() => {
        retryRef.current = null
        // Fenced like every other scheduled read here: a newer fetch has
        // already superseded this one and must not be re-run behind it.
        if (gen === generationRef.current) void doFetchRef.current?.()
      }, READ_RETRY_DELAYS_MS[attempt])
    }
    setIsLoading(true)
    try {
      const registry = getOptimisticShadows(fileId)
      const queuedIds: string[] = []
      for (const list of registry.values()) {
        for (const s of list) if (s.phase === "queued" && s.eventId) queuedIds.push(s.eventId)
      }
      // One batched IDB read per fetch, alongside the network read — the ids
      // are just this file's live overlays, so it stays a handful of gets.
      // The network read (token mint + GET) is shared across the hook's
      // instances via the module-level coalescer, so the three mounts
      // ProjectWorkspace keeps for one file cost one request each time.
      const [res, outboxRecords] = await Promise.all([
        attachmentsCoalescer.run(`${projectId}/${fileId}/${laneKey}`, async () => {
          const token = await getToken(projectId, fileId)
          return token ? fetchFileAudioAttachments(projectId, fileId, token, lane) : null
        }),
        getOutboxRecords(queuedIds),
      ])
      if (gen !== generationRef.current) return // a newer fetch superseded us
      if (!res) {
        failRead()
        return
      }
      const map = new Map(Object.entries(res.cells))
      const now = Date.now()
      const outboxStatus = new Map(outboxRecords.map((r) => [r.id, r.status]))
      const departed = new Set(queuedIds.filter((id) => !outboxStatus.has(id)))
      markShadowsSettled(fileId, departed, now)
      // AQU-1978: the same records say which lane each overlay was made in.
      learnShadowLanes(fileId, outboxRecords)
      for (const [cellId, shadows] of registry) {
        const live = shadows.filter((s) =>
          keepShadow(s, map.get(cellId), outboxStatus, now, shadowInLane(s, lane)),
        )
        if (live.length === 0) {
          registry.delete(cellId)
          continue
        }
        registry.set(cellId, live)
        // Chronological replay so delete-then-rerecord composes correctly.
        // AQU-1978: only this lane's overlays (and shared ones) are painted on
        // this lane's read; another lane's stay registered for that lane.
        let entry = map.get(cellId)
        for (const s of live) {
          if (shadowInLane(s, lane)) entry = applyShadow(entry, s, syncViewFor(s, outboxStatus))
        }
        if (entry) map.set(cellId, entry)
      }
      setByCellId(map)
      answeredKeyRef.current = key
      retryAttemptsRef.current = 0
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
      // A thrown read degrades gracefully rather than crashing the editor, and
      // (AQU-2132) retries on its own instead of waiting for the next poke.
      if (gen === generationRef.current) failRead()
    } finally {
      if (gen === generationRef.current) {
        setIsLoading(false)
        setSettledKey(`${projectId}/${fileId}/${laneKey}`)
      }
    }
  }, [projectId, fileId, lane, laneKey, getToken, jwt, cancelRetry])

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
      cancelRetry()
    },
    [cancelRetry],
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
      // AQU-1978: another lane's overlay is not painted on this lane's read.
      if (!shadowInLane(shadow, lane)) return
      setByCellId((prev) => {
        const next = new Map(prev)
        // A just-injected overlay is always in flight; the next fetch re-derives
        // its real state (including AQU-924's failed case) from the outbox.
        next.set(cellId, applyShadow(prev.get(cellId), shadow, "saving"))
        return next
      })
    })
  }, [fileId, lane])

  return { byCellId, isLoading, hasLoaded, revalidate: doFetch }
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
        // AQU-646: carry the slot so consumers read it rather than inferring it
        // from the selection pointers. The inference cannot see a third slot.
        ...(a.slot ? { slot: a.slot } : {}),
        ...(a.voiceId ? { voiceId: a.voiceId } : {}),
        ...(a.referenceAudioId ? { referenceAudioId: a.referenceAudioId } : {}),
        ...(a.durationMs != null ? { durationMs: a.durationMs } : {}),
        // AQU-646: forward the trim window so consumers (transcription) can
        // address this cell's slice of a shared imported clip.
        ...(a.trimStartMs != null ? { trimStartMs: a.trimStartMs } : {}),
        ...(a.trimEndMs != null ? { trimEndMs: a.trimEndMs } : {}),
        // `!= null`, so a hand-placed 0 survives the merge. `0` is where a take
        // that starts exactly on its line sits, and it must stay
        // distinguishable from "never placed".
        ...(a.targetOffsetMs != null ? { targetOffsetMs: a.targetOffsetMs } : {}),
        // SUB-48: "saved here, not yet at the server" — drives the saving hint.
        ...(a.pendingSync ? { pendingSync: true as const } : {}),
        // AQU-924: "saved here, and it will NOT reach the server on its own."
        ...(a.syncFailed ? { syncFailed: true as const } : {}),
        // AQU-490. THESE MUST BE LISTED. This merge rebuilds every attachment
        // field by field rather than spreading it, so a field nobody adds here
        // is dropped on the way to the editor — silently, with no type error,
        // because every one of them is optional on both sides. The symptom
        // would be a gutter reading "nobody has validated this" on a take the
        // server says two people signed off, and nothing at all in a log.
        ...(a.label != null ? { label: a.label } : {}),
        ...(a.validatorCount != null ? { validatorCount: a.validatorCount } : {}),
        ...(a.validators ? { validators: a.validators } : {}),
        ...(a.role ? { role: a.role } : {}),
        ...(a.recordedBy != null ? { recordedBy: a.recordedBy } : {}),
        // AQU-1767: which take a piece was cut from — the chips, the playback
        // overlay and the validation gutter all expand a selection by it.
        ...(a.pieceOf ? { pieceOf: a.pieceOf } : {}),
        // Two-step transcription: what ASR heard, and the AI-cleanup mark.
        ...(a.asrText != null ? { asrText: a.asrText } : {}),
        ...(a.asrModel != null ? { asrModel: a.asrModel } : {}),
        ...(a.transcriptAi ? { transcriptAi: a.transcriptAi } : {}),
      }
    }
    return {
      ...c,
      attachments,
      selectedBySlot: entry.selectedBySlot,
      selectedAudioId: entry.selectedAudioId ?? undefined,
      selectedGeneratedVoiceAudioId: entry.selectedGeneratedVoiceAudioId ?? undefined,
      audioTimings: entry.audioTimings as Record<string, WordTiming[]>,
    }
  })
}
