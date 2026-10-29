// The film track's frames (AQU-2253): a hidden, muted copy of the film, only
// ever seeked, that draws each tile's moment into a small picture. See
// lib/timeline/film-frames for why frames come from here and what they cost.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { readAtVersion } from "@/hooks/useActiveCellStore"
import { useHlsVideo } from "@/hooks/useHlsVideo"
import { useMediaPictureUrl } from "@/hooks/useMediaPictureUrl"
import type { FrontierSession } from "@/lib/frontier/types"
import { referencePrefetchAllowed } from "@/lib/net/prefetch-policy"
import { FilmFrameQueue, FrameUnavailableError, type CaptureFrame } from "@/lib/timeline/film-frames"
import { setVideoDurationSec } from "@/lib/timeline/video-duration"
import { youTubeVideoId } from "@/lib/video/youtube"

/** The picture each frame is drawn at: board 56's 58 × 36 tile at 2× (and a
 *  little over), so it stays sharp on a high-density screen. */
export const FILM_FRAME_W = 128
export const FILM_FRAME_H = 80
/** Never decode more than this for a 128 px picture: the smallest rendition. */
const GRABBER_MAX_HEIGHT = 240
/** How long one seek may take before that frame is given up on. */
const SEEK_PATIENCE_MS = 8000

function waitFor(video: HTMLVideoElement, event: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer = 0
    const done = (ok: boolean) => {
      window.clearTimeout(timer)
      video.removeEventListener(event, onEvent)
      video.removeEventListener("error", onError)
      resolve(ok)
    }
    const onEvent = () => done(true)
    const onError = () => done(false)
    video.addEventListener(event, onEvent)
    video.addEventListener("error", onError)
    timer = window.setTimeout(() => done(false), ms)
  })
}

/**
 * Seek the hidden film to `sec` and draw what it shows there, cropped to fill
 * the picture the way a tile's `object-fit: cover` would.
 */
export function videoFrameCapture(video: HTMLVideoElement): CaptureFrame {
  const canvas = document.createElement("canvas")
  canvas.width = FILM_FRAME_W
  canvas.height = FILM_FRAME_H
  const ctx = canvas.getContext("2d")
  return async (sec) => {
    if (!ctx) throw new FrameUnavailableError("no canvas")
    if (video.error) throw new FrameUnavailableError("the film did not load")
    const duration = video.duration
    const at = Number.isFinite(duration) && duration > 0 ? Math.min(sec, Math.max(0, duration - 0.1)) : sec
    if (Math.abs(video.currentTime - at) > 0.01) {
      const landed = waitFor(video, "seeked", SEEK_PATIENCE_MS)
      video.currentTime = at
      if (!(await landed)) return null
    }
    if (video.readyState < 2 && !(await waitFor(video, "loadeddata", SEEK_PATIENCE_MS))) return null
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return null
    const scale = Math.max(FILM_FRAME_W / vw, FILM_FRAME_H / vh)
    const sw = FILM_FRAME_W / scale
    const sh = FILM_FRAME_H / scale
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, FILM_FRAME_W, FILM_FRAME_H)
    try {
      return canvas.toDataURL("image/jpeg", 0.72)
    } catch {
      // A film from a server that does not allow it to be read back.
      throw new FrameUnavailableError("the film's pictures cannot be read here")
    }
  }
}

export interface FilmFrames {
  /** The picture for a tile's moment, or null while there is none. A fresh
   *  function each time a frame arrives, so the strip redraws. */
  frameFor(sec: number): string | null
  /** The moments in view, in the order to fetch them. */
  want(secs: readonly number[]): void
  /** The hidden element, to be rendered once somewhere in the lane. */
  grabber: ReactNode
}

export function useFilmFrames({
  src: storedSrc,
  fileId,
  projectId,
  session,
  enabled,
}: {
  src: string
  fileId: string
  projectId?: string
  session?: FrontierSession | null
  /** False: draw the plain strip (a test, a low-data link). */
  enabled: boolean
}): FilmFrames {
  const videoRef = useRef<HTMLVideoElement>(null)
  // A YouTube picture is an embed, not footage we can read: the plain strip.
  // So is a link the browser says to be sparing with (Data Saver, 2G) — the
  // same rule the app's other speculative fetches follow.
  const youTube = youTubeVideoId(storedSrc) != null
  const [allowed] = useState(() => referencePrefetchAllowed())
  const active = enabled && allowed && !youTube && Boolean(storedSrc)
  const src = useMediaPictureUrl({ src: storedSrc, projectId, fileId, session, retryKey: 0 }) ?? ""
  const stream = useHlsVideo(videoRef, active ? src : null, {
    maxHeight: GRABBER_MAX_HEIGHT,
    bufferSec: 1,
    enabled: active,
  })
  // Not disposed on unmount: its frames live in the per-film cache, and the
  // capture is detached below, so a queue left behind simply goes quiet.
  const queue = useMemo(() => new FilmFrameQueue(storedSrc), [storedSrc])
  const [version, setVersion] = useState(0)
  useEffect(() => queue.subscribe(() => setVersion((v) => v + 1)), [queue])

  // The capture is attached once the hidden film can say how big it is.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
  }, [src, active])
  useEffect(() => {
    const video = videoRef.current
    if (!ready || !video) return
    queue.attach(videoFrameCapture(video))
    return () => queue.attach(null)
  }, [ready, queue])

  // The console seam: what the frames are costing, beside __aqVideoState.
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return
    ;(window as unknown as Record<string, unknown>).__aqFilmFrames = () => ({
      src: storedSrc,
      pipeline: stream.pipeline,
      active,
      ...queue.stats(),
    })
    return () => {
      delete (window as unknown as Record<string, unknown>).__aqFilmFrames
    }
  }, [queue, storedSrc, stream.pipeline, active])

  const frameFor = useMemo(
    () => readAtVersion(version, () => (sec: number) => queue.get(sec)),
    [queue, version],
  )
  const want = useMemo(() => (secs: readonly number[]) => queue.want(secs), [queue])

  const grabber = active && src ? (
    <video
      ref={videoRef}
      // The pipeline is part of the identity, as in the Film panel: the
      // streaming player and the browser never share an element.
      key={`${src}#${stream.pipeline}`}
      src={stream.pipeline === "hls" ? undefined : src}
      data-testid="tl-film-grabber"
      aria-hidden
      tabIndex={-1}
      muted
      playsInline
      preload="metadata"
      // Read back into a canvas, so it must be fetched as a CORS request; a
      // server that refuses gives the plain strip, not a broken one.
      crossOrigin={stream.pipeline === "hls" ? undefined : "anonymous"}
      disablePictureInPicture
      className="pointer-events-none absolute left-0 top-0 h-[2px] w-[2px] opacity-0"
      onLoadedMetadata={(e) => {
        setVideoDurationSec(storedSrc, e.currentTarget.duration)
        setReady(true)
      }}
      onError={() => queue.attach(() => Promise.reject(new FrameUnavailableError("the film did not load")))}
    />
  ) : null

  return { frameFor, want, grabber }
}
