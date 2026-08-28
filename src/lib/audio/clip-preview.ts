// Hearing ONE clip: the chip's play button.
// (AQU-646 stage 5)
//
// WHY THIS DECODES INSTEAD OF USING AN <audio> ELEMENT, which is the decision
// everything else here follows from:
//
//   Every recorded take is born trimmed (`takeTrims`), so "play it as it appears
//   in the timeline" almost always means "play a window, not a file". The only
//   engine in the app that honours a stored trim — the queue's overlay pool —
//   deliberately GIVES UP on exactly the clips this button will meet most: a
//   MediaRecorder webm reports `duration === Infinity` until it has been
//   indexed, and seeking one in that state fires `ended` immediately and throws
//   the take away. `wireOverlayElement`'s comment measures it. So an element
//   here would ignore the trim on essentially every take in every project.
//
// AND THE PARTITION IS A SYMMETRY, NOT A HEDGE. The clips that break an element
// are the SHORT ones (takes, seconds long, cheap to decode); the clips too big
// to decode are long attached files, which carry honest duration metadata and
// therefore seek correctly. So: decode below a length gate, element above it,
// and each is used precisely where the other is unsafe.
//
// ON THE AUDIO DEVICE. This borrows the app's one long-lived context rather than
// opening its own — `output-context.ts` explains that CREATING a context is the
// operation that makes the browser reconfigure the shared device, which on a
// headset reaches the microphone and has twice eaten the head of a take. Note
// this does the opposite of its sibling `peaks.ts`, which opens and closes a
// bare context per call, two at a time on every scroll; that is a debt, not a
// pattern to copy.
//
// IT MUST NOT IMPORT `play-queue`. That module is enormous and mocked across
// half the suite, so importing it would drag the whole transport into every test
// that renders a chip. Mute therefore arrives as a getter the caller supplies —
// the same structural-parameter trick `slotAudible` already uses for the same
// reason.

import { clearActiveAudioIf, setActiveAudio, type ActiveAudioController } from "./audio-coordinator"
import { audioCacheGet, audioCachePut } from "./bytes-cache"
import {
  canDecodePreview,
  CLIP_FADE_SEC,
  SCHEDULE_AHEAD_SEC,
  PREVIEW_BUFFER_BUDGET_BYTES,
} from "./clip-preview-window"
import { micIsHeld } from "./mic-hold"
import { getOutputContext, peekOutputContext } from "./output-context"
import { fetchCellAudio, getCellAudioStreamUrl, parseFrontierAudioUrl } from "./upload"
import type { SyncTokenFetcher } from "./peaks-loader"

export interface ClipPreviewSource {
  /** `frontier-audio://<audioId>.<ext>`. Parsed for the BYTES key — which is
   *  the (audioId, ext) pair, NOT the attachment key. `peaks-loader` opens with
   *  a warning about how easy those two are to swap, and how little it costs
   *  visibly when you do. */
  url: string
  projectId: string
  /** The file that OWNS the clip — a hidden cue sibling for a linked take, not
   *  necessarily the file on screen. */
  fileId: string
  getSyncToken: SyncTokenFetcher
  /** From the attachment, so the length gate can be applied BEFORE a byte
   *  moves. Null when nobody has measured this clip. */
  durationSec: number | null
}

export interface ClipPreviewHandle {
  stop(): void
  isPlaying(): boolean
  /**
   * Where the audio clock is INSIDE THE CLIP, in clip seconds — the same clock
   * as the trims. Null until sound has actually started (the decode or the
   * stream fetch is still in flight — a wall clock started at the press would
   * lie by exactly that latency) and again after stop. The chip's
   * mini-playhead reads this once per frame; it is a read, never a seek.
   */
  positionSec(): number | null
  /**
   * False when there is no audio pipeline at all — every unit test, since
   * happy-dom has no AudioContext.
   *
   * A HANDLE IS ALWAYS RETURNED, never null and never a throw. That is what
   * lets a button drive its pressed state off the handle's lifecycle instead of
   * off "the engine is making noise", which no unit test could ever observe.
   */
  audible: boolean
}

export type PrimeResult = "ready" | "too-long" | "unavailable"

// ── The decoded-buffer cache ────────────────────────────────────────────────
//
// BYTE-BUDGETED, NOT COUNT-BUDGETED, and that distinction is the whole safety
// of it: entries are not comparable. 48kHz stereo Float32 is 384KB per second,
// and the recorder's upload control accepts a 100MB file as a take — so "keep
// the last four" can mean keeping six gigabytes.

interface CachedBuffer {
  buffer: AudioBuffer
  bytes: number
}
const buffers = new Map<string, CachedBuffer>()
/** In-flight decodes, so two fast presses on one clip decode once. */
const inFlight = new Map<string, Promise<AudioBuffer | null>>()

const cacheKey = (audioId: string, ext: string) => `${audioId}::${ext}`

function rememberBuffer(key: string, buffer: AudioBuffer): void {
  const bytes = buffer.length * buffer.numberOfChannels * 4
  buffers.delete(key)
  buffers.set(key, { buffer, bytes })
  let total = 0
  for (const entry of buffers.values()) total += entry.bytes
  // Map iterates in insertion order, so the first key is the oldest.
  while (total > PREVIEW_BUFFER_BUDGET_BYTES && buffers.size > 1) {
    const oldest = buffers.keys().next().value as string | undefined
    if (!oldest) break
    total -= buffers.get(oldest)?.bytes ?? 0
    buffers.delete(oldest)
  }
}

/**
 * The context, or null.
 *
 * GATE THE CREATION, NOT THE FEATURE. The two precedents look like they
 * disagree and do not: the latency probe bails while the mic is held because
 * losing a background reading costs nothing, while the countdown beep calls
 * through with the mic hot because a beep is an obligation. A preview is the
 * second kind — but only the FIRST creation can disturb the device, and by the
 * time anyone presses play the countdown or the probe has almost always made it
 * already. So: use one that exists, no questions; decline to create one only
 * while a take is possible.
 */
function previewContext(): AudioContext | null {
  const existing = peekOutputContext()
  if (existing) return existing
  if (micIsHeld()) return null
  return getOutputContext()
}

/** Resume on the gesture, not at first sound: by the time playback is due we may
 *  be outside the browser's autoplay window and nothing would be heard. */
function resumeContext(ctx: AudioContext): void {
  if (ctx.state === "suspended") void ctx.resume().catch(() => { /* user-driven */ })
}

async function loadBytes(src: ClipPreviewSource): Promise<{ bytes: Uint8Array; key: string } | null> {
  const frontier = parseFrontierAudioUrl(src.url)
  // A legacy LFS attachment: its bytes are no longer reachable at all.
  if (!frontier) return null
  const key = cacheKey(frontier.audioId, frontier.ext)
  const cached = await audioCacheGet(frontier.audioId, frontier.ext)
  if (cached) return { bytes: cached, key }
  const bytes = await fetchCellAudio({
    projectId: src.projectId,
    fileId: src.fileId,
    audioId: frontier.audioId,
    ext: frontier.ext,
    getSyncToken: src.getSyncToken,
  })
  void audioCachePut(frontier.audioId, frontier.ext, bytes)
  return { bytes, key }
}

async function loadBuffer(src: ClipPreviewSource): Promise<AudioBuffer | null> {
  const frontier = parseFrontierAudioUrl(src.url)
  if (!frontier) return null
  const key = cacheKey(frontier.audioId, frontier.ext)
  const have = buffers.get(key)
  if (have) {
    // Touch for LRU.
    buffers.delete(key)
    buffers.set(key, have)
    return have.buffer
  }
  const running = inFlight.get(key)
  if (running) return running

  const task = (async (): Promise<AudioBuffer | null> => {
    try {
      const ctx = previewContext()
      if (!ctx) return null
      const loaded = await loadBytes(src)
      if (!loaded) return null
      if (!canDecodePreview(src.durationSec, loaded.bytes.byteLength)) return null
      // `decodeAudioData` DETACHES its input, and these bytes are shared with
      // the waveform and the transcriber — hand it a copy nobody else holds.
      const copy = new Uint8Array(loaded.bytes.byteLength)
      copy.set(loaded.bytes)
      const buffer = await ctx.decodeAudioData(copy.buffer as ArrayBuffer)
      rememberBuffer(key, buffer)
      return buffer
    } catch {
      // Every failure here is "no preview" — a missing clip, a decode refusal,
      // no session. Never a throw into a pointer handler.
      return null
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, task)
  return task
}

// ── One preview at a time, app-wide ─────────────────────────────────────────
//
// A PROPERTY OF THE ENGINE, not a protocol every chip has to keep. Note that
// `setActiveAudio` deliberately does NOT pause the previous holder, so the
// coordinator alone would not give us this.

let currentPreview: { stop(): void } | null = null

function takeTheFloor(next: { stop(): void }): void {
  const previous = currentPreview
  currentPreview = next
  previous?.stop()
}

export function stopClipPreview(): void {
  const previous = currentPreview
  currentPreview = null
  previous?.stop()
}

/** One trimmed clip, played as scheduled. */
function playWindow(
  ctx: AudioContext,
  buffer: AudioBuffer,
  offsetSec: number,
  durationSec: number | null,
  opts: { fadeSec: number; volume?: number; onEnded?: () => void },
): { stop(): void } {
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const gain = ctx.createGain()
  source.connect(gain)
  gain.connect(ctx.destination)

  const t0 = ctx.currentTime + SCHEDULE_AHEAD_SEC
  const length = durationSec ?? Math.max(0, buffer.duration - offsetSec)
  const t1 = t0 + length
  // LINEAR, and from a real zero. `exponentialRampToValueAtTime` cannot start
  // at zero at all — the countdown's ramp-from-0.0001 is a workaround for a
  // different problem and must not be copied here.
  const fade = Math.min(opts.fadeSec, length / 2)
  // The transport's own level, so a preview is as loud as playing the timeline
  // would have been. Sam's standing rule for this surface is "no special rules —
  // go with how the timeline already works".
  const peak = opts.volume == null ? 1 : Math.min(1, Math.max(0, opts.volume))
  gain.gain.setValueAtTime(0, t0)
  gain.gain.linearRampToValueAtTime(peak, t0 + fade)
  gain.gain.setValueAtTime(peak, Math.max(t0 + fade, t1 - fade))
  gain.gain.linearRampToValueAtTime(0, t1)

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    try { source.disconnect() } catch { /* already gone */ }
    try { gain.disconnect() } catch { /* already gone */ }
    opts.onEnded?.()
  }
  source.onended = cleanup
  try {
    source.start(t0, offsetSec, length)
    source.stop(t1)
  } catch {
    cleanup()
  }
  return {
    stop() {
      if (done) return
      try { source.stop() } catch { /* already stopped */ }
      cleanup()
    },
  }
}

const SILENT_HANDLE: ClipPreviewHandle = {
  stop() { /* nothing was ever started */ },
  isPlaying: () => false,
  positionSec: () => null,
  audible: false,
}

/**
 * Resume the device and start the decode, synchronously inside the gesture.
 *
 * Called on pointerdown rather than at first sound: a browser only honours
 * `resume()` inside a user gesture, and by the time the first sound is due the
 * gesture is over.
 */
export async function primeClipPreview(src: ClipPreviewSource): Promise<PrimeResult> {
  const ctx = previewContext()
  if (!ctx) return "unavailable"
  resumeContext(ctx)
  if (!canDecodePreview(src.durationSec)) return "too-long"
  const buffer = await loadBuffer(src)
  return buffer ? "ready" : "unavailable"
}

/**
 * Play exactly `[startSec, endSec)` of the clip — its own clock, not the file's.
 *
 * `muted` is the CALLER's to state, never read from a store in here. The chip's
 * play button deliberately passes nothing — it sounds through a muted track
 * because it is an inspection tool (Sam). The option survives the removal of
 * the trim grains, which were the caller that DID respect the mute, so that a
 * future caller can still say which it is rather than inheriting a default.
 */
export function playClipWindow(
  src: ClipPreviewSource,
  window: { startSec: number; endSec: number | null },
  opts?: { muted?: boolean; volume?: number; onEnded?: () => void },
): ClipPreviewHandle {
  const ctx = previewContext()
  if (!ctx || opts?.muted) {
    opts?.onEnded?.()
    return SILENT_HANDLE
  }
  resumeContext(ctx)

  let live: { stop(): void } | null = null
  let stopped = false
  let controller: ActiveAudioController | null = null
  // For `positionSec`: the clip window actually scheduled, and the context
  // time it was scheduled AT — set only once the decode has resolved, so a
  // null position is exactly "no sound yet".
  let clipStart = 0
  let clipEnd = 0
  let startedAtCtx: number | null = null

  const finish = () => {
    if (stopped) return
    stopped = true
    live?.stop()
    live = null
    if (controller) clearActiveAudioIf(controller)
    if (currentPreview === handle) currentPreview = null
    opts?.onEnded?.()
  }

  const handle: ClipPreviewHandle & { stop(): void } = {
    stop: finish,
    isPlaying: () => !stopped,
    positionSec: () => {
      if (stopped || startedAtCtx == null) return null
      return Math.min(clipStart + Math.max(0, ctx.currentTime - startedAtCtx), clipEnd)
    },
    audible: true,
  }
  takeTheFloor(handle)

  // REGISTERED WHILE SOUNDING so `pauseAllPlayback()` reaches it — the recording
  // modal's open path calls that precisely so "the mic never records over
  // sounding audio", and the chip's own mic button is what opens it. Cleared on
  // stop so the spacebar is never routed at a preview.
  controller = {
    isPlaying: () => !stopped,
    play: async () => { /* a preview is not resumable — press it again */ },
    pause: finish,
  }
  setActiveAudio(controller)

  void loadBuffer(src).then((buffer) => {
    if (stopped) return
    if (!buffer) { finish(); return }
    const start = Math.min(Math.max(0, window.startSec), buffer.duration)
    const end = window.endSec == null ? buffer.duration : Math.min(window.endSec, buffer.duration)
    const length = Math.max(0, end - start)
    if (length <= 0) { finish(); return }
    clipStart = start
    clipEnd = end
    // The same instant `playWindow` computes as its own t0 — kept in step by
    // construction, since both are derived from `ctx.currentTime` here.
    startedAtCtx = ctx.currentTime + SCHEDULE_AHEAD_SEC
    live = playWindow(ctx, buffer, start, length, {
      // A clip-length fade is inaudible but still removes the edge click.
      fadeSec: CLIP_FADE_SEC,
      volume: opts?.volume,
      onEnded: finish,
    })
  })

  return handle
}

/**
 * The clips too long to decode, played through an element.
 *
 * Safe here and nowhere else: a clip only reaches this path by HAVING a
 * measured duration above the gate, which is exactly the condition under which
 * `currentTime` is trustworthy. The durationless webm that breaks an element
 * can never arrive here.
 */
export function playLongClipWindow(
  src: ClipPreviewSource,
  window: { startSec: number; endSec: number | null },
  opts?: { onEnded?: () => void },
): ClipPreviewHandle {
  const frontier = parseFrontierAudioUrl(src.url)
  if (!frontier || typeof Audio === "undefined") {
    opts?.onEnded?.()
    return SILENT_HANDLE
  }
  let element: HTMLAudioElement | null = null
  let stopped = false
  let controller: ActiveAudioController | null = null

  const finish = () => {
    if (stopped) return
    stopped = true
    element?.pause()
    element = null
    if (controller) clearActiveAudioIf(controller)
    if (currentPreview === handle) currentPreview = null
    opts?.onEnded?.()
  }
  const handle: ClipPreviewHandle & { stop(): void } = {
    stop: finish,
    isPlaying: () => !stopped,
    // `currentTime` on a WHOLE-FILE element is already clip seconds. Gated on
    // `paused` so the stream-fetch and metadata wait read as "no sound yet",
    // the same shape the decode path has.
    positionSec: () => (!stopped && element != null && !element.paused ? element.currentTime : null),
    audible: true,
  }
  takeTheFloor(handle)
  controller = { isPlaying: () => !stopped, play: async () => {}, pause: finish }
  setActiveAudio(controller)

  void getCellAudioStreamUrl({
    projectId: src.projectId,
    fileId: src.fileId,
    audioId: frontier.audioId,
    ext: frontier.ext,
    getSyncToken: src.getSyncToken,
  })
    .then((streamUrl) => {
      if (stopped || !streamUrl) { finish(); return }
      const audio = new Audio(streamUrl)
      audio.preload = "metadata"
      element = audio
      audio.onended = finish
      audio.onerror = finish
      audio.onloadedmetadata = () => {
        // The same guard the queue applies, kept even though this path is
        // reached only by clips that satisfy it — the cost is one comparison
        // and the failure it prevents is silent.
        if (Number.isFinite(audio.duration) && window.startSec > 0) {
          audio.currentTime = Math.min(window.startSec, audio.duration)
        }
      }
      if (window.endSec != null) {
        const stopAt = window.endSec
        audio.ontimeupdate = () => { if (audio.currentTime >= stopAt) finish() }
      }
      void audio.play().catch(() => finish())
    })
    .catch(finish)

  return handle
}

/** Play a window through whichever engine is safe for this clip. */
export function playClip(
  src: ClipPreviewSource,
  window: { startSec: number; endSec: number | null },
  opts?: { muted?: boolean; onEnded?: () => void },
): ClipPreviewHandle {
  return canDecodePreview(src.durationSec)
    ? playClipWindow(src, window, opts)
    : playLongClipWindow(src, window, opts)
}

export function __resetClipPreviewForTests(): void {
  stopClipPreview()
  buffers.clear()
  inFlight.clear()
}
