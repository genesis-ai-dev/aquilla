// Per-file cell-audio attachments read. Vanilla useState + race-guarded
// effect (no React Query), matching useCellValidators. Subscribes to the
// audio-attachments bus so a local emit (recording / TTS / clone) refetches
// without prop-drilling a revalidate callback.
//
// Round 8 (SUB-39 root fix): optimistic injections are retained as SHADOWS
// and re-applied over every fetch until the SERVER read confirms them. The
// outbox flusher posts events on a ~5s timer, so a refetch poked right after
// an emit reads PRE-projection state — without shadows it wholesale-wiped a
// just-injected selection (the take-select chip visibly reverted). A shadow
// is confirmed (dropped) when the server entry carries the attachment, the
// slot's selection points at it, and its trims match; a 30s TTL bounds the
// stale window if an emit genuinely fails.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import {
  getOptimisticShadows,
  subscribeAudioAttachments,
  subscribeOptimisticAudioAttachment,
} from "@/lib/audio/audio-attachments-bus"
import { fetchFileAudioAttachments } from "@/lib/sync/cell-audio-read"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"

const SHADOW_TTL_MS = 30_000

function emptyEntry(): CellAudioEntry {
  return { attachments: {}, selectedAudioId: null, selectedGeneratedVoiceAudioId: null, audioTimings: {} }
}

function applyShadow(
  entry: CellAudioEntry | undefined,
  att: AudioAttachmentOut,
  claimsSelection: boolean,
): CellAudioEntry {
  const base = entry ?? emptyEntry()
  return {
    ...base,
    attachments: { ...base.attachments, [att.audioId]: att },
    ...(claimsSelection
      ? att.slot === "recording"
        ? { selectedAudioId: att.audioId }
        : { selectedGeneratedVoiceAudioId: att.audioId }
      : {}),
  }
}

function shadowConfirmed(
  entry: CellAudioEntry | undefined,
  att: AudioAttachmentOut,
  claimsSelection: boolean,
): boolean {
  if (!entry) return false
  const server = entry.attachments[att.audioId]
  if (!server) return false
  if (claimsSelection) {
    const selected = att.slot === "recording" ? entry.selectedAudioId : entry.selectedGeneratedVoiceAudioId
    if (selected !== att.audioId) return false
  }
  if ((server.trimStartMs ?? null) !== (att.trimStartMs ?? null)) return false
  if ((server.trimEndMs ?? null) !== (att.trimEndMs ?? null)) return false
  // Label compared only when the shadow explicitly carries one (round 8) —
  // trim re-injects omit it and the server keeps the existing name.
  if (att.label !== undefined && (server.label ?? null) !== att.label) return false
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

  const doFetch = useCallback(async () => {
    // No project/file, or auth not ready yet → nothing to read. Gating on `jwt`
    // here (rather than only inside getToken) makes it a real dependency, so the
    // fetch re-runs the moment the session lands on a cold reload.
    if (!projectId || !fileId || !jwt) {
      setByCellId(EMPTY)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    try {
      const token = await getToken(projectId, fileId)
      if (!token) {
        if (gen === generationRef.current) setByCellId(EMPTY)
        return
      }
      const res = await fetchFileAudioAttachments(projectId, fileId, token)
      if (gen !== generationRef.current) return // a newer fetch superseded us
      const map = new Map(Object.entries(res.cells))
      // Round 8: re-apply unconfirmed shadows over the server payload — a
      // fetch that raced the outbox flush must not revert a local action. The
      // registry is MODULE-LEVEL (round 8d) so a reader mounted after the
      // inject still sees it; pruning here is idempotent across readers.
      const now = Date.now()
      const registry = getOptimisticShadows(fileId)
      for (const [cellId, shadows] of registry) {
        const live = shadows.filter(
          (s) =>
            now - s.appliedAt < SHADOW_TTL_MS &&
            !shadowConfirmed(map.get(cellId), s.att, s.claimsSelection),
        )
        if (live.length === 0) {
          registry.delete(cellId)
          continue
        }
        registry.set(cellId, live)
        let entry = map.get(cellId)
        for (const s of live) entry = applyShadow(entry, s.att, s.claimsSelection)
        map.set(cellId, entry as CellAudioEntry)
      }
      setByCellId(map)
    } catch {
      // Read failures degrade to "no attachments" — playback shows nothing
      // rather than the editor crashing. The next poke retries.
      if (gen === generationRef.current) setByCellId(EMPTY)
    } finally {
      if (gen === generationRef.current) setIsLoading(false)
    }
  }, [projectId, fileId, getToken, jwt])

  useEffect(() => {
    void doFetch()
  }, [doFetch])

  // Refetch when a producer pokes this file's bus channel.
  useEffect(() => {
    if (!fileId) return
    return subscribeAudioAttachments(fileId, () => {
      void doFetch()
    })
  }, [fileId, doFetch])

  // Optimistic injections: a local producer (recording / TTS / take select /
  // trim) just changed an attachment. The bus records the shadow (module-level
  // registry, round 8d); here we merge it into live state at once so the UI
  // moves with zero round-trip.
  useEffect(() => {
    if (!fileId) return
    return subscribeOptimisticAudioAttachment(fileId, (cellId, att) => {
      setByCellId((prev) => {
        const next = new Map(prev)
        next.set(cellId, applyShadow(prev.get(cellId), att, true))
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
