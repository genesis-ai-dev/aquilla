// The Station's state for one open recording (AQU-2327): its samples, the
// edit list over them, the kept part, the selection, the view and the
// player. Behaviour follows the working build (board 40b) unless a comment
// says otherwise.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { claimActiveAudio, clearActiveAudioIf, type ActiveAudioController } from "@/lib/audio/audio-coordinator"
import {
  clampTrim,
  lengthOf,
  MIN_KEPT_SEC,
  placeSegments,
  round2,
  segmentsOf,
  type ClipMix,
  type EditOp,
  type PlacedSegment,
} from "@/lib/station/edit-list"
import { loadStationPcm, type StationPcm } from "@/lib/station/load"
import { StationPreview } from "@/lib/station/preview"
import { renderSegments, type PcmSource } from "@/lib/station/render"
import type { StationTarget } from "@/lib/station/target"
import type { StationHost, StationTake } from "./station-host"

export const BASE_SRC = "base"
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
export const MAX_ZOOM = 16

export interface Selection {
  a: number
  b: number
}

export const isRange = (s: Selection | null): s is Selection => s != null && s.b - s.a > 0.005

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

  // Inserted audio's samples, by the key its operation names (slice 5).
  const [sources, setSources] = useState<Record<string, PcmSource>>({})
  const lookup = useCallback(
    (src: string): PcmSource | null => (src === BASE_SRC ? pcm : (sources[src] ?? null)),
    [pcm, sources],
  )

  // ——— The edit list (deletes and inserts; saved as a new version)
  const [ops, setOps] = useState<EditOp[]>([])
  const placed: PlacedSegment[] = useMemo(
    () => placeSegments(segmentsOf(BASE_SRC, pcm?.duration ?? 0, ops)),
    [pcm, ops],
  )
  const length = useMemo(() => Math.max(MIN_KEPT_SEC, lengthOf(placed)), [placed])

  // ——— The kept part: the take's stored trim, or the edge being dragged.
  const storedA = (take.att.trimStartMs ?? 0) / 1000
  const storedB = take.att.trimEndMs != null ? take.att.trimEndMs / 1000 : -1
  const [liveTrim, setLiveTrim] = useState<{ a: number; b: number } | null>(null)
  const { trimA, trimB } = clampTrim(liveTrim?.a ?? storedA, liveTrim?.b ?? storedB, length)
  const clip: ClipMix = useMemo(() => ({ trimA, trimB, fadeIn: 0, fadeOut: 0, gainDb: 0 }), [trimA, trimB])

  /** Save a trim as one Undo step; null on an end = back to the edge. */
  const commitTrim = useCallback(
    async (a: number, b: number) => {
      const c = clampTrim(a, b, length)
      setLiveTrim(null)
      const startMs = c.trimA > 0.0005 ? Math.round(c.trimA * 1000) : undefined
      const endMs = c.trimB < length - 0.0005 ? Math.round(c.trimB * 1000) : undefined
      const curStart = take.att.trimStartMs ?? undefined
      const curEnd = take.att.trimEndMs ?? undefined
      if ((curStart ?? 0) === (startMs ?? 0) && curEnd === endMs) return
      await host.trim(target.cellId, target.audioId, { trimStartMs: startMs, trimEndMs: endMs })
    },
    [host, length, take.att.trimEndMs, take.att.trimStartMs, target.audioId, target.cellId],
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
    if (ops.length === 0) {
      preview.setSamples(pcm.data, pcm.rate)
      return
    }
    const id = setTimeout(() => preview.setSamples(renderSegments(placed, lookup, pcm.rate), pcm.rate), 150)
    return () => clearTimeout(id)
  }, [pcm, ops, placed, lookup, preview])

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
    if (isRange(sel) && sel.b - sel.a > 0.02) {
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
      if (playing) preview.setLoop(next ? (isRange(sel) ? sel.a : trimA) : null)
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
    if (!isRange(sel)) return
    pause()
    const a = round2(sel.a)
    const b = round2(sel.b)
    setSel(null)
    await commitTrim(a, b)
  }, [commitTrim, pause, sel])

  return {
    status: error ? ("error" as const) : pcm ? ("ready" as const) : ("loading" as const),
    pcm,
    lookup,
    ops,
    setOps,
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
