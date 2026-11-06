// Where the film track's frames come from (AQU-2253). DOM-free, so the queue,
// the cache and the give-up rule are testable; the capture itself is handed in.
//
// THE CHOICE, AND WHY. Aquilla's films are HLS streams (a master.m3u8 with
// renditions from 480p to 4K, 4-second fMP4 segments). Their masters carry no
// thumbnail track — no I-frame playlist (EXT-X-I-FRAME-STREAM-INF), no image
// playlist (EXT-X-IMAGE-STREAM-INF) — and nothing else on offer names a
// thumbnail, so there is no cheap picture to point at. The one source is the
// film itself: a hidden, muted <video> of its own (never the Film panel's,
// whose playback a seek would disturb), at the lowest rendition, seeked to
// each tile's moment and drawn into a small canvas.
//
// That costs a seek, and on a stream a segment fetch, per frame. So:
//  - only the tiles in view are asked for, left to right — the timeline
//    draws only what is in view, and so does this;
//  - one capture at a time, so the hidden element never has two seeks in
//    flight (the way hls.js wedges) and the Film panel keeps the bandwidth;
//  - every frame is kept, per film, for the session (a few KB of JPEG each,
//    a bounded number of them), so scrolling back and zooming in and out
//    reuse what was fetched; tile moments snap to a grid for exactly that;
//  - a film that will not give frames (a YouTube picture, a server that
//    refuses them, a canvas the browser will not read) stops being asked
//    after a few tries, and the strip stays its black with the sprockets.

/** Frames kept per film. ~3 KB each as a small JPEG: well under a megabyte. */
export const FILM_FRAME_CACHE_MAX = 300
/** Consecutive failures before a film is taken to give no frames at all. */
export const FILM_FRAME_MAX_FAILURES = 3

/** Grab the film's picture at `sec`. Resolves the picture's URL (a data: URL),
 *  or null for "not this one". Throws `FrameUnavailableError` for "never". */
export type CaptureFrame = (sec: number) => Promise<string | null>

/** The film can never give frames here (a tainted canvas, a YouTube picture). */
export class FrameUnavailableError extends Error {
  constructor(message = "frames unavailable") {
    super(message)
    this.name = "FrameUnavailableError"
  }
}

/** More draws of one frame after a blank one, before the blank is believed. */
export const FILM_FRAME_BLANK_RETRIES = 3
/** A channel at or under this reads as black. */
const BLACK_MAX = 16

/** What one draw of the film put in the picture: nothing at all, only black,
 *  or a picture. */
export type DrawnFrame = "empty" | "black" | "picture"

/** Read a drawn picture's pixels (RGBA, as a canvas's getImageData gives). */
export function drawnFrameKind(rgba: ArrayLike<number>): DrawnFrame {
  let drawn = false
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    drawn = true
    if (rgba[i] > BLACK_MAX || rgba[i + 1] > BLACK_MAX || rgba[i + 2] > BLACK_MAX) return "picture"
  }
  return drawn ? "black" : "empty"
}

/**
 * Draw a frame until it shows a picture. Safari can hand back black, or
 * nothing, for a frame it has seeked to but not yet put on screen (Sam's
 * black strip, Oct 29); a beat later the same draw has the picture. So a
 * blank draw gets `FILM_FRAME_BLANK_RETRIES` more, with `settle` between them.
 * Black after all of them is the film's own (a fade, a night scene); empty
 * means the film never drew.
 */
export async function drawUntilPictured(
  draw: () => DrawnFrame,
  settle: (retry: number) => Promise<void>,
): Promise<DrawnFrame> {
  let kind = draw()
  for (let retry = 1; kind !== "picture" && retry <= FILM_FRAME_BLANK_RETRIES; retry++) {
    await settle(retry)
    kind = draw()
  }
  return kind
}

export interface FilmFrameStats {
  captured: number
  failed: number
  unavailable: boolean
  cached: number
  pending: number
  /** Time per captured frame, seek to picture, in ms. */
  avgMs: number
  maxMs: number
}

const keyOf = (sec: number) => (Math.round(sec * 100) / 100).toFixed(2)

/** Each film's frames outlive the timeline that asked for them: switching
 *  files and back must not fetch them again. */
const caches = new Map<string, Map<string, string>>()

function cacheFor(film: string): Map<string, string> {
  let c = caches.get(film)
  if (!c) {
    c = new Map()
    caches.set(film, c)
  }
  return c
}

export function resetFilmFramesForTests(): void {
  caches.clear()
}

export class FilmFrameQueue {
  private readonly cache: Map<string, string>
  private wanted: number[] = []
  private busy = false
  private failures = 0
  private dead = false
  private disposed = false
  private capture: CaptureFrame | null = null
  private readonly listeners = new Set<() => void>()
  private readonly times: number[] = []
  private captured = 0
  private failed = 0

  private readonly now: () => number

  constructor(
    film: string,
    now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  ) {
    this.cache = cacheFor(film)
    this.now = now
  }

  /** The capture to run, once there is an element ready to give pictures;
   *  null takes it away again (the element went). */
  attach(capture: CaptureFrame | null): void {
    this.capture = capture
    this.pump()
  }

  /** The picture for this moment, if it has been fetched. */
  get(sec: number): string | null {
    return this.cache.get(keyOf(sec)) ?? null
  }

  /** The moments the strip shows right now, in the order to fetch them. Each
   *  call replaces the last: a tile scrolled out of view is no longer wanted. */
  want(secs: readonly number[]): void {
    if (this.dead || this.disposed) return
    const seen = new Set<string>()
    this.wanted = []
    for (const sec of secs) {
      const k = keyOf(sec)
      if (seen.has(k) || this.cache.has(k)) continue
      seen.add(k)
      this.wanted.push(sec)
    }
    this.pump()
  }

  /** True once the film has shown it will not give frames. */
  get unavailable(): boolean {
    return this.dead
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  stats(): FilmFrameStats {
    const total = this.times.reduce((a, b) => a + b, 0)
    return {
      captured: this.captured,
      failed: this.failed,
      unavailable: this.dead,
      cached: this.cache.size,
      pending: this.wanted.length,
      avgMs: this.times.length ? Math.round(total / this.times.length) : 0,
      maxMs: this.times.length ? Math.round(Math.max(...this.times)) : 0,
    }
  }

  dispose(): void {
    this.disposed = true
    this.capture = null
    this.wanted = []
    this.listeners.clear()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }

  private remember(sec: number, url: string): void {
    const k = keyOf(sec)
    this.cache.delete(k)
    this.cache.set(k, url)
    while (this.cache.size > FILM_FRAME_CACHE_MAX) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
  }

  private pump(): void {
    if (this.busy || this.dead || this.disposed || !this.capture) return
    const sec = this.wanted.shift()
    if (sec == null) return
    if (this.cache.has(keyOf(sec))) {
      this.pump()
      return
    }
    const capture = this.capture
    this.busy = true
    const started = this.now()
    void capture(sec)
      .then(
        (url) => {
          if (this.disposed) return
          if (url) {
            this.failures = 0
            this.captured += 1
            this.times.push(this.now() - started)
            if (this.times.length > 200) this.times.shift()
            this.remember(sec, url)
            this.notify()
          } else {
            this.failed += 1
            this.failures += 1
          }
        },
        (err: unknown) => {
          if (this.disposed) return
          this.failed += 1
          this.failures += 1
          if (err instanceof FrameUnavailableError) this.failures = FILM_FRAME_MAX_FAILURES
        },
      )
      .finally(() => {
        this.busy = false
        if (this.disposed) return
        if (this.failures >= FILM_FRAME_MAX_FAILURES) {
          this.dead = true
          this.wanted = []
          this.notify()
          return
        }
        this.pump()
      })
  }
}
