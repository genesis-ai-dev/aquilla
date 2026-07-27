// Single-file play queue. Walks cells in order, plays each cell's
// preferred audio (recording > generated voice), and advances on end. The
// caller hands us a snapshot of cells + a "fetch bytes for this attachment"
// callback so the queue stays decoupled from useCellAudio's complex
// per-cell state machine.

import { useSyncExternalStore } from "react"
import type { CellData } from "@/hooks/useCells"
import { fetchCellAudio, getCellAudioStreamUrl, parseFrontierAudioUrl, audioIdSeededWith } from "./upload"
import { activeTargetForCell, sourceClipAudioForCell } from "./track-audio"
import { effectiveAttachmentDurationMs, targetChipGeom, targetDueSec } from "@/lib/timeline/lane-timing"
import { hasTiming, sortByLens } from "@/lib/timeline/derive"
import { buildProgramme, slotAtProgrammeSec, type Programme, type ProgrammeSlot } from "@/lib/timeline/programme"
import type { AudioTimingMode } from "@/lib/parsers/types"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { audioCacheGet, audioCachePut } from "./bytes-cache"
import { audioMimeForExt } from "./mime"
import type { FrontierSession } from "@/lib/frontier/types"
import { setActiveAudio, clearActiveAudioIf, type ActiveAudioController } from "./audio-coordinator"

export type QueueState =
  | { kind: "idle" }
  | { kind: "loading"; cellIndex: number; cellId: string }
  | { kind: "playing"; cellIndex: number; cellId: string }
  | { kind: "paused"; cellIndex: number; cellId: string }
  | { kind: "error"; message: string; cellId?: string }

const IDLE: QueueState = { kind: "idle" }
let state: QueueState = IDLE
const listeners = new Set<() => void>()

function notify(): void { for (const l of listeners) l() }

function setState(next: QueueState): void {
  state = next
  notify()
}

export function getQueueState(): QueueState { return state }

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useQueueState(): QueueState {
  return useSyncExternalStore(subscribe, () => state, () => IDLE)
}

// ── Playback progress (time/duration/rate/volume) ───────────────────────────
// Kept in a separate store from QueueState so the ~4×/sec timeupdate ticks only
// re-render the playback bar's scrubber, not every QueueState consumer.

export interface QueueProgress {
  /** Seconds on the current CLIP's clock. For an imported media file (one
   *  shared clip, sections windowed by trims) this IS file-timeline seconds,
   *  and `duration` is the file length — the transport + timeline playhead
   *  read it directly. (AQU-646) */
  currentTime: number
  duration: number
  /** Playback speed multiplier (persists across tracks). */
  rate: number
  /** 0..1 volume (persists across tracks). */
  volume: number
}

let progress: QueueProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
const progressListeners = new Set<() => void>()

function notifyProgress(): void { for (const l of progressListeners) l() }

function setProgress(patch: Partial<QueueProgress>): void {
  progress = { ...progress, ...patch }
  notifyProgress()
}

function subscribeProgress(listener: () => void): () => void {
  progressListeners.add(listener)
  return () => { progressListeners.delete(listener) }
}

export function useQueueProgress(): QueueProgress {
  return useSyncExternalStore(subscribeProgress, () => progress, () => progress)
}

export function getQueueProgress(): QueueProgress { return progress }

// ── Track audibility (round 5: per-track speaker buttons) ───────────────────
// The SOURCE track is the master element; the TARGET track is the dub overlay.
// Muting is strictly `element.muted` — overlay lifecycle never depends on the
// speaker buttons, so unmuting mid-section is positional (you hear the dub
// exactly where it would have been).

export interface TrackAudibility {
  source: boolean
  target: boolean
}

let audibility: TrackAudibility = { source: true, target: true }
const audibilityListeners = new Set<() => void>()

export function setQueueAudibility(next: TrackAudibility): void {
  audibility = { source: Boolean(next.source), target: Boolean(next.target) }
  if (currentAudio) currentAudio.muted = !audibility.source
  for (const e of overlayPool) if (e.element) e.element.muted = !audibility.target
  for (const l of audibilityListeners) l()
}

export function getQueueAudibility(): TrackAudibility { return audibility }

export function useQueueAudibility(): TrackAudibility {
  return useSyncExternalStore(
    (l) => {
      audibilityListeners.add(l)
      return () => { audibilityListeners.delete(l) }
    },
    () => audibility,
    () => audibility,
  )
}

// ── Single owned audio element ──────────────────────────────────────────────

let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null
let currentSeq = 0

// ── Target-audio overlay pool (rounds 5-7) ──────────────────────────────────
// Dub elements that fire as the master clock crosses each chip's audible
// start. Round 7: a bounded POOL instead of a single element — an overlong
// dub rings to its natural end WHILE the next one starts on time ("both
// sound"; the timeline draws the same overlap). Entries die at their natural
// end, at their trim end-stop, on error, on eviction (oldest, at the cap),
// or when their cell re-fires (replacement — no echo).

interface OverlayEntry {
  cellId: string
  audioId: string
  /** Null while the src resolves — the entry exists from the synchronous
   *  moment of fire so membership doubles as the re-entry guard. */
  element: HTMLAudioElement | null
  /** Object URL to revoke (blob playback only). */
  url: string | null
  /** Trim end on the CLIP's clock; null = play to natural end. */
  stopAtClipSec: number | null
}

const overlayPool: OverlayEntry[] = []
/** Realistic dialogue overlap is ≤2; one slack slot. Oldest-evicted. */
const MAX_OVERLAYS = 3

function soundingCellIds(): ReadonlySet<string> {
  return new Set(overlayPool.map((e) => e.cellId))
}

/** Round 6: a dub whose start lies AHEAD of the clock — armed here, fired by
 *  the master's ontimeupdate when the clock crosses it. Invariant: non-null
 *  iff the last applied overlay plan was "arm". */
let pendingDub: { cellId: string; dueSec: number } | null = null

// AQU-646: mutable current-segment state, readable by the element handlers.
// With seamless same-clip advance the element OUTLIVES the cell it was opened
// for — handlers must not close over a stale index/trim, they read these.
let currentIndex = -1
let currentTrim: { start: number; end: number } | null = null
/** The cell ATTACHMENT url (e.g. frontier-audio://…) — NOT the resolved src,
 *  so the streaming→blob fallback swap doesn't break same-clip matching. */
let currentAttachmentUrl: string | null = null
/** Seek target applied on loadedmetadata (Safari rejects pre-metadata seeks). */
let pendingStartSeconds: number | null = null

// ── SUB-53: audio-first transport state ─────────────────────────────────────
// In DUBBING everything above holds: the imported file is the master and the
// clock, and dubs ride on top of it. In AUDIO-FIRST the verses are laid out end
// to end (lib/timeline/programme.ts) and both sides of a verse start together;
// whichever side is shorter falls silent for the rest of the verse. Rather than
// a synthetic clock, the LONGER side clocks its own verse — so timing stays
// sample-accurate and cannot drift. The source side still lives on
// `currentAudio` and the dub still lives in the overlay pool, so muting, rate,
// volume and the app-wide audio coordinator all keep working untouched.
let timingMode: AudioTimingMode = "dubbing"
let programme: Programme | null = null
/** Index into `programme.slots` — the verse the transport is on. */
let progIndex = -1
/** Set while WE quiet an element mid-verse; its onpause must not report the
 *  whole programme as paused. */
let progSuppressPause = 0

const coordinatorController: ActiveAudioController = {
  isPlaying: () => Boolean(currentAudio && !currentAudio.paused),
  play: async () => { try { await currentAudio?.play() } catch { /* coordinator-driven, ignore */ } },
  pause: () => { currentAudio?.pause() },
}

function removeOverlayEntry(entry: OverlayEntry): void {
  const i = overlayPool.indexOf(entry)
  if (i >= 0) overlayPool.splice(i, 1)
  const el = entry.element
  if (el) {
    el.onended = null
    el.onerror = null
    el.ontimeupdate = null
    el.onloadedmetadata = null
    el.pause()
    el.src = ""
    entry.element = null
  }
  if (entry.url) {
    URL.revokeObjectURL(entry.url)
    entry.url = null
  }
}

function disposeAllOverlays(): void {
  while (overlayPool.length > 0) removeOverlayEntry(overlayPool[overlayPool.length - 1])
}

function disposeCurrent(): void {
  // Everything resets with the master element — including any armed dub.
  // (Overlay removal alone deliberately does NOT clear pendingDub: a
  // previous dub ending is unrelated to the next section's armed one.)
  pendingDub = null
  disposeAllOverlays()
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.src = ""
    currentAudio = null
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
  currentIndex = -1
  currentTrim = null
  currentAttachmentUrl = null
  pendingStartSeconds = null
  clearActiveAudioIf(coordinatorController)
  setProgress({ currentTime: 0, duration: 0 })
}

/** Seek within the currently-playing clip (seconds). Internal primitive —
 *  external callers use seekQueueToTime (file-timeline coords). */
function seekQueue(seconds: number): void {
  if (!currentAudio) return
  const d = currentAudio.duration
  currentAudio.currentTime = Number.isFinite(d) ? Math.max(0, Math.min(seconds, d)) : Math.max(0, seconds)
  setProgress({ currentTime: currentAudio.currentTime })
}

/** Set playback speed for the queue (applies live + to subsequent tracks). */
export function setQueueRate(rate: number): void {
  if (currentAudio) currentAudio.playbackRate = rate
  for (const e of overlayPool) if (e.element) e.element.playbackRate = rate
  setProgress({ rate })
}

/** Set queue volume 0..1 (applies live + to subsequent tracks). */
export function setQueueVolume(vol: number): void {
  const v = Math.max(0, Math.min(1, vol))
  if (currentAudio) currentAudio.volume = v
  for (const e of overlayPool) if (e.element) e.element.volume = v
  setProgress({ volume: v })
}

// ── Per-cell audio resolution ───────────────────────────────────────────────

/**
 * Pick the "best" audio attachment for a cell. Prefers a real recording
 * over a generated voice. Returns the attachment URL if one is playable.
 */
function pickPlayableAudio(cell: CellData): { audioId: string; url: string } | undefined {
  const ids = [cell.selectedAudioId, cell.selectedGeneratedVoiceAudioId]
  for (const id of ids) {
    if (!id) continue
    const att = cell.attachments?.[id]
    if (!att || att.isDeleted) continue
    return { audioId: id, url: att.url }
  }
  return undefined
}

/**
 * What the MASTER (clock) element plays for a cell. Round 5: for media
 * sections this is ALWAYS the shared source clip when one resolves — even
 * when a take is selected (the take belongs to the target overlay) — so the
 * source track plays continuously and every section keeps owning its
 * file-time span for seeks. Take-only sections and non-media cells fall back
 * to the selection-based pick.
 */
function masterAudioForCell(cell: CellData): { audioId: string; url: string } | undefined {
  if (cell.medium === "media") {
    const src = sourceClipAudioForCell(cell)
    if (src) return src
  }
  return pickPlayableAudio(cell)
}

interface ResolvedAudioSrc {
  src: string
  /** Object URL to revoke on dispose (blob playback only). */
  objectUrl: string | null
  /** True when src is an authenticated streaming URL — on media error the
   *  queue retries once via the full-bytes blob path. */
  streaming: boolean
  frontier: { audioId: string; ext: string } | null
}

/** Full-download fallback: fetch all bytes, write through to the OPFS cache,
 *  return a blob object URL. */
async function fetchFullBlobUrl(
  frontier: { audioId: string; ext: string },
  projectId: string,
  fileId: string,
  session: FrontierSession,
): Promise<string> {
  const bytes = await fetchCellAudio({
    projectId,
    fileId,
    audioId: frontier.audioId,
    ext: frontier.ext,
    getSyncToken: audioSyncTokenFetcherForSession(session),
  })
  void audioCachePut(frontier.audioId, frontier.ext, bytes)
  // MIME must match the real container — Safari/Firefox reject mistyped or
  // typeless blobs with a bare onerror ("Audio failed to load").
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: audioMimeForExt(frontier.ext) }))
}

/**
 * Resolve a cell attachment to a playable `<audio src>`. Progressive-playback
 * order: OPFS-cached bytes (offline-friendly, zero network) → authenticated
 * streaming URL (first sound before the download finishes; Range/206 handles
 * seeks) → full-download blob when no stream URL could be minted.
 */
async function resolveAudioSrc(
  attachmentUrl: string,
  projectId: string,
  fileId: string,
  session: FrontierSession,
): Promise<ResolvedAudioSrc> {
  const frontier = parseFrontierAudioUrl(attachmentUrl)
  if (!frontier) {
    // Direct (blob: / http) URL — the media element streams it natively.
    return { src: attachmentUrl, objectUrl: null, streaming: false, frontier: null }
  }
  if (!session.jwt) throw new Error("Sign in to play audio")
  const cached = await audioCacheGet(frontier.audioId, frontier.ext)
  if (cached) {
    const url = URL.createObjectURL(
      new Blob([cached as BlobPart], { type: audioMimeForExt(frontier.ext) }),
    )
    return { src: url, objectUrl: url, streaming: false, frontier }
  }
  const streamUrl = await getCellAudioStreamUrl({
    projectId,
    fileId,
    audioId: frontier.audioId,
    ext: frontier.ext,
    getSyncToken: audioSyncTokenFetcherForSession(session),
  })
  if (streamUrl) return { src: streamUrl, objectUrl: null, streaming: true, frontier }
  const url = await fetchFullBlobUrl(frontier, projectId, fileId, session)
  return { src: url, objectUrl: url, streaming: false, frontier }
}

// ── Programme transport (SUB-53, audio-first only) ──────────────────────────

/** True while the audio-first transport is the one running the show. */
function progRunning(): boolean {
  return timingMode === "audioFirst" && (state.kind === "playing" || state.kind === "loading")
}

function progCurrentSlot(): ProgrammeSlot | null {
  return programme?.slots[progIndex] ?? null
}

/** Pause an element without reporting the whole programme as paused — this is
 *  the silence the shorter side plays out for the rest of its verse. */
function progQuiet(el: HTMLAudioElement | null): void {
  if (!el || el.paused) return
  progSuppressPause++
  el.pause()
}

function progTargetEntry(): OverlayEntry | null {
  const slot = progCurrentSlot()
  if (!slot) return null
  return overlayPool.find((e) => e.cellId === slot.cellId) ?? null
}

/**
 * Which side is actually going to end this verse. Normally the declared one —
 * but a dub that failed to load hands the job back to the original rather than
 * stalling the transport; with neither side playable the verse is skipped.
 */
function progEffectiveClock(slot: ProgrammeSlot): "source" | "target" | null {
  if (slot.clock === "target" && !progTargetEntry()) return slot.sourceWindow ? "source" : null
  return slot.clock
}

function progStateCell(): { cellIndex: number; cellId: string } {
  const slot = progCurrentSlot()
  const cells = activeContext?.cells ?? []
  const idx = slot ? cells.findIndex((c) => c.id === slot.cellId) : -1
  return { cellIndex: idx, cellId: slot?.cellId ?? "" }
}

/** Rebuild the layout from the live cells. Cheap and pure — nothing is stored,
 *  so a trim or a new take just re-flows on the next call. */
function progRebuild(): void {
  const ctx = activeContext
  if (!ctx || timingMode !== "audioFirst") {
    programme = null
    return
  }
  // Must match the timeline's own ordering exactly, or the transport and the
  // drawing would disagree about where a verse is: same filter, same sort.
  const dialogue = sortByLens(
    ctx.cells.filter((c) => (c.medium ?? "text") === "media" && hasTiming(c)),
    "time",
  )
  programme = buildProgramme(dialogue)
  setProgress({ duration: programme.totalSec })
}

/** The next verse with anything to play, from `from` onward. -1 when done. */
function progNextPlayable(from: number): number {
  const slots = programme?.slots ?? []
  for (let i = Math.max(0, from); i < slots.length; i++) {
    if (slots[i].sourceWindow || slots[i].targetWindow) return i
  }
  return -1
}

function progPrevPlayable(from: number): number {
  const slots = programme?.slots ?? []
  for (let i = Math.min(from, slots.length - 1); i >= 0; i--) {
    if (slots[i].sourceWindow || slots[i].targetWindow) return i
  }
  return -1
}

function progFinish(): void {
  progQuiet(currentAudio)
  disposeAllOverlays()
  progIndex = -1
  setState(IDLE)
}

/** The clocking side reached the end of its verse — on to the next. */
function progAdvance(): void {
  const next = progNextPlayable(progIndex + 1)
  if (next < 0) {
    progFinish()
    return
  }
  void progPlaySlot(next, null, true)
}

/** A dub stopped — at its trim end, its natural end, or because it failed. */
function progOnTargetFinished(entry: OverlayEntry): void {
  if (timingMode !== "audioFirst") return
  const slot = progCurrentSlot()
  // Only the side that was MEANT to clock this verse ends it. A dub that runs
  // out early just goes quiet while the original finishes.
  if (!slot || slot.cellId !== entry.cellId || slot.clock !== "target") return
  progAdvance()
}

/** Keep the programme clock in step with a dub that is clocking its verse. */
function progTargetTick(entry: OverlayEntry, audio: HTMLAudioElement): void {
  const slot = progCurrentSlot()
  if (!slot || slot.cellId !== entry.cellId) return
  if (slot.clock !== "target" || !slot.targetWindow) return
  setProgress({ currentTime: slot.startSec + (audio.currentTime - slot.targetWindow.start) })
}

/** Open (or re-position) the imported clip for this verse's original. */
async function progOpenSource(
  cell: CellData,
  atClipSec: number,
  autoplay: boolean,
): Promise<void> {
  const ctx = activeContext
  if (!ctx) return
  const src = sourceClipAudioForCell(cell) ?? pickPlayableAudio(cell)
  if (!src) {
    progQuiet(currentAudio)
    return
  }
  // Every verse is a window into the SAME imported file, so after the first
  // one this is just a seek — no element churn at a verse boundary.
  if (currentAudio && currentAttachmentUrl === src.url) {
    const el = currentAudio
    el.currentTime = atClipSec
    if (autoplay && el.paused) {
      try { await el.play() } catch { /* user-driven, ignore */ }
    } else if (!autoplay && !el.paused) {
      progQuiet(el)
    }
    return
  }

  disposeCurrentSourceOnly()
  const seq = ++currentSeq
  let resolved: ResolvedAudioSrc
  try {
    resolved = await resolveAudioSrc(src.url, ctx.projectId, cell.fileId, ctx.session)
  } catch (e) {
    if (seq !== currentSeq) return
    setState({ kind: "error", message: e instanceof Error ? e.message : String(e), cellId: cell.id })
    return
  }
  if (seq !== currentSeq) {
    if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl)
    return
  }

  const audio = new Audio(resolved.src)
  currentAudio = audio
  currentUrl = resolved.objectUrl
  currentAttachmentUrl = src.url
  audio.playbackRate = progress.rate
  audio.volume = progress.volume
  audio.muted = !audibility.source
  pendingStartSeconds = atClipSec

  audio.onloadedmetadata = () => {
    if (seq !== currentSeq) return
    const target = pendingStartSeconds
    pendingStartSeconds = null
    if (target == null) return
    const d = audio.duration
    audio.currentTime = Number.isFinite(d) ? Math.max(0, Math.min(target, d)) : target
  }
  audio.ontimeupdate = () => {
    if (seq !== currentSeq) return
    const slot = progCurrentSlot()
    if (!slot?.sourceWindow) return
    // ~250ms of tick slop, the same tolerance the dubbing path lives with.
    if (audio.currentTime >= slot.sourceWindow.end) {
      if (progEffectiveClock(slot) === "source") progAdvance()
      else {
        // Going quiet for the rest of the verse. Stamp the clock at exactly
        // that moment so it can't sit stale until the dub's next tick.
        setProgress({ currentTime: slot.startSec + slot.sourceLenSec })
        progQuiet(audio)
      }
      return
    }
    if (progEffectiveClock(slot) === "source") {
      setProgress({ currentTime: slot.startSec + (audio.currentTime - slot.sourceWindow.start) })
    }
  }
  audio.onplay = () => {
    if (seq !== currentSeq) return
    setActiveAudio(coordinatorController)
    for (const e of overlayPool) if (e.element) void e.element.play().catch(() => { /* user-driven */ })
    setState({ kind: "playing", ...progStateCell() })
  }
  audio.onpause = () => {
    if (seq !== currentSeq) return
    if (progSuppressPause > 0) {
      progSuppressPause--
      return
    }
    if (audio.ended) return
    for (const e of overlayPool) e.element?.pause()
    setState({ kind: "paused", ...progStateCell() })
  }
  audio.onended = () => {
    if (seq !== currentSeq) return
    const slot = progCurrentSlot()
    if (slot && progEffectiveClock(slot) === "source") progAdvance()
  }
  audio.onerror = () => {
    if (seq !== currentSeq) return
    // The original can't be loaded — let the dub carry the verse if it can.
    const slot = progCurrentSlot()
    if (slot && !progTargetEntry()) progAdvance()
  }
  if (autoplay) {
    try { await audio.play() } catch { /* user-driven, ignore */ }
  }
}

/** Tear down just the source element — the dub pool belongs to the verse. */
function disposeCurrentSourceOnly(): void {
  if (currentAudio) {
    currentAudio.onended = null
    currentAudio.onerror = null
    currentAudio.ontimeupdate = null
    currentAudio.onloadedmetadata = null
    currentAudio.onplay = null
    currentAudio.onpause = null
    currentAudio.pause()
    currentAudio.src = ""
    currentAudio = null
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
  currentAttachmentUrl = null
  pendingStartSeconds = null
}

/**
 * Play a verse from `atProgrammeSec` (its start when null). Both sides begin
 * together at the same point in the verse; a side whose audio has already run
 * out by then simply doesn't sound.
 */
async function progPlaySlot(
  index: number,
  atProgrammeSec: number | null,
  autoplay: boolean,
): Promise<void> {
  const ctx = activeContext
  const prog = programme
  if (!ctx || !prog) return
  const slot = prog.slots[index]
  if (!slot) {
    progFinish()
    return
  }
  const cell = ctx.cells.find((c) => c.id === slot.cellId)
  if (!cell) {
    progFinish()
    return
  }

  progIndex = index
  const at = Math.max(
    slot.startSec,
    Math.min(atProgrammeSec ?? slot.startSec, slot.startSec + slot.slotLenSec - 0.001),
  )
  const into = at - slot.startSec

  // The dub side rides the overlay pool, so the speaker buttons, rate and
  // volume keep applying to it exactly as they do in dubbing mode.
  disposeAllOverlays()
  pendingDub = null
  const target = slot.targetWindow ? activeTargetForCell(cell) : null
  if (slot.targetWindow && target && into < slot.targetLenSec) {
    applyTargetOverlay({
      kind: "fire",
      cellId: slot.cellId,
      audioId: target.audioId,
      url: target.url,
      startAtClipSec: slot.targetWindow.start + into,
      stopAtClipSec: slot.targetWindow.end,
      exclusive: true,
    })
  }

  setProgress({ currentTime: at, duration: prog.totalSec })
  setState({ kind: autoplay ? "playing" : "paused", ...progStateCell() })
  ctx.onCellChange?.(progStateCell().cellIndex, slot.cellId)

  if (slot.sourceWindow && into < slot.sourceLenSec) {
    await progOpenSource(cell, slot.sourceWindow.start + into, autoplay)
  } else {
    progQuiet(currentAudio)
  }

  // Nothing in this verse can end it (both sides already spent, or neither
  // loadable) — don't sit here in silence.
  if (autoplay && progIndex === index && progEffectiveClock(slot) == null) progAdvance()
}

/** Seek on the PROGRAMME clock. Re-opens the landing verse from that point. */
function progSeekTo(sec: number, wantPlay: boolean): void {
  const prog = programme
  if (!prog) return
  const at = Math.max(0, sec)
  const slot = slotAtProgrammeSec(prog, at)
  if (!slot) {
    // Past the end — land on the last verse's final moment rather than nowhere.
    const last = progPrevPlayable(prog.slots.length - 1)
    if (last < 0) return
    void progPlaySlot(last, prog.slots[last].startSec, wantPlay)
    return
  }
  void progPlaySlot(prog.slots.indexOf(slot), at, wantPlay)
}

/**
 * SUB-53: tell the queue which job this project is for. Called from the
 * workspace whenever the project's mode resolves or changes. A flip changes
 * what every position MEANS — file seconds vs programme seconds — so the
 * transport stops rather than carry a stale clock across.
 */
export function setQueueTimingMode(mode: AudioTimingMode): void {
  if (timingMode === mode) return
  timingMode = mode
  stopQueue()
}

export function getQueueTimingMode(): AudioTimingMode {
  return timingMode
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface PlayContext {
  cells: CellData[]
  projectId: string
  session: FrontierSession
  /** Called when a cell starts playing — useful for scrolling into view. */
  onCellChange?: (cellIndex: number, cellId: string) => void
}

let activeContext: PlayContext | null = null

/** Returns the next cell index (>= startIndex) that has playable audio. */
function findNextPlayable(cells: CellData[], startIndex: number): number {
  for (let i = startIndex; i < cells.length; i++) {
    if (masterAudioForCell(cells[i])) return i
  }
  return -1
}

function findPrevPlayable(cells: CellData[], startIndex: number): number {
  for (let i = startIndex; i >= 0; i--) {
    if (masterAudioForCell(cells[i])) return i
  }
  return -1
}

/**
 * The [start, end) window (seconds, on the CLIP's clock) the queue must play
 * for a cell, or null to play the whole attachment.
 *
 * Media segments (`medium: "media"`) share one imported clip across N cells,
 * each windowed by startTime/endTime — ignoring the window plays the full file
 * once per cell. Text cells' startTime/endTime are subtitle timings on the
 * video timeline, NOT offsets into their own recording, so they get no window.
 */
export function trimWindowForCell(cell: CellData): { start: number; end: number } | null {
  if (cell.medium !== "media") return null
  // SUB-29/round 5: the window addresses the SHARED IMPORTED CLIP. A take
  // (cellId-seeded audioId) is its own short clip whose clock has nothing to
  // do with the file timeline — but since the master element now plays the
  // source clip even when a take is selected, the window only steps aside for
  // take-ONLY sections (no source clip attachment left to window).
  if (
    cell.selectedAudioId &&
    audioIdSeededWith(cell.selectedAudioId, cell.id) &&
    !sourceClipAudioForCell(cell)
  ) return null
  const { startTime, endTime } = cell
  if (typeof startTime !== "number" || typeof endTime !== "number") return null
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
  if (endTime <= startTime) return null
  return { start: startTime, end: endTime }
}

// ── AQU-646: pure planners (exported for tests) ─────────────────────────────

/** Seamless-advance rewind tolerance: a next window starting slightly before
 *  the current position plays straight on; a genuinely overlapping
 *  diarization turn rewinds to its start. Must exceed the ~250ms timeupdate
 *  tick, or plain overshoot at a boundary would stutter-rewind. */
const REWIND_EPSILON_SEC = 0.35

export type SeekPlan =
  | { kind: "none" }
  | { kind: "element"; index: number; seconds: number }
  | { kind: "seamless"; index: number; seconds: number }
  | { kind: "open"; index: number; seconds: number }

export type AdvancePlan =
  | { kind: "stop" }
  | { kind: "seamless"; index: number; seekTo?: number }
  | { kind: "open"; index: number }

/**
 * Index of the media cell owning file-time `seconds`: the first playable media
 * cell whose window END is past it — [start, end), so a shared tiled boundary
 * belongs to the LATER cell, and on legacy gap-y files a gap resolves to the
 * FOLLOWING cell. -1 when past the last window (or no windowed cells).
 */
export function findCellAtTime(cells: CellData[], seconds: number): number {
  for (let i = 0; i < cells.length; i++) {
    if (!masterAudioForCell(cells[i])) continue
    const w = trimWindowForCell(cells[i])
    if (!w) continue
    if (seconds < w.end) return i
  }
  return -1
}

/** How to reach file-time `seconds` from the current cell/clip. */
export function planSeek(
  cells: CellData[],
  currentIdx: number,
  attachmentUrl: string | null,
  seconds: number,
): SeekPlan {
  const target = findCellAtTime(cells, seconds)
  if (target < 0) {
    // No media window owns this time — a non-media current take can still
    // seek its own element (today's seekQueue semantics).
    const cur = cells[currentIdx]
    if (cur && masterAudioForCell(cur) && !trimWindowForCell(cur)) {
      return { kind: "element", index: currentIdx, seconds }
    }
    return { kind: "none" }
  }
  if (target === currentIdx) return { kind: "element", index: target, seconds }
  const targetUrl = masterAudioForCell(cells[target])?.url
  const sameClip = attachmentUrl != null && targetUrl === attachmentUrl
  return sameClip
    ? { kind: "seamless", index: target, seconds }
    : { kind: "open", index: target, seconds }
}

/**
 * What to do when the current cell's window ends (or the clip ends). Same
 * shared clip → adopt the next cell in place and keep playing (skipping any
 * windows the ~250ms timeupdate overshoot already passed); different clip →
 * open it; nothing left → stop. On legacy gap-y files the next window starts
 * ahead of the current position — no seek is planned, so the gap audio simply
 * plays through (the data-migration-free fix for pre-tiling imports).
 */
export function planAdvance(
  cells: CellData[],
  currentIdx: number,
  attachmentUrl: string | null,
  currentTimeSeconds: number,
): AdvancePlan {
  let next = findNextPlayable(cells, currentIdx + 1)
  while (next >= 0) {
    const url = masterAudioForCell(cells[next])?.url
    const w = trimWindowForCell(cells[next])
    const sameClip = attachmentUrl != null && url === attachmentUrl
    if (!sameClip || !w) return { kind: "open", index: next }
    if (w.end > currentTimeSeconds) {
      return w.start < currentTimeSeconds - REWIND_EPSILON_SEC
        ? { kind: "seamless", index: next, seekTo: w.start }
        : { kind: "seamless", index: next }
    }
    next = findNextPlayable(cells, next + 1)
  }
  return { kind: "stop" }
}

// ── Target overlay planner + executor (round 5) ─────────────────────────────

export type TargetOverlayPlan =
  | { kind: "keep" }
  | { kind: "silence" }
  | {
      kind: "fire"
      cellId: string
      audioId: string
      url: string
      /** Where to join the CLIP (its own clock): trimStart + progress-into-dub. */
      startAtClipSec: number
      /** Trim end on the clip's clock; null = play to natural end. */
      stopAtClipSec: number | null
      /** Seek semantics: clear the pool first (an earlier section's
       *  overhanging tail does NOT resurrect on seek — documented rule). */
      exclusive: boolean
    }
  | { kind: "arm"; cellId: string; dueSec: number; overlay: "keep" | "silence" }

/**
 * What the dub overlay pool should do when the master clock is at `masterSec`
 * on `index`. ADVANCE is additive — an overhanging previous dub keeps ringing
 * while (round 7: "both sound") a newly-due one fires on top. SEEK is
 * exclusive — only the landing section's dub sounds, joined mid-clip. A dub
 * whose audible start (anchor + trimStart) is still AHEAD returns "arm" (the
 * tick fires it on crossing); one fully in the past stays silent. The
 * `sounding` membership guard covers both the in-flight and playing states;
 * take-only sections never fire (the MASTER plays the take itself).
 */
export function planTargetOverlay(
  cells: CellData[],
  index: number,
  sounding: ReadonlySet<string>,
  reason: "advance" | "seek",
  masterSec: number,
): TargetOverlayPlan {
  const cell = cells[index]
  const target = cell ? activeTargetForCell(cell) : null
  if (!cell || !target || !sourceClipAudioForCell(cell)) {
    return reason === "seek" ? { kind: "silence" } : { kind: "keep" }
  }
  if (reason === "advance" && sounding.has(cell.id)) return { kind: "keep" }
  const att = cell.attachments?.[target.audioId]
  const geom = targetChipGeom(cell, att)
  const dueSec = geom?.start ?? cell.startTime ?? 0
  if (masterSec < dueSec) {
    return { kind: "arm", cellId: cell.id, dueSec, overlay: reason === "seek" ? "silence" : "keep" }
  }
  const intoDubSec = masterSec - dueSec
  const effMs = effectiveAttachmentDurationMs(att)
  if (effMs != null && intoDubSec >= effMs / 1000) {
    // The dub's audible extent already passed — nothing (new) to sound.
    return reason === "seek" ? { kind: "silence" } : { kind: "keep" }
  }
  const trimStartSec = geom?.trimStartSec ?? 0
  return {
    kind: "fire",
    cellId: cell.id,
    audioId: target.audioId,
    url: target.url,
    startAtClipSec: trimStartSec + intoDubSec,
    stopAtClipSec: geom?.trimEndSec ?? null,
    exclusive: reason === "seek",
  }
}

/** Execute an overlay plan. Overlay failures are non-fatal — a dub that can't
 *  load just doesn't sound; the master keeps the clock. Every applied plan
 *  overwrites `pendingDub` (the arm invariant). */
function applyTargetOverlay(plan: TargetOverlayPlan): void {
  if (plan.kind === "keep") {
    pendingDub = null
    return
  }
  if (plan.kind === "silence") {
    pendingDub = null
    disposeAllOverlays()
    return
  }
  if (plan.kind === "arm") {
    // The dub's start is ahead of the clock — the tick fires it. An armed
    // "keep" lets an overhanging previous dub ring until this one is due.
    pendingDub = { cellId: plan.cellId, dueSec: plan.dueSec }
    if (plan.overlay === "silence") disposeAllOverlays()
    return
  }
  pendingDub = null
  const ctx = activeContext
  if (!ctx) return
  const cell = ctx.cells.find((c) => c.id === plan.cellId)
  if (!cell) return
  // Seek semantics: only the landing section's dub sounds.
  if (plan.exclusive) disposeAllOverlays()
  // Re-firing a cell replaces its own entry — never an echo.
  const prior = overlayPool.find((e) => e.cellId === plan.cellId)
  if (prior) removeOverlayEntry(prior)
  // Bounded pool: evict the OLDEST ringing dub at the cap.
  while (overlayPool.length >= MAX_OVERLAYS) removeOverlayEntry(overlayPool[0])
  const entry: OverlayEntry = {
    cellId: plan.cellId,
    audioId: plan.audioId,
    element: null,
    url: null,
    stopAtClipSec: plan.stopAtClipSec,
  }
  overlayPool.push(entry)
  const startAtClipSec = plan.startAtClipSec
  void (async () => {
    let resolved: ResolvedAudioSrc
    try {
      resolved = await resolveAudioSrc(plan.url, ctx.projectId, cell.fileId, ctx.session)
    } catch {
      removeOverlayEntry(entry)
      // SUB-53: in audio-first this dub may have been the one clocking its
      // verse — hand the job on rather than stall the whole programme.
      progOnTargetFinished(entry)
      return
    }
    if (!overlayPool.includes(entry)) {
      // Evicted/replaced/cleared while resolving.
      if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl)
      return
    }
    const audio = new Audio(resolved.src)
    entry.element = audio
    entry.url = resolved.objectUrl
    audio.playbackRate = progress.rate
    audio.volume = progress.volume
    audio.muted = !audibility.target
    if (startAtClipSec > 0.05) {
      // Join the clip at the offset (trim head and/or mid-dub seek). Safari
      // rejects pre-metadata seeks (same trick as the master's
      // pendingStartSeconds).
      audio.onloadedmetadata = () => {
        if (!overlayPool.includes(entry)) return
        const d = audio.duration
        audio.currentTime = Number.isFinite(d) ? Math.max(0, Math.min(startAtClipSec, d)) : startAtClipSec
      }
    }
    audio.onended = () => {
      removeOverlayEntry(entry)
      progOnTargetFinished(entry)
    }
    audio.onerror = () => {
      removeOverlayEntry(entry)
      progOnTargetFinished(entry)
    }
    if (entry.stopAtClipSec != null) {
      // Pool entries own their trim end-stop (~250ms timeupdate slop; pause
      // immediately at the threshold to bound it).
      audio.ontimeupdate = () => {
        // SUB-53: when this dub is the longer side of its verse it also drives
        // the programme clock (audio-first only; a no-op in dubbing mode).
        progTargetTick(entry, audio)
        if (entry.stopAtClipSec != null && audio.currentTime >= entry.stopAtClipSec) {
          removeOverlayEntry(entry)
          progOnTargetFinished(entry)
        }
      }
    }
    // SUB-53: in audio-first a verse can be dub-only, so the source element
    // may legitimately be paused (or absent) while the programme plays.
    if (progRunning() || (currentAudio && !currentAudio.paused)) {
      void audio.play().catch(() => { /* user-driven, ignore */ })
    }
  })()
}

/** Make `index` the current cell WITHOUT touching the audio element's source —
 *  the seamless-advance/seek primitive for cells sharing one clip.
 *  `overlayAtSec`: where the master clock WILL be — callers that adopt before
 *  their element seek lands must pass the intended seconds, or the overlay
 *  plans off a stale position. */
function adoptCell(
  index: number,
  seekTo: number | undefined,
  overlayReason: "advance" | "seek",
  overlayAtSec?: number,
): void {
  const ctx = activeContext
  const audio = currentAudio
  if (!ctx || !audio) return
  const cell = ctx.cells[index]
  if (!cell) return
  currentIndex = index
  currentTrim = trimWindowForCell(cell)
  setState({ kind: audio.paused ? "paused" : "playing", cellIndex: index, cellId: cell.id })
  ctx.onCellChange?.(index, cell.id)
  if (seekTo != null) {
    audio.currentTime = seekTo
    setProgress({ currentTime: seekTo })
  }
  applyTargetOverlay(
    planTargetOverlay(ctx.cells, index, soundingCellIds(), overlayReason, overlayAtSec ?? seekTo ?? audio.currentTime),
  )
}

async function playAt(index: number, opts: { atSeconds?: number; autoplay?: boolean } = {}): Promise<void> {
  const ctx = activeContext
  if (!ctx) return
  const cell = ctx.cells[index]
  if (!cell) {
    setState(IDLE)
    disposeCurrent()
    return
  }
  const playable = masterAudioForCell(cell)
  if (!playable) {
    // Hop to next cell that has audio.
    const next = findNextPlayable(ctx.cells, index + 1)
    if (next < 0) {
      setState(IDLE)
      disposeCurrent()
      return
    }
    return playAt(next, { autoplay: opts.autoplay })
  }

  const autoplay = opts.autoplay ?? true

  // AQU-646 seamless fast path: the target cell shares the clip the element
  // already has open (imported media file) — adopt it in place instead of
  // disposing + recreating. No boundary hiccup; cross-cell scrubs are instant.
  if (currentAudio && currentAttachmentUrl === playable.url) {
    // The element seek happens AFTER adoption — hand the overlay the intended
    // position so it doesn't plan off the pre-seek clock.
    adoptCell(index, undefined, "seek", opts.atSeconds ?? trimWindowForCell(cell)?.start)
    const at = opts.atSeconds ?? currentTrim?.start
    if (at != null && currentAudio) {
      currentAudio.currentTime = at
      setProgress({ currentTime: at })
    }
    if (autoplay && currentAudio.paused) {
      try { await currentAudio.play() } catch { /* user-driven, ignore */ }
    } else if (!autoplay && !currentAudio.paused) {
      currentAudio.pause()
    }
    return
  }

  disposeCurrent()
  const seq = ++currentSeq
  setState({ kind: "loading", cellIndex: index, cellId: cell.id })
  ctx.onCellChange?.(index, cell.id)

  let resolved: ResolvedAudioSrc
  try {
    resolved = await resolveAudioSrc(playable.url, ctx.projectId, cell.fileId, ctx.session)
  } catch (e) {
    if (seq !== currentSeq) return // superseded
    setState({ kind: "error", message: e instanceof Error ? e.message : String(e), cellId: cell.id })
    return
  }
  if (seq !== currentSeq) {
    if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl)
    return
  }

  const audio = new Audio(resolved.src)
  currentAudio = audio
  currentUrl = resolved.objectUrl
  currentAttachmentUrl = playable.url
  currentIndex = index
  currentTrim = trimWindowForCell(cell)
  pendingStartSeconds = opts.atSeconds ?? null
  audio.playbackRate = progress.rate
  audio.volume = progress.volume
  audio.muted = !audibility.source
  setProgress({ currentTime: pendingStartSeconds ?? currentTrim?.start ?? 0, duration: 0 })

  // Handlers read the MUTABLE module state (currentIndex/currentTrim) — with
  // seamless adoption the element outlives the cell it was opened for, so a
  // closure over `index`/`trim` would go stale.
  const stateCell = (): { cellIndex: number; cellId: string } => {
    const c = activeContext?.cells[currentIndex]
    return { cellIndex: currentIndex, cellId: c?.id ?? cell.id }
  }
  const applyAdvance = (plan: AdvancePlan): void => {
    if (plan.kind === "seamless") {
      // Same clip: audio keeps playing straight through the boundary — just
      // make the next cell current (and rewind only for a real overlap).
      adoptCell(plan.index, plan.seekTo, "advance")
      return
    }
    audio.onpause = null // don't let the pause handler flash a "paused" state
    audio.pause()
    if (plan.kind === "stop") {
      setState(IDLE)
      disposeCurrent()
      return
    }
    void playAt(plan.index)
  }

  audio.onloadedmetadata = () => {
    if (seq !== currentSeq) return
    const target = pendingStartSeconds ?? currentTrim?.start
    pendingStartSeconds = null
    if (target != null) {
      const d = audio.duration
      audio.currentTime = Number.isFinite(d) ? Math.max(0, Math.min(target, d)) : target
    }
  }
  audio.ontimeupdate = () => {
    if (seq !== currentSeq) return
    // Round 6: an ARMED dub fires the moment the clock crosses its start.
    // Checked BEFORE the window-end advance — a due within one ~250ms tick of
    // the section end would otherwise be dropped by the advance's replan.
    if (pendingDub && audio.currentTime >= pendingDub.dueSec) {
      applyTargetOverlay(
        planTargetOverlay(activeContext?.cells ?? [], currentIndex, soundingCellIds(), "advance", audio.currentTime),
      )
    }
    // A media segment's window ends before the shared clip does — treat
    // reaching the window end as this cell's "ended" and advance.
    if (currentTrim && audio.currentTime >= currentTrim.end) {
      applyAdvance(planAdvance(activeContext?.cells ?? [], currentIndex, currentAttachmentUrl, audio.currentTime))
      return
    }
    setProgress({ currentTime: audio.currentTime })
  }
  audio.ondurationchange = () => {
    if (seq !== currentSeq) return
    if (Number.isFinite(audio.duration)) setProgress({ duration: audio.duration })
  }

  audio.onplay = () => {
    if (seq !== currentSeq) return
    setActiveAudio(coordinatorController)
    // The dub overlays ride the master's transport (rounds 5-7).
    for (const e of overlayPool) {
      if (e.element) void e.element.play().catch(() => { /* user-driven, ignore */ })
    }
    setState({ kind: "playing", ...stateCell() })
  }
  audio.onpause = () => {
    if (seq !== currentSeq) return
    for (const e of overlayPool) e.element?.pause()
    if (audio.ended) return
    setState({ kind: "paused", ...stateCell() })
  }
  audio.onended = () => {
    if (seq !== currentSeq) return
    const at = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY
    applyAdvance(planAdvance(activeContext?.cells ?? [], currentIndex, currentAttachmentUrl, at))
  }
  let triedBlobFallback = false
  audio.onerror = () => {
    if (seq !== currentSeq) return
    // Streamed src failed (expired token, transient network) — retry once by
    // downloading the full bytes and swapping the element's src in place so
    // the wired handlers (onended advance, progress) carry over.
    if (resolved.streaming && resolved.frontier && !triedBlobFallback) {
      triedBlobFallback = true
      void (async () => {
        try {
          const url = await fetchFullBlobUrl(resolved.frontier!, ctx.projectId, cell.fileId, ctx.session)
          if (seq !== currentSeq) {
            URL.revokeObjectURL(url)
            return
          }
          currentUrl = url
          audio.src = url
          await audio.play()
          // Round 6: the src swap reset the element's position — re-derive
          // the dub/arm state for wherever the clock actually is now.
          applyTargetOverlay(
            planTargetOverlay(activeContext?.cells ?? [], currentIndex, soundingCellIds(), "seek", audio.currentTime),
          )
        } catch (e) {
          if (seq !== currentSeq) return
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e), cellId: cell.id })
        }
      })()
      return
    }
    setState({ kind: "error", message: "Audio failed to load", cellId: cell.id })
  }

  // Fresh element = everything reset (disposeCurrent killed any overlay) —
  // fire or arm this cell's dub. Cued-not-playing elements just cue it too
  // (the executor only starts it when the master is playing).
  applyTargetOverlay(
    planTargetOverlay(ctx.cells, index, soundingCellIds(), "seek", opts.atSeconds ?? currentTrim?.start ?? 0),
  )

  if (!autoplay) {
    // AQU-646 cue-without-play: element loaded + positioned, transport shows
    // paused at the cue point; play/resumeQueue starts exactly there. The
    // coordinator is only claimed onplay, so a cue never steals active audio.
    setState({ kind: "paused", cellIndex: index, cellId: cell.id })
    return
  }
  try {
    await audio.play()
  } catch (e) {
    if (seq !== currentSeq) return
    setState({ kind: "error", message: e instanceof Error ? e.message : String(e), cellId: cell.id })
  }
}

/** Start playback at a specific cell index (or skip forward to the next
 *  cell with audio if the start index has none). */
export function startQueue(ctx: PlayContext, fromIndex: number): void {
  activeContext = ctx
  if (timingMode === "audioFirst") {
    progRebuild()
    const cellId = ctx.cells[Math.max(0, fromIndex)]?.id
    const from = cellId ? (programme?.slots.findIndex((s) => s.cellId === cellId) ?? -1) : 0
    const start = progNextPlayable(from < 0 ? 0 : from)
    if (start < 0) {
      setState(IDLE)
      disposeCurrent()
      return
    }
    void progPlaySlot(start, null, true)
    return
  }
  const start = findNextPlayable(ctx.cells, Math.max(0, fromIndex))
  if (start < 0) {
    setState(IDLE)
    disposeCurrent()
    return
  }
  void playAt(start)
}

/**
 * AQU-646: seek in FILE-TIMELINE seconds (== clip seconds for imported media
 * files). Locates the cell owning the target time, adopts/opens it, and
 * positions playback exactly there — the transport scrubber, ruler, and
 * click-a-section all route through this. `play`: true = ensure playing,
 * false = cue paused, undefined = preserve the current playing/paused state.
 * No-op when the queue is idle — use startQueueAtTime from idle.
 */
export function seekQueueToTime(seconds: number, opts: { play?: boolean } = {}): void {
  const ctx = activeContext
  if (!ctx) return
  if (state.kind === "idle" || state.kind === "error") return
  if (timingMode === "audioFirst") {
    // SUB-53: `seconds` is a PROGRAMME second here — the ruler, the playhead
    // and the transport all speak that clock in audio-first.
    progSeekTo(seconds, opts.play ?? (state.kind === "playing" || state.kind === "loading"))
    return
  }
  const idx = state.cellIndex
  const wantPlay = opts.play ?? (state.kind === "playing" || state.kind === "loading")
  const plan = planSeek(ctx.cells, idx, currentAttachmentUrl, Math.max(0, seconds))
  if (plan.kind === "none") return
  if (!currentAudio) {
    // Still loading — reopen at the target instead of racing the resolve.
    void playAt(plan.index, { atSeconds: plan.seconds, autoplay: wantPlay })
    return
  }
  if (plan.kind === "element") {
    seekQueue(plan.seconds)
    // Same cell, new position — re-derive the dub for it (join mid-clip,
    // re-arm ahead of it, or cut).
    applyTargetOverlay(planTargetOverlay(ctx.cells, plan.index, soundingCellIds(), "seek", plan.seconds))
    syncPlayState(wantPlay)
    return
  }
  if (plan.kind === "seamless") {
    // Adoption precedes the element seek — pass the intended seconds.
    adoptCell(plan.index, undefined, "seek", plan.seconds)
    seekQueue(plan.seconds)
    syncPlayState(wantPlay)
    return
  }
  void playAt(plan.index, { atSeconds: plan.seconds, autoplay: wantPlay })
}

function syncPlayState(wantPlay: boolean): void {
  const audio = currentAudio
  if (!audio) return
  if (wantPlay && audio.paused) void audio.play().catch(() => { /* user-driven */ })
  else if (!wantPlay && !audio.paused) audio.pause()
}

/** AQU-646: start (or cue, with play:false) the queue at a file-timeline
 *  position — clicking a section / the ruler while the queue is idle. Falls
 *  back to the first playable cell when no window owns the time. */
export function startQueueAtTime(ctx: PlayContext, seconds: number, opts: { play?: boolean } = {}): void {
  activeContext = ctx
  if (timingMode === "audioFirst") {
    progRebuild()
    progSeekTo(seconds, opts.play ?? true)
    return
  }
  const at = Math.max(0, seconds)
  const target = findCellAtTime(ctx.cells, at)
  if (target < 0) {
    const start = findNextPlayable(ctx.cells, 0)
    if (start < 0) {
      setState(IDLE)
      disposeCurrent()
      return
    }
    void playAt(start, { autoplay: opts.play ?? true })
    return
  }
  void playAt(target, { atSeconds: at, autoplay: opts.play ?? true })
}

export function pauseQueue(): void {
  if (timingMode === "audioFirst") {
    // The source may already be quiet (its part of the verse is over) while
    // the dub carries on — pause BOTH, then say so once.
    progQuiet(currentAudio)
    for (const e of overlayPool) e.element?.pause()
    if (progIndex >= 0) setState({ kind: "paused", ...progStateCell() })
    return
  }
  currentAudio?.pause()
}

export async function resumeQueue(): Promise<void> {
  if (timingMode === "audioFirst") {
    const slot = progCurrentSlot()
    if (!slot) return
    // Only the sides that still have audio left in this verse come back. Ask
    // the ELEMENTS, not the clock — an element's own position is the truth,
    // and a dub that has finished is already out of the pool.
    if (currentAudio && slot.sourceWindow && currentAudio.currentTime < slot.sourceWindow.end) {
      try { await currentAudio.play() } catch { /* user-driven, ignore */ }
    }
    for (const e of overlayPool) {
      if (e.element) void e.element.play().catch(() => { /* user-driven */ })
    }
    setState({ kind: "playing", ...progStateCell() })
    return
  }
  if (!currentAudio) return
  try { await currentAudio.play() } catch { /* user-driven, ignore */ }
}

export function stopQueue(): void {
  disposeCurrent()
  programme = null
  progIndex = -1
  progSuppressPause = 0
  setState(IDLE)
  activeContext = null
}

export function skipForward(): void {
  if (!activeContext) return
  if (timingMode === "audioFirst") {
    const next = progNextPlayable(progIndex + 1)
    if (next < 0) {
      stopQueue()
      return
    }
    void progPlaySlot(next, null, true)
    return
  }
  const cur = state.kind === "playing" || state.kind === "paused" || state.kind === "loading"
    ? state.cellIndex
    : -1
  const next = findNextPlayable(activeContext.cells, cur + 1)
  if (next < 0) {
    stopQueue()
    return
  }
  void playAt(next)
}

export function skipBack(): void {
  if (!activeContext) return
  if (timingMode === "audioFirst") {
    const prev = progPrevPlayable(progIndex - 1)
    if (prev < 0) return
    void progPlaySlot(prev, null, true)
    return
  }
  const cur = state.kind === "playing" || state.kind === "paused" || state.kind === "loading"
    ? state.cellIndex
    : -1
  const prev = findPrevPlayable(activeContext.cells, cur - 1)
  if (prev < 0) return
  void playAt(prev)
}

/** Refresh the queue's snapshot of cells without restarting playback.
 *  Useful when the user generates voice mid-playback and we want the queue
 *  to reflect the new attachments on the next advance. */
export function updateQueueCells(cells: CellData[]): void {
  if (activeContext) activeContext.cells = cells
  if (timingMode === "audioFirst") {
    // SUB-53: a new take or a trim re-flows the layout. Rebuild and keep the
    // transport on the SAME verse — its slot may well have moved.
    const onCellId = programme?.slots[progIndex]?.cellId ?? null
    progRebuild()
    if (onCellId) {
      const i = programme?.slots.findIndex((s) => s.cellId === onCellId) ?? -1
      if (i >= 0) progIndex = i
    }
    return
  }
  // Round 6/7: an armed dub's due time is a snapshot — refresh it (trim-aware)
  // if the chip was dragged or trimmed while we were waiting on it.
  if (pendingDub) {
    const cellId = pendingDub.cellId
    const cell = cells.find((c) => c.id === cellId)
    const target = cell ? activeTargetForCell(cell) : null
    const due = cell ? targetDueSec(cell, target ? cell.attachments?.[target.audioId] : undefined) : null
    if (due != null) pendingDub = { cellId, dueSec: due }
  }
}

/** Whether any cell in the list has playable audio. Drives the bar's
 *  Play button enablement. */
export function hasAnyPlayableAudio(cells: CellData[]): boolean {
  return cells.some((c) => pickPlayableAudio(c) !== undefined)
}
