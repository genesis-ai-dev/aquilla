// The Station's state for one open recording (AQU-2327): its samples, the
// edit list over them, the kept part, the selection, the view and the
// player. Behaviour follows the working build (board 40b) unless a comment
// says otherwise.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { claimActiveAudio, clearActiveAudioIf, type ActiveAudioController } from "@/lib/audio/audio-coordinator"
import {
  clampTrim,
  lengthOf,
  mapWindow,
  MIN_KEPT_SEC,
  placeSegments,
  round3,
  shiftTime,
  round2,
  segmentsOf,
  type ClipMix,
  type EditOp,
  type PlacedSegment,
} from "@/lib/station/edit-list"
import { audioCacheGet } from "@/lib/audio/bytes-cache"
import { decodeToMono48k } from "@/lib/audio/decode-mono"
import { draftKey, EMPTY_DRAFT, pushDraft, readDraft, undoDraft, writeDraft, type DraftSource, type StationDraft } from "@/lib/station/drafts"
import { loadStationPcm, putStationPcm, type StationPcm } from "@/lib/station/load"
import { previewCanMix, StationPreview } from "@/lib/station/preview"
import { mixWhole, renderSegments, type PcmSource } from "@/lib/station/render"
import type { StationTarget } from "@/lib/station/target"
import type { StationHost, StationTake } from "./station-host"

export const BASE_SRC = "base"
/** The recording being made with Record now, while it runs (slice 14). */
export const LIVE_SRC = "live"
/** Slice 12: past this, a recording plays from its own bytes. */
export const STATION_LONG_SEC = 120
/** Slice 12: past this, deleting and inserting wait for block-by-block
 *  rendering; trims, approval, volume and fades work at any length. */
export const STATION_EDIT_MAX_SEC = 600
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
export const MAX_ZOOM = 16

export interface Selection {
  a: number
  b: number
}

/**
 * A selection wider than a point. Deliberately not a type guard: "not a
 * range" still leaves a point selection, so a guard's false branch (which
 * would narrow `sel` to null) is wrong.
 */
export const isRange = (s: Selection | null): boolean => s != null && s.b - s.a > 0.005

/** The kept part after one edit, keeping its sound (40b). null = the stored
 *  trim carried through, when End was still at the recording's edge. */
export function shiftTrim(op: EditOp, trimA: number, trimB: number, endAtEdge: boolean): { a: number; b: number } | null {
  if (endAtEdge && trimA === 0) return null
  return { a: round2(shiftTime(trimA, op)), b: endAtEdge ? -1 : round2(shiftTime(trimB, op)) }
}

export function useStationEditor(host: StationHost, take: StationTake, target: StationTarget, visible: boolean) {
  const { project, getSyncToken } = host
  const url = take.att.url
  const [pcm, setPcm] = useState<StationPcm | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    loadStationPcm({ url, projectId: project.id, fileId: take.fileId, getSyncToken })
      .then((p) => {
        if (live) setPcm(p)
      })
      .catch(() => {
        if (live) setError(true)
      })
    return () => {
      live = false
    }
  }, [url, project.id, take.fileId, getSyncToken])

  // ——— Unsaved sound edits (deletes and inserts), kept per recording in
  // this browser until saved or undone (Q5, lib/station/drafts.ts).
  const key = draftKey(target)
  const [draft, setDraftState] = useState<StationDraft>(() => readDraft(key) ?? EMPTY_DRAFT)
  const setDraft = useCallback(
    (d: StationDraft) => {
      setDraftState(d)
      writeDraft(key, d)
    },
    [key],
  )
  const ops = draft.ops

  // Inserted audio's samples, by the key its operation names.
  const [sources, setSources] = useState<Record<string, PcmSource>>({})
  // Slice 14 (Sam, Nov 2): Record now records here. While it runs, the
  // recording so far is drawn at the cursor as its own part and what comes
  // after slides along; it is not an edit until it stops.
  const [live, setLive] = useState<{ at: number; src: PcmSource } | null>(null)
  const lookup = useCallback(
    (src: string): PcmSource | null => (src === BASE_SRC ? pcm : src === LIVE_SRC ? (live?.src ?? null) : (sources[src] ?? null)),
    [pcm, sources, live],
  )
  // A draft brought back after a reload: load its inserted audio again.
  const restoring = useRef(new Set<string>())
  useEffect(() => {
    for (const [id, meta] of Object.entries(draft.sources)) {
      if (sources[id] || restoring.current.has(id)) continue
      restoring.current.add(id)
      const done = (p: PcmSource | null) => {
        if (p) setSources((m) => ({ ...m, [id]: p }))
      }
      if (meta.kind === "take") {
        loadStationPcm({ url: meta.url, projectId: project.id, fileId: meta.fileId, getSyncToken }).then(done, () => {})
      } else {
        void audioCacheGet(meta.cacheId, meta.ext)
          .then((bytes) => (bytes ? decodeToMono48k(bytes) : null))
          .then((data) => done(data ? putStationPcm(id, data) : null), () => {})
      }
    }
  }, [draft.sources, sources, project.id, getSyncToken])

  const placed: PlacedSegment[] = useMemo(() => {
    const shown: EditOp[] = live ? [...ops, { kind: "ins", at: live.at, src: LIVE_SRC, len: live.src.data.length / live.src.rate, label: "" }] : [...ops]
    return placeSegments(segmentsOf(BASE_SRC, pcm?.duration ?? 0, shown))
  }, [pcm, ops, live])
  const length = useMemo(() => Math.max(MIN_KEPT_SEC, lengthOf(placed)), [placed])

  // ——— The kept part: the take's stored trim (carried through any unsaved
  // edits so it keeps its sound), or the draft's own, or the edge being dragged.
  const storedA = (take.att.trimStartMs ?? 0) / 1000
  const storedB = take.att.trimEndMs != null ? take.att.trimEndMs / 1000 : -1
  const baseTrim = useMemo(() => {
    if (ops.length === 0) return { a: storedA, b: storedB }
    if (draft.trim) return draft.trim
    const w = mapWindow({ start: storedA, end: storedB < 0 ? (pcm?.duration ?? 0) : storedB }, ops)
    return { a: w.start, b: storedB < 0 ? -1 : w.end }
  }, [ops, draft.trim, storedA, storedB, pcm])
  const [liveTrim, setLiveTrim] = useState<{ a: number; b: number } | null>(null)
  const { trimA, trimB } = clampTrim(liveTrim?.a ?? baseTrim.a, liveTrim?.b ?? baseTrim.b, length)
  // ——— Volume and fades (items 21–22): the clip's own data (cell.audio.gain),
  // or the corner / line being dragged. They never change the recording.
  const stored = useMemo(
    () => ({ gainDb: take.att.gainDb ?? 0, fadeIn: (take.att.fadeInMs ?? 0) / 1000, fadeOut: (take.att.fadeOutMs ?? 0) / 1000 }),
    [take.att.gainDb, take.att.fadeInMs, take.att.fadeOutMs],
  )
  const [liveLevel, setLiveLevel] = useState<{ gainDb: number; fadeIn: number; fadeOut: number } | null>(null)
  const level = liveLevel ?? stored
  const clip: ClipMix = useMemo(
    () => ({ trimA, trimB, fadeIn: level.fadeIn, fadeOut: level.fadeOut, gainDb: level.gainDb }),
    [trimA, trimB, level.fadeIn, level.fadeOut, level.gainDb],
  )
  /** Save the level as one Undo step (`take.gain`). */
  const commitLevel = useCallback(
    async (next: { gainDb: number; fadeIn: number; fadeOut: number }) => {
      setLiveLevel(null)
      const half = Math.max(0, (trimB - trimA) / 2)
      const gainDb = Math.max(-12, Math.min(6, Math.round(next.gainDb * 2) / 2))
      const fadeIn = Math.max(0, Math.min(half, round2(next.fadeIn)))
      const fadeOut = Math.max(0, Math.min(half, round2(next.fadeOut)))
      if (gainDb === stored.gainDb && fadeIn === stored.fadeIn && fadeOut === stored.fadeOut) return
      await host.setLevel(target.cellId, target.audioId, {
        gainDb: gainDb === 0 ? null : gainDb,
        fadeInMs: fadeIn > 0 ? Math.round(fadeIn * 1000) : null,
        fadeOutMs: fadeOut > 0 ? Math.round(fadeOut * 1000) : null,
      })
    },
    [host, stored, target.audioId, target.cellId, trimA, trimB],
  )

  /** Save a trim as one Undo step; null on an end = back to the edge. While
   *  sound edits are unsaved, the trim waits with them for the new version. */
  const commitTrim = useCallback(
    async (a: number, b: number) => {
      const c = clampTrim(a, b, length)
      setLiveTrim(null)
      if (ops.length > 0) {
        setDraft(pushDraft(draft, { trim: { a: c.trimA, b: c.trimB } }))
        return
      }
      const startMs = c.trimA > 0.0005 ? Math.round(c.trimA * 1000) : undefined
      const endMs = c.trimB < length - 0.0005 ? Math.round(c.trimB * 1000) : undefined
      const curStart = take.att.trimStartMs ?? undefined
      const curEnd = take.att.trimEndMs ?? undefined
      if ((curStart ?? 0) === (startMs ?? 0) && curEnd === endMs) return
      await host.trim(target.cellId, target.audioId, { trimStartMs: startMs, trimEndMs: endMs })
    },
    [draft, host, length, ops.length, setDraft, take.att.trimEndMs, take.att.trimStartMs, target.audioId, target.cellId],
  )

  // ——— Selection
  const [sel, setSel] = useState<Selection | null>(null)
  const select = useCallback((a: number, b: number) => {
    setSel({ a: Math.min(a, b), b: Math.max(a, b) })
  }, [])
  const clearSel = useCallback(() => setSel(null), [])

  // ——— View (zoom 1–16×, 40b)
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const w = length / zoom
  const va = Math.max(0, Math.min(length - w, viewStart))
  const view = { va, vb: va + w, w, zoom }

  // ——— The player (lib/station/preview.ts says why it is an element)
  const [playT, setPlayT] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeedState] = useState(1)
  const [loop, setLoop] = useState(false)
  const controllerRef = useRef<ActiveAudioController | null>(null)
  const preview = useMemo(
    () =>
      new StationPreview({
        onTime: (t) => setPlayT(t),
        onEnded: () => setPlaying(false),
      }),
    [],
  )
  useEffect(() => () => {
    preview.dispose()
    if (controllerRef.current) clearActiveAudioIf(controllerRef.current)
  }, [preview])

  // The samples it plays: the recording as it stands. A plain recording plays
  // its own decode; an edited one is rendered (debounced, so a drag of a
  // volume line doesn't render on every move).
  useEffect(() => {
    if (!pcm) return
    const flat = clip.fadeIn <= 0 && clip.fadeOut <= 0 && !clip.gainDb
    // A plain recording plays from its own bytes (no re-encode: slice 12),
    // its volume and fades applied by the mixer.
    // Only a long one, and never a recorder's webm: a MediaRecorder webm has
    // no duration, and seeking one ends it (clip-preview.ts), so short takes
    // and webm play from a WAV render instead.
    const playOriginal = pcm.original && pcm.duration > STATION_LONG_SEC && !pcm.original.type.includes("webm")
    if (ops.length === 0 && playOriginal && pcm.original && (flat || previewCanMix())) {
      preview.setLevel(flat ? null : { gainDb: clip.gainDb, fadeInSec: clip.fadeIn, fadeOutSec: clip.fadeOut, startSec: clip.trimA, endSec: clip.trimB })
      preview.setBlob(pcm.original, { mix: previewCanMix() })
      return
    }
    if (ops.length === 0 && flat) {
      preview.setLevel(null)
      preview.setSamples(pcm.data, pcm.rate, { mix: previewCanMix() })
      return
    }
    const id = setTimeout(() => {
      const whole = ops.length === 0 ? pcm.data : renderSegments(placed, lookup, pcm.rate)
      // The mixer applies the volume and fades (and guards the peak); with no
      // AudioContext they are baked into the samples instead.
      if (previewCanMix()) {
        preview.setLevel(flat ? null : { gainDb: clip.gainDb, fadeInSec: clip.fadeIn, fadeOutSec: clip.fadeOut, startSec: clip.trimA, endSec: clip.trimB })
        preview.setSamples(whole, pcm.rate, { mix: true })
      } else preview.setSamples(mixWhole(whole, pcm.rate, clip), pcm.rate)
    }, 150)
    return () => clearTimeout(id)
  }, [pcm, ops, placed, lookup, preview, clip])

  const pause = useCallback(() => {
    preview.pause()
    setPlaying(false)
  }, [preview])

  const playRange = useCallback(
    (from: number, to: number) => {
      if (!pcm) return
      host.pauseOtherPlayback()
      const controller: ActiveAudioController = controllerRef.current ?? {
        isPlaying: () => preview.playing,
        play: async () => {},
        pause: () => {
          preview.pause()
          setPlaying(false)
        },
      }
      controllerRef.current = controller
      claimActiveAudio(controller)
      preview.play(from, to, speed, loop)
      setPlayT(from)
      setPlaying(true)
    },
    [host, loop, pcm, preview, speed],
  )

  const togglePlay = useCallback(() => {
    if (playing) {
      pause()
      return
    }
    if (sel && isRange(sel) && sel.b - sel.a > 0.02) {
      playRange(sel.a, sel.b)
      return
    }
    let from = sel ? sel.a : playT != null && playT >= trimA && playT < trimB ? playT : trimA
    if (from < trimA || from >= trimB) from = trimA
    playRange(from, trimB)
  }, [pause, playRange, playT, playing, sel, trimA, trimB])

  const setSpeed = useCallback(
    (x: number) => {
      // 40b: a new speed while playing pauses it.
      if (playing) pause()
      setSpeedState(x)
      preview.setRate(x)
    },
    [pause, playing, preview],
  )

  const toggleLoop = useCallback(() => {
    setLoop((on) => {
      const next = !on
      if (playing) preview.setLoop(next ? (sel && isRange(sel) ? sel.a : trimA) : null)
      return next
    })
  }, [playing, preview, sel, trimA])

  // Out of sight (its tab hidden, the area folded): it stops.
  useEffect(() => {
    if (!visible) pause()
  }, [visible, pause])

  // Zoomed in, the view keeps the playhead in sight (40b: 10% from the left).
  useEffect(() => {
    if (!playing || playT == null || zoom <= 1) return
    if (playT > va + w || playT < va) setViewStart(Math.max(0, playT - w * 0.1))
  }, [playT, playing, va, w, zoom])

  const zoomBy = useCallback(
    (f: number) => {
      const z = Math.max(1, Math.min(MAX_ZOOM, zoom * f))
      const focus = sel ? (sel.a + sel.b) / 2 : playT != null ? playT : va + w / 2
      const nw = length / z
      setZoom(z)
      setViewStart(Math.max(0, Math.min(length - nw, focus - nw / 2)))
    },
    [length, playT, sel, va, w, zoom],
  )

  /** Keep this (item 17): the selection becomes the kept part, one Undo step. */
  const keepSelection = useCallback(async () => {
    if (!sel || !isRange(sel)) return
    pause()
    const a = round2(sel.a)
    const b = round2(sel.b)
    setSel(null)
    await commitTrim(a, b)
  }, [commitTrim, pause, sel])

  // ——— Delete this / Insert audio here (items 17–18): unsaved until a new
  // version is saved. The trim keeps its place in the sound (40b).
  // An End still at the recording's own edge stays at the edge.
  const atEdge = trimB >= length - 1e-6 && storedB < 0 && draft.trim == null
  const deleteSelection = useCallback(() => {
    if (!sel || !isRange(sel)) return
    pause()
    const op: EditOp = { kind: "del", a: round3(sel.a), b: round3(sel.b) }
    const tr = shiftTrim(op, trimA, trimB, atEdge)
    setDraft(pushDraft(draft, { ops: [...ops, op], trim: tr }))
    setSel({ a: op.a, b: op.a })
  }, [atEdge, draft, ops, pause, sel, setDraft, trimA, trimB])

  const insertAudio = useCallback(
    (id: string, src: PcmSource & { duration?: number }, meta: DraftSource) => {
      if (!sel) return
      pause()
      const len = round3(src.data.length / src.rate)
      const op: EditOp = { kind: "ins", at: round3(sel.a), src: id, len, label: meta.label }
      setSources((m) => ({ ...m, [id]: src }))
      const tr = shiftTrim(op, trimA, trimB, atEdge)
      setDraft(pushDraft(draft, { ops: [...ops, op], trim: tr, sources: { ...draft.sources, [id]: meta } }))
      setSel({ a: op.at, b: op.at + len })
    },
    [atEdge, draft, ops, pause, sel, setDraft, trimA, trimB],
  )

  /** Undo the newest unsaved edit; false when there is none (Q4: then the
   *  project's Undo is the one to use). */
  const undoUnsaved = useCallback((): boolean => {
    const prev = undoDraft(draft)
    if (!prev) return false
    pause()
    setDraft(prev)
    setSel(null)
    return true
  }, [draft, pause, setDraft])

  const setScope = useCallback((scope: "clip" | "all") => setDraft({ ...draft, scope }), [draft, setDraft])
  /** After a save: the edits are in the new version now. */
  const clearDraft = useCallback(() => setDraft(EMPTY_DRAFT), [setDraft])

  return {
    draft,
    deleteSelection,
    insertAudio,
    live,
    setLive,
    undoUnsaved,
    setScope,
    clearDraft,
    status: error ? ("error" as const) : pcm ? ("ready" as const) : ("loading" as const),
    pcm,
    lookup,
    ops,
    sources,
    setSources,
    placed,
    length,
    trimA,
    trimB,
    clip,
    liveTrim,
    setLiveTrim,
    commitTrim,
    level,
    setLiveLevel,
    commitLevel,
    sel,
    select,
    clearSel,
    view,
    setViewStart,
    zoomBy,
    playT,
    setPlayT,
    playing,
    togglePlay,
    pause,
    playRange,
    speed,
    setSpeed,
    loop,
    toggleLoop,
    keepSelection,
  }
}

export type StationEditor = ReturnType<typeof useStationEditor>
