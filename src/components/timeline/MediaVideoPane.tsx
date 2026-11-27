// The linked video, docked beside the text table in the media lens. (AQU-646)
//
// Until now the video was a black band above the timeline with native browser
// controls: it played picture without sound, nothing in the transport ever
// started or stopped it, its own soundtrack talked over the dub, and both it and
// the play queue wrote the timeline clock at ~4Hz with last-writer-wins. This is
// the other arrangement — the queue is the master clock and the video is a
// muted, controls-free picture surface slaved to it. Position logic lives in
// ./video-sync as a pure function; see the long note there for why it never
// reads the element.
//
// ONE exception, and it is not a special case so much as the original job: a
// subtitle file can have a linked video and no audio attachments at all, and
// then the queue can never start. There the video IS the player — it keeps its
// sound and reports its own time back up to drive the playhead. The clock
// therefore has two possible drivers; which one is in charge is decided once,
// by whether this file has any playable audio.
//
// It does NOT keep the browser's controls, in either arrangement (2026-08-14):
// the app's own playback bar drives it, and a control bar whose size no API
// reports cannot be laid out around. The long note beside the element explains.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import { seedAudibility, sourceHeard, useQueueAudibility } from "@/lib/audio/audibility"
import {
  getQueueProgress, pauseQueue, queueClockIsFileTime, resumeQueue, stopQueue, tickProgrammeFilm, useQueueForFile,
} from "@/lib/audio/play-queue"
import { effectiveSourceText } from "@/lib/cell-text"
import type { DirectionMode, TextDirection } from "@/lib/text-direction"
import { cellIdAtSec } from "@/lib/timeline/source-regions"
import {
  getVideoBuffering,
  getVideoClockPlaying,
  getVideoClockSec,
  setVideoBuffering,
  setVideoRate,
  setVideoSoundingCellId,
  setVideoVolume,
  useVideoSoundingCellId,
  useVideoVolume,
} from "@/lib/timeline/video-clock"
import { clearVideoControllerIf, setVideoController, type VideoController } from "@/lib/timeline/video-controller"
import { claimActiveAudio, clearActiveAudioIf, type ActiveAudioController } from "@/lib/audio/audio-coordinator"
import { youTubeVideoId } from "@/lib/video/youtube"
import { YouTubePicture } from "./YouTubePicture"
import { DOCK_HOST_MOVING } from "./media-dock-layout"
import { useHlsVideo } from "@/hooks/useHlsVideo"
import { useMediaPictureUrl } from "@/hooks/useMediaPictureUrl"
import type { FrontierSession } from "@/lib/frontier/types"
import { readFilmAudioLanguage, writeFilmAudioLanguage } from "@/lib/video/film-audio-tracks"
import { VideoAudioPicker } from "./VideoAudioPicker"
import { VideoSoundSourcePicker } from "./VideoSoundSourcePicker"
import {
  onBeforePlaybackSourceSwitch,
  recordingDrivesPlayback,
  switchPlaybackSource,
  usePlaybackSource,
  type PlaybackSource,
} from "@/lib/audio/playback-source"
import { pauseAllTransports } from "@/lib/audio/transport-pause"
import { filmElementVolume, useFilmSoundDb } from "@/lib/audio/track-volume"
import { VIDEO_END_GUARD_SEC, VIDEO_PAUSED_SNAP_SEC, videoDriftBarSec, videoSyncAction } from "./video-sync"
import { filmMomentAt, type FilmPiece } from "@/lib/timeline/film-pieces"
import { nextScrubSeek } from "./video-seek-coalesce"
import { useVideoSeek, type VideoSeekStore } from "./video-seek-store"
import {
  browserPlaysHls,
  forgetStallSample,
  IDLE_SEEK_WATCH,
  IDLE_STALL_STATE,
  loadedEndOf,
  seekTargetLoaded,
  stallStep,
  STALL_MOTION_EPS,
  STALL_TICK_MS,
  watchSeek,
  type SeekWatch,
  type StallState,
} from "./video-stall"
import { DEFAULT_VIDEO_ASPECT, fitPictureRect, intrinsicAspect } from "./video-frame"
import { VideoPaneErrorCard } from "./VideoPaneErrorCard"
import { filmFailure } from "@/lib/timeline/film-failure"
import { VideoPaneCaption } from "./VideoPaneCaption"
import { VideoPaneControls } from "./VideoPaneControls"
import {
  readCaptionPlacement,
  readSubtitleMode,
  writeCaptionPlacement,
  writeSubtitleMode,
  type CaptionPlacement,
  type SubtitleMode,
} from "./video-pane-prefs"

// Re-exported so existing importers (and the pane's own tests) keep one path
// into the caption preferences.
export {
  readCaptionPlacement,
  readSubtitleMode,
  type CaptionPlacement,
  type SubtitleMode,
} from "./video-pane-prefs"
import { useT } from "@/lib/i18n/I18nProvider"

/** `HAVE_FUTURE_DATA` — enough decoded to start and keep going for a moment.
 *  The same bar the play queue's cue gate uses for its audio elements. */
const VIDEO_READY_STATE = 3
/** `HAVE_METADATA` — the element knows its length and its shape. */
const HAVE_METADATA = 1
/** How long to wait for the picture before starting it anyway. Long enough for
 *  an ordinary seek into an unbuffered range over a slow link, short enough
 *  that a stream which will never report ready is not a dead button. */
const VIDEO_READY_TIMEOUT_MS = 4000

/** The stall watchdog's grace, its ladder and its arithmetic all live in
 *  `./video-stall`; only the sampling interval is needed here. */

export interface MediaVideoPaneProps {
  src: string
  projectId?: string
  session?: FrontierSession | null
  /** The file the picture belongs to — the key the mute preference is stored
   *  under. Required rather than optional on purpose: an absent id would seed
   *  nothing and mute nothing, silently, and the compiler catching a caller
   *  that forgot is cheaper than finding that out on screen. */
  fileId: string
  cells: CellData[]
  /** Nonce-keyed seeks from the timeline. Applied unconditionally, because the
   *  queue drops seeks in several ordinary cases (no session, scrubbing into
   *  the trailing pad, a gap no section owns) and the picture must still move.
   *
   *  AQU-1117: `play` rides ALONG WITH the seek rather than arriving as a
   *  separate command, and that is the whole point. "Play from this cue" has to
   *  start at the cue, not at wherever the film happened to be paused — and the
   *  seek does not land for two commits after the press. A play issued from the
   *  press site would sound the old position first and jump afterwards. Carried
   *  here, the start goes through `requestPlayWhenReady`, which already waits
   *  on `seeked`/`canplay`, so the first frame heard is the cue's. */
  seek?: VideoSeekStore
  /** A nonce-keyed play/pause from the timeline (Space). Deliberately a TOGGLE
   *  rather than a desired state: the picture keeps its native controls in the
   *  standalone arrangement, so anything stateful would drift out of step with
   *  them. Toggling against the element's own `paused` cannot. */
  togglePlay?: { nonce: number } | null
  /** True while the recorder is open. The picture stops and stays stopped —
   *  `pauseAllPlayback()` only reaches the queue's own elements, so without
   *  this the mic records the film's soundtrack into the take (and the mic is
   *  opened with echo cancellation off). Deliberately not auto-resumed: after
   *  a take you want to hear the take, not the film starting up again. */
  suspended?: boolean
  /** Only called in the standalone arrangement, where the video owns the clock.
   *  null clears it — the store outlives this component, so a stale position
   *  would go on driving the playhead. */
  onVideoTime?: (sec: number | null) => void
  /** Standalone only: the element's own play/pause state. `timeupdate` fires
   *  ~4Hz, so the playhead needs this to know it may interpolate between
   *  ticks — otherwise it steps. Cleared with the position. */
  onVideoPlaying?: (playing: boolean) => void
  /** How long the linked video is. Reported in BOTH arrangements — the track's
   *  extent is a property of the footage, not of who is driving the transport.
   *  Carries its own src so the store can key by address; null means the
   *  element does not know (yet, or ever). */
  onVideoDuration?: (src: string, sec: number | null) => void
  /** Opens the link-video dialog — offered when the source will not load. */
  onChangeVideo?: () => void
  /** A click on a YouTube picture: play or pause through Aquilla's transport,
   *  exactly as Space and the playback bar's button do (the workspace hands
   *  its timeline toggle). Absent means the picture takes no clicks of ours. */
  onPictureClick?: () => void
  /**
   * AQU-2253: the file follows its recordings. The film is shown there now,
   * running on its own clock: the queue's programme is the transport, and the
   * picture follows the programme's second exactly as it follows a recording's
   * file second — the playhead's time is the film's time. Unlike that
   * arrangement it keeps its OWN sound, which plays straight through with the
   * picture (Sam, Oct 29); the Source audio row's mute silences it.
   */
  followsRecordings?: boolean
  /**
   * AQU-2253 (review, Nov 9): whether the film could not be loaded (the error
   * card is up). Following the recordings the workspace quiets the lines'
   * original while a linked film voices it; a film that cannot play voices
   * nothing, so the workspace has to know. False again on a retry, a new
   * address, and when the pane leaves.
   */
  onFilmFailed?: (failed: boolean) => void
  /**
   * AQU-2227 (review, Nov 9): following the recordings, this file is laid out
   * and played from its audio cue file's heard lines, where its takes live
   * (`playsHeardLines`). The file's own recording lines are not what plays
   * then, so nothing else voices the original: the film's own sound does,
   * straight through, as on any subtitle file with heard lines. That holds
   * for an imported film too, and whatever the sound pick says.
   */
  playsHeardLines?: boolean
  /**
   * AQU-2253 (Sam, Oct 30): the film was IMPORTED through the importer (a
   * video uploaded like any other file), not linked. Its sound is the Source
   * audio row's, by the rules any uploaded recording follows, so the element
   * is always muted — in both timings, whatever the Source audio mute says.
   */
  importedFilm?: boolean
  /**
   * AQU-2253 (Sam, Oct 30): an imported film following the recordings, cut
   * into its lines' pieces (lib/timeline/film-pieces). The queue's programme
   * second is a moment of the TIMELINE then, and the picture shows the piece
   * under it: that line's own stretch of the film, its last frame held while
   * a longer recording finishes. Null or absent: the film's own clock.
   */
  filmPieces?: readonly FilmPiece[] | null
  sourceDirectionMode?: DirectionMode
  targetDirectionMode?: DirectionMode
  sourceTextDirection?: TextDirection
  targetTextDirection?: TextDirection
}

export function MediaVideoPane({
  src: storedSrc,
  projectId,
  session,
  fileId,
  cells,
  seek,
  togglePlay,
  suspended,
  onVideoTime,
  onVideoPlaying,
  onVideoDuration,
  onChangeVideo,
  onPictureClick,
  followsRecordings = false,
  onFilmFailed,
  playsHeardLines = false,
  importedFilm = false,
  filmPieces = null,
  sourceDirectionMode = "auto",
  targetDirectionMode = "auto",
  sourceTextDirection = "ltr",
  targetTextDirection = "ltr",
}: MediaVideoPaneProps) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement>(null)
  /** The elements whose metadata has been taken (`takeMetadata`), so the
   *  catch-up on screen never takes it twice. */
  const metadataTakenRef = useRef(new WeakSet<HTMLVideoElement>())
  const cellIdSet = useMemo(() => new Set(cells.map((c) => c.id)), [cells])
  const queue = useQueueForFile(cellIdSet)
  const [mode, setModeState] = useState<SubtitleMode>(() => readSubtitleMode())
  const [placement, setPlacementState] = useState<CaptionPlacement>(() => readCaptionPlacement())
  const [failed, setFailed] = useState(false)
  // AQU-2253 (review, Nov 9): a film that cannot play voices nothing.
  useEffect(() => {
    if (!onFilmFailed) return
    onFilmFailed(failed)
    return () => onFilmFailed(false)
  }, [failed, onFilmFailed])
  /** The YouTube player's error code when it failed (null: none given). */
  const [youTubeErrorCode, setYouTubeErrorCode] = useState<number | null>(null)
  const [needsGesture, setNeedsGesture] = useState(false)
  /** AQU-2253 (review, Nov 13): the wait for the network reached its ceiling
   *  (FILM_NOT_ARRIVING_SEC with nothing new loaded): playback stopped, and the
   *  pane says why in place of "Click to start". Play tries again. */
  const [notArriving, setNotArriving] = useState(false)
  /** Bumped by loadedmetadata/durationchange: the media load algorithm resets
   *  playbackRate when the source changes, so rate has to be re-applied. */
  const [mediaEpoch, setMediaEpoch] = useState(0)
  /** Bumped by "Try again", and by the stall ladder's last rung, so the element
   *  is rebuilt against the same URL. */
  const [loadAttempt, setLoadAttempt] = useState(0)
  const src = useMediaPictureUrl({
    src: storedSrc, projectId, fileId, session, retryKey: loadAttempt,
  }) ?? ""
  /**
   * The player. These films are HLS playlists rather than files, which only
   * Safari can open on its own — so without this the picture, and the
   * recorder's film beside it, simply do not exist in Chrome, Edge or Firefox.
   * It also puts a ceiling on how large a rendition we ask a machine to decode,
   * which is the likeliest cure for the freeze the watchdog below exists to
   * survive. An ordinary file or a recording goes on being handled by the
   * browser, and `pipeline` says which is driving.
   */
  /**
   * What the film speaks. These masters carry sixty-five dubs of the same
   * episode and flag none of them as the default, so a player left to itself
   * picks the top of an alphabetical list — which is how Sam's film came up in
   * Amharic the moment the streaming player replaced Safari's own. The choice
   * is remembered per film, in this browser, and English until someone says
   * otherwise.
   */
  const [audioLanguage, setAudioLanguage] = useState<string | null>(() => readFilmAudioLanguage(src))
  useEffect(() => {
    setAudioLanguage(readFilmAudioLanguage(src))
  }, [src])
  const youTube = useMemo(() => youTubeVideoId(src) != null, [src])
  const stream = useHlsVideo(videoRef, src, { attachKey: loadAttempt, audioLanguage, enabled: !youTube })
  const pipeline = stream.pipeline
  const chooseAudioLanguage = useCallback(
    (lang: string) => {
      writeFilmAudioLanguage(src, lang)
      setAudioLanguage(lang)
    },
    [src],
  )
  /** Held open while the language menu is: the corner controls fade with the
   *  pointer, and a list that vanishes as you reach for it is unusable. */
  const [audioMenuOpen, setAudioMenuOpen] = useState(false)
  /** The caption toggle rides faded on the picture; this shows it briefly when
   *  playback starts so the control is discoverable without hovering. */
  const [modeRevealed, setModeRevealed] = useState(false)
  useEffect(() => {
    if (!queue.playing) {
      setModeRevealed(false)
      return
    }
    setModeRevealed(true)
    const t = window.setTimeout(() => setModeRevealed(false), 2500)
    return () => window.clearTimeout(t)
  }, [queue.playing])

  /**
   * Slaving is only possible when this file's queue can produce FILE-timeline
   * seconds, which needs a media cell backed by the shared source clip. Asking
   * "does it have any playable audio?" instead looks equivalent and is not: a
   * subtitle file whose cells are text, carrying one recorded take, answers yes
   * — and then every tick fails the file-time test and pauses the picture, so
   * the user gets a frozen first frame, no controls, and no way to start it.
   */
  const recordingCell = useMemo(() => cells.find((c) => queueClockIsFileTime(c)), [cells])
  /**
   * AQU-1565 follow-up: having a recording is necessary for slaving, no longer
   * sufficient. A YouTube picture keeps its own sound and drives itself until
   * the person picks the uploaded recording (`playback-source.ts`); a streamed
   * film defaults to the recording, which is the arrangement it always had.
   */
  const playbackSource = usePlaybackSource(fileId, src)
  // AQU-2253: following the recordings the programme drives, so the picture is
  // slaved there whether or not a recording exists.
  // AQU-2253 (review, Nov 9): the sound pick counts in both timings. Where the
  // uploaded recording is the sound picked, the film is the quiet one,
  // following the recordings as much as following the source.
  // AQU-2227 (review, Nov 9): unless the file plays its heard lines: the
  // recording is not in what plays then, so the film's sound is the original.
  const recordingDrives = recordingDrivesPlayback(recordingCell != null, playbackSource)
  const recordingIsTheSound = recordingDrives && !playsHeardLines
  const slaved = followsRecordings || recordingDrives
  /** The sound menu exists only where there is a choice to make: a YouTube
   *  picture over a file that also carries an uploaded recording. */
  const offerSoundSource = youTube && recordingCell != null
  const recordingName = recordingCell?.original.trim() || null
  const [soundMenuOpen, setSoundMenuOpen] = useState(false)
  /** Whether the film's soundtrack is on. Only bites in the standalone
   *  arrangement — a slaved picture is already silent. */
  // AQU-2664: a soloed track elsewhere quiets the film too.
  const sourceAudible = sourceHeard(useQueueAudibility())
  // Put this file's stored preference into the play-queue store, which is where
  // every surface reads it from. Keyed on the file ALONE: re-seeding on
  // anything else would re-read the value on disk and undo a mute made this
  // session. TimelineEditor seeds too — first mount wins, the other is a no-op
  // re-publish of the identical value.
  useEffect(() => {
    seedAudibility(fileId)
  }, [fileId])

  const setMode = useCallback((next: SubtitleMode) => {
    setModeState(next)
    writeSubtitleMode(next)
  }, [])

  const setPlacement = useCallback((next: CaptionPlacement) => {
    setPlacementState(next)
    writeCaptionPlacement(next)
  }, [])

  // ── The picture rect. The black field fills the pane; the picture is centred
  // inside it at the video's own proportions, and the caption anchors to the
  // PICTURE rather than the field so it cannot drift into a bar on resize.
  const fieldRef = useRef<HTMLDivElement>(null)
  const [fieldSize, setFieldSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [aspect, setAspect] = useState<number>(DEFAULT_VIDEO_ASPECT)
  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    const measure = () => setFieldSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === "undefined") return // happy-dom
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [failed])
  const picture = fitPictureRect(fieldSize.w, fieldSize.h, aspect)

  /**
   * Which line the picture is on, when the picture is the transport. The queue
   * answers this everywhere it runs and cannot run at all here, so there is
   * nothing to ask — the element's own clock is the only source. Held as the
   * cell ID rather than the second so this re-renders on a line CHANGE, not on
   * every one of `timeupdate`'s ~4 ticks a second.
   */
  // Round 5: this used to be local state, which is exactly why the dialogue
  // table never followed the film — the caption could see which line the
  // picture was on and nothing else could. It now lives in the video clock
  // store beside the position it is derived from, so every surface reads one
  // answer.
  const standaloneCellId = useVideoSoundingCellId()
  useEffect(() => {
    if (slaved) setVideoSoundingCellId(null)
  }, [slaved])
  const queueOverFilmTail = followsRecordings && queue.progress.filmTail === true
  const soundingCell = useMemo(() => {
    // The queue wins whenever it is running, unconditionally — today's exact
    // rule, so nothing about the dubbing arrangement changes.
    // AQU-2253 (Sam, Nov 9): but over a linked film's tail, past the last
    // line, no line is playing: the queue only stays on the last line there
    // to keep its clock this file's, and that line's caption would sit on the
    // picture for the rest of the film.
    if (queue.cellId != null) return queueOverFilmTail ? undefined : cells.find((c) => c.id === queue.cellId)
    if (slaved || standaloneCellId == null) return undefined
    return cells.find((c) => c.id === standaloneCellId)
  }, [cells, queue.cellId, queueOverFilmTail, slaved, standaloneCellId])
  // Is the queue's clock a second of the FILM? A recording's file second is;
  // following the recordings so is the programme's (AQU-2253), and a take
  // played on its own per-take clock never is.
  const clockIsFileTime = followsRecordings
    ? queue.progress.programmeClock
    : queueClockIsFileTime(soundingCell)
  /**
   * AQU-2253 (review, Nov 9): following the recordings, where only the film
   * plays (its tail, and a line it plays behind with nothing of its own) the FILM is the
   * clock, as it is following the source; the queue says where. There the
   * pane reports the film's second instead of chasing the queue's, keeps the
   * film wanted while the transport waits on it, and runs the stall watchdog.
   */
  const filmIsClock = followsRecordings && queue.active && queue.progress.filmClock === true
  /** AQU-2253 (review 2, Nov 9): the queue gave up waiting on the film as a
   *  line's clock (it said nothing for 3 s) and listens for it again. */
  const filmListenedFor = followsRecordings && queue.active && queue.progress.filmQuiet === true
  const filmIsClockRef = useRef(false)
  useEffect(() => {
    filmIsClockRef.current = filmIsClock
  }, [filmIsClock])
  /** The browser will not start the film without a click. Where the film is
   *  the clock the transport pauses: nothing runs on behind the overlay. */
  const askForClick = useCallback(() => {
    setNeedsGesture(true)
    if (filmIsClockRef.current) pauseQueue()
  }, [])
  /** AQU-2253 (review, Nov 13): the film isn't arriving. The same stop as
   *  above, with the reason instead of a click to offer. */
  const sayNotArriving = useCallback(() => {
    setNotArriving(true)
    if (filmIsClockRef.current) pauseQueue()
  }, [])

  /**
   * Publish where the picture is, for everything that is not this pane: the
   * playhead, the bar's readout, the dialogue table's marked row, and the dub
   * driver's tick all read the video clock.
   *
   * Round 6: `timeupdate` used to be the ONLY caller. That event does not fire
   * while a seek is in flight, and browsers may not fire it at all for a
   * `currentTime` write against an element that has not opened yet — so after
   * scrubbing a paused film every one of those surfaces sat on the position the
   * film used to be at, until the element happened to tick. The seek paths now
   * publish where they are going, and `seeked` confirms where they landed.
   */
  const publishPosition = useCallback(
    (sec: number) => {
      if (slaved || !Number.isFinite(sec)) return
      onVideoTime?.(sec)
      // Setting the same id is a no-op re-render in React, so subscribers only
      // repaint when the LINE changes, not on every one of timeupdate's ticks.
      setVideoSoundingCellId(cellIdAtSec(cells, sec))
    },
    [slaved, onVideoTime, cells],
  )
  // The seek paths below are keyed on a command nonce and must not re-run when
  // the cell list changes, so they reach the latest publisher through a ref.
  const publishPositionRef = useRef(publishPosition)
  useEffect(() => {
    publishPositionRef.current = publishPosition
  }, [publishPosition])

  const prevTickRef = useRef<{ sec: number; at: number } | null>(null)
  const lastSeekAtRef = useRef<number | null>(null)
  const playFailuresRef = useRef(0)
  /** Whether the transport still wants the picture running, read by the retry
   *  below so a rejection that arrives after a pause cannot restart it. */
  const wantPlayRef = useRef(false)
  /** AQU-2253 (review, Nov 9): when a slaved picture was last newly asked to
   *  play: the stall watchdog's patience for a cold start. */
  const wantSinceRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  /** Abandons a readiness wait in progress. Null when nothing is waiting. */
  const pendingPlayRef = useRef<(() => void) | null>(null)
  /** The film's `timeupdate`, where the film is the clock. Only a film that is
   *  where the playhead is counts, never one on its way to a seek. */
  const reportFilmClock = useCallback((video: HTMLVideoElement) => {
    if (video.seeking) return
    const { currentTime, rate } = getQueueProgress()
    if (Math.abs(video.currentTime - currentTime) > videoDriftBarSec(rate)) return
    // Nor one the playhead has just been put back from (Previous line), before
    // the pane has sent it there: its second would take the playhead forward again.
    const seen = prevTickRef.current?.sec
    if (seen != null && currentTime < seen - VIDEO_PAUSED_SNAP_SEC) return
    tickProgrammeFilm(video.currentTime)
  }, [])

  useEffect(
    () => () => {
      if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current)
      pendingPlayRef.current?.()
    },
    [],
  )

  const requestPlay = useCallback((video: HTMLVideoElement) => {
    const attempt = video.play()
    if (!attempt || typeof attempt.catch !== "function") return
    attempt.catch((err: unknown) => {
      // A pause taken while the element was still opening or seeking rejects
      // the in-flight play with AbortError. That is not a refusal to autoplay —
      // it is us, and retrying it would start the picture with the sound
      // stopped and eventually raise a bogus click-to-play prompt.
      if (err instanceof Error && err.name === "AbortError") return
      if (!wantPlayRef.current || videoRef.current !== video) return
      // Muted + playsInline is normally allowed to autoplay, but Safari's
      // "Never Auto-Play" and iOS Low Power Mode refuse it anyway. Retry once
      // on the next tick, then stop asking and offer a click instead.
      playFailuresRef.current += 1
      if (playFailuresRef.current >= 2) {
        askForClick()
        return
      }
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null
        if (!wantPlayRef.current || videoRef.current !== video) return
        const retry = video.play()
        if (retry && typeof retry.catch === "function") {
          retry.catch((e: unknown) => {
            if (e instanceof Error && e.name === "AbortError") return
            askForClick()
          })
        }
      }, 0)
    })
  }, [askForClick])

  /** Give up on a readiness wait, and stop reporting one. Safe to call when
   *  nothing is waiting. */
  const cancelPendingPlay = useCallback(() => {
    const abandon = pendingPlayRef.current
    if (abandon) abandon()
    else setVideoBuffering(false)
  }, [])

  /**
   * Start the picture — once it is actually able to start.
   *
   * Round 6. Sam's report: pause mid-film, drag the playhead back, press play
   * immediately, and the picture would start with sound while the playhead and
   * the bar sat still. Part of that was the queue being cued behind our backs
   * (fixed in ProjectWorkspace), and part was this: the play command went
   * straight to `element.play()` with a seek still in flight. Nothing here ever
   * read `readyState`, and nothing listened for `seeked` or `canplay`, so the
   * app had no idea the picture was not ready and no way to say so.
   *
   * The shape is the play queue's own cue gate (`progCueSource`): wait on
   * `canplay` AND `seeked`, because they cover different cases — `seeked` is
   * what arrives when a streamed, unbuffered range finally lands, `canplay` is
   * what a freshly opened element reports — and give up after a patience
   * window rather than leaving the user with a spinner and no film.
   */
  const requestPlayWhenReady = useCallback(
    (video: HTMLVideoElement) => {
      // A second press or a fresh seek supersedes whatever was waiting.
      cancelPendingPlay()
      // HAVE_FUTURE_DATA with no seek outstanding: it can start this instant,
      // which is the overwhelmingly common case and behaves exactly as before.
      if (video.readyState >= VIDEO_READY_STATE && !video.seeking) {
        requestPlay(video)
        return
      }
      setVideoBuffering(true)
      let settled = false
      let timer: number | null = null
      // Declarations, not consts: `settle` names the listeners it detaches.
      function detach(): void {
        if (timer != null) window.clearTimeout(timer)
        timer = null
        video.removeEventListener("canplay", onReady)
        video.removeEventListener("seeked", onReady)
        video.removeEventListener("error", onUnplayable)
      }
      function settle(start: boolean): void {
        if (settled) return
        settled = true
        detach()
        if (pendingPlayRef.current === abandon) pendingPlayRef.current = null
        setVideoBuffering(false)
        // The transport may have changed its mind while we waited — a pause, a
        // file switch, the recorder opening. Only start if it still wants this.
        if (start && wantPlayRef.current && videoRef.current === video) requestPlay(video)
      }
      function onReady(): void { settle(true) }
      function onUnplayable(): void { settle(false) }
      function abandon(): void { settle(false) }
      video.addEventListener("canplay", onReady)
      video.addEventListener("seeked", onReady)
      video.addEventListener("error", onUnplayable)
      // Patience, not a promise. A stream that never says it is ready still
      // gets asked to play; `requestPlay`'s own retry then owns the outcome.
      timer = window.setTimeout(() => settle(true), VIDEO_READY_TIMEOUT_MS)
      pendingPlayRef.current = abandon
    },
    [requestPlay, cancelPendingPlay],
  )

  /**
   * A STALL IS NOT A PAUSE, and the element will not tell us which it is.
   * (Sam, 2026-08-18, twice a round apart: "it buffers, then 'plays' for half a
   * second, then gets stuck again but the button still indicates that it is
   * playing.")
   *
   * The first attempt at this listened for `waiting` and `stalled`. Safari does
   * not fire either for the wedge Sam hits — it keeps `paused === false`, keeps
   * reporting a healthy `readyState`, and simply stops producing frames — so
   * nothing here ever ran, and the one guard that did exist asked the wedged
   * element whether it was wedged and believed the answer.
   *
   * The clock is the only honest witness, so this samples it once a second and
   * `./video-stall` decides. Two things follow, and both were broken before:
   *
   * FIRST, SAY SO. `selectTransportForFile` suppresses the loading spinner
   * while anything reports playback (a film rebuffering mid-play is its own
   * business), and nothing ever cleared `playing`, because clearing it is what
   * a `pause` event does. So the button could not have shown a spinner however
   * well we detected the stall. A stalled picture is NOT playing; saying that
   * is both true and what turns the lie into a spinner.
   *
   * SECOND, CLIMB. Each rung is a different attempt, not the same one louder:
   * re-fetch where we are; ask the player to rebuild its decoder; then throw
   * the element away and, where the streaming player was driving, hand the
   * address to the browser instead — the one remaining thing that is genuinely
   * a different decoder. Then stop, and offer the click that does work.
   */
  const stallRef = useRef<StallState>(IDLE_STALL_STATE)
  /** AQU-2253 (review, Nov 9): the seek in flight, for `watchSeek`, and when a
   *  seek was last asked for (held back or not). */
  const seekWatchRef = useRef<SeekWatch>(IDLE_SEEK_WATCH)
  const seekAskedAtRef = useRef<number | null>(null)
  /** Where to put the picture back after a reload or a rebuild. */
  const resumeAtRef = useRef<number | null>(null)
  /** Props reached from inside the interval, which must not re-arm on every
   *  render a caller passes a fresh arrow. */
  const onVideoPlayingRef = useRef(onVideoPlaying)
  useEffect(() => {
    onVideoPlayingRef.current = onVideoPlaying
  }, [onVideoPlaying])
  const streamRef = useRef(stream)
  useEffect(() => {
    streamRef.current = stream
  })

  useEffect(() => {
    // Slaved, the queue re-issues play and corrective seeks every tick, which
    // is its own watchdog — and a second one would fight it.
    // AQU-2253 (review, Nov 9): unless the film is the clock. Then nothing
    // re-issues anything, so a stopped film gets this watchdog and its ladder,
    // as following the source. The spinner is the queue's there (it hears no
    // reports), so the picture's own "buffering" and "playing" are not written.
    if (slaved && !filmIsClock) {
      stallRef.current = IDLE_STALL_STATE
      return
    }
    const report = (buffering: boolean, playing: boolean) => {
      if (slaved) return
      setVideoBuffering(buffering)
      onVideoPlayingRef.current?.(playing)
    }
    const id = window.setInterval(() => {
      const video = videoRef.current
      if (!video) return
      // AQU-2253 (review, Nov 9): a seek is the network's business unless it
      // is stuck: five seconds over film that has loaded, no `seeked`, no
      // newer seek asked for.
      // Loaded a second past where it stands: what a seek and a stall both ask.
      const loaded = seekTargetLoaded(video)
      const seek = watchSeek(seekWatchRef.current, {
        seeking: video.seeking,
        sec: video.currentTime,
        loaded,
        now: Date.now(),
        askedAt: Math.max(lastSeekAtRef.current ?? 0, seekAskedAtRef.current ?? 0) || null,
      })
      seekWatchRef.current = seek.watch
      const step = stallStep(stallRef.current, {
        sec: video.currentTime,
        // What the TRANSPORT wants. The element's own flag is the thing that
        // lies here.
        wantPlay: wantPlayRef.current,
        paused: video.paused,
        ended: video.ended,
        seeking: video.seeking && !seek.stuck,
        seekStuck: seek.stuck,
        // AQU-2253 (browser pass, Nov 11): a film that has played out what it
        // loaded is waiting on the network, and is waited on (video-stall.ts),
        // for as long as something new is loading (review, Nov 13).
        loadedAhead: loaded,
        loadedEnd: loadedEndOf(video.buffered),
        // AQU-2253 (review, Nov 9): …or, where the film is the clock (no
        // readiness wait there), a film still opening: the same patience.
        pendingPlay: pendingPlayRef.current != null
          || (slaved && video.readyState < VIDEO_READY_STATE && Date.now() - wantSinceRef.current < VIDEO_READY_TIMEOUT_MS),
      })
      stallRef.current = step.state
      const action = step.action
      if (action.kind === "none") return

      if (action.kind === "recovered") {
        report(false, true)
        return
      }

      if (action.kind === "giveUp" || action.kind === "notArriving") {
        report(false, false)
        wantPlayRef.current = false
        // Stop the element too, so its own flag agrees with the intent we just
        // abandoned. A wedged picture that unwedges itself an hour later must
        // not start playing at a user who has long since moved on.
        video.pause()
        if (action.kind === "giveUp") askForClick()
        else sayNotArriving()
        return
      }

      // A rung. Whatever we are about to try, stop claiming playback first.
      report(true, false)
      if (action.kind === "wait") return
      const stream = streamRef.current
      const at = video.currentTime

      if (action.rung === "nudge") {
        // Same position, fresh fetch — the standard way to make a stalled
        // stream re-request. `restartLoad` is a no-op on the native path.
        stream.restartLoad()
        try {
          video.currentTime = at
        } catch {
          /* not seekable yet */
        }
        void video.play().catch(() => {})
        return
      }

      if (action.rung === "recover") {
        if (stream.pipeline === "hls") {
          stream.recoverMedia()
          void video.play().catch(() => {})
        } else {
          // The native equivalent: re-open the source, and put the picture back
          // where it was once the element reports its shape.
          resumeAtRef.current = at
          stallRef.current = forgetStallSample(stallRef.current)
          video.load()
        }
        return
      }

      // Rebuild: a different element, and where the streaming player was
      // driving, a different player too. Both rungs above reused the same
      // decoder, which for this wedge is the thing that is broken.
      resumeAtRef.current = at
      stallRef.current = forgetStallSample(stallRef.current)
      // AQU-2253 (review, Nov 9): to the browser's own player only where it can
      // play a stream (Safari). Chromium and Firefox cannot, and the film was
      // left unplayable; there the streaming player is rebuilt instead.
      if (stream.pipeline === "hls" && browserPlaysHls(video)) stream.fallbackToNative()
      setLoadAttempt((n) => n + 1)
    }, STALL_TICK_MS)
    return () => window.clearInterval(id)
  }, [slaved, filmIsClock, askForClick, sayNotArriving])

  // AQU-2253 (re-review, Nov 13): "the film isn't arriving" goes the moment
  // film arrives, by the test the minute itself uses (the loaded end moving):
  // a click on the ruler once the connection is back shows its frame, not the
  // message over it. Playback stays stopped until Play.
  useEffect(() => {
    if (!notArriving) return
    const from = loadedEndOf(videoRef.current?.buffered)
    const id = window.setInterval(() => {
      if (loadedEndOf(videoRef.current?.buffered) > from + STALL_MOTION_EPS) setNotArriving(false)
    }, STALL_TICK_MS)
    return () => window.clearInterval(id)
  }, [notArriving])

  /**
   * A YOUTUBE PICTURE DOES NOT SURVIVE A MOVE. The dock moves the film between
   * areas by moving the element it is drawn into (useMediaDock), and a browser
   * reloads an iframe that is moved in the page. A <video> moves untouched and
   * plays on; a YouTube picture is an iframe, so it came back at 0:00, stopped,
   * with its player cut off from the transport's play, pause and seek (review,
   * Oct 29). The dock says when it is about to move the film, and a YouTube
   * picture is then rebuilt where it lands, as the stall ladder's last rung
   * does: a fresh element and player, put back where it was, and started again
   * if the transport still wants it. The time is read now, while the player is
   * still the live one.
   */
  useEffect(() => {
    const host = fieldRef.current?.closest("[data-media-panel]")
    if (!youTube || !host) return
    const onMoving = () => {
      const video = videoRef.current
      if (!video) return
      // A rebuild already on its way keeps the place it is going back to.
      if (resumeAtRef.current == null) resumeAtRef.current = video.currentTime
      stallRef.current = forgetStallSample(stallRef.current)
      // A wait for the old element to be ready would never end.
      cancelPendingPlay()
      // Not playing until the new player is, or the playhead runs on over a
      // picture that is still loading.
      if (!slaved) onVideoPlayingRef.current?.(false)
      setLoadAttempt((n) => n + 1)
    }
    host.addEventListener(DOCK_HOST_MOVING, onMoving)
    return () => host.removeEventListener(DOCK_HOST_MOVING, onMoving)
    // `failed`: the field is only there while the error card is not.
  }, [youTube, failed, slaved, cancelPendingPlay])

  /**
   * Switching sound mid-play hands the transport from one player to the other
   * (queue <-> picture). Neither stops the other on its own: picking the
   * video's sound unmutes a picture that is still running while the queue
   * plays on underneath it, and the playback bar then drives only the picture.
   * So everything stops first, and the person presses play on the new source.
   * Nothing resumes by itself, the house rule for every pause here.
   *
   * pauseAllTransports alone is not enough for that (walk 2026-10-02):
   * - A SLAVED picture has no registered controller; it is normally stopped by
   *   the sync effect following the queue. But the flip below makes the pane
   *   standalone on the next render, so that effect never runs, and the
   *   picture played on, now unmuted. So the element is paused here directly,
   *   and the play intent dropped so the stall watchdog does not restart it.
   * - A PAUSED queue is still "active" for this file, and an active queue owns
   *   the playback bar (`selectTransportForFile`). Play then resumed the
   *   recording under the video's own sound. Stopping it hands the bar to the
   *   source the person just picked.
   */
  //
  // The timeline's Source audio lane offers the same choice (Sam, Oct 5), so
  // the stopping is registered for the file and runs whichever surface the
  // person used (`switchPlaybackSource`).
  const queueActive = queue.active
  useEffect(
    () =>
      onBeforePlaybackSourceSwitch(fileId, () => {
        pauseAllTransports()
        wantPlayRef.current = false
        stallRef.current = IDLE_STALL_STATE
        cancelPendingPlay()
        videoRef.current?.pause()
        if (queueActive) stopQueue()
      }),
    [fileId, queueActive, cancelPendingPlay],
  )
  const chooseSoundSource = (next: PlaybackSource) => switchPlaybackSource(fileId, playbackSource, next)

  // Handing the transport to the queue abandons any start we were waiting for.
  //
  // Deliberately its own effect keyed on `slaved` alone, rather than folded
  // into the clock-clearing effect further down. That one depends on the
  // `onVideoTime`/`onVideoPlaying` props, so cancelling from its cleanup would
  // tear down a perfectly good wait on any re-render where a caller passed a
  // fresh arrow — which is exactly what a test caught when this lived there.
  useEffect(() => {
    if (slaved) cancelPendingPlay()
  }, [slaved, cancelPendingPlay])

  // ── The transport. One effect owns play/pause AND position, so the two can
  // never disagree about what the queue is doing.
  const queueTickSec = queue.progress.currentTime
  const rate = queue.progress.rate
  // AQU-2253 (Sam, Oct 30): an imported film following the recordings is cut
  // into its lines' pieces, so the programme's second is turned into the
  // film's own: the moment of the piece under the playhead, or that piece's
  // last frame, held, while a longer recording finishes.
  const cutFilm = followsRecordings && filmPieces != null && filmPieces.length > 0
  const moment = cutFilm && clockIsFileTime ? filmMomentAt(filmPieces!, queueTickSec) : null
  const tickSec = moment ? moment.sec : queueTickSec
  const holding = moment?.held === true
  /** AQU-2253: the timeline second the playhead was last put at, by the queue
   *  running or paused on this file, or by a seek — what an imported film's
   *  picture is placed by while nothing plays (see below). */
  const playheadSecRef = useRef<number | null>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video || !slaved || failed) return
    const now = Date.now()
    const prev = prevTickRef.current
    if (clockIsFileTime && queue.kind !== "idle" && queue.kind !== "error") playheadSecRef.current = queueTickSec
    if (holding && queue.kind !== "idle" && queue.kind !== "error") {
      // The line's recording runs longer than its stretch of the film: the
      // picture stays on that stretch's last frame until the line ends. Paused
      // there, and sent there once if it is anywhere else.
      prevTickRef.current = null
      wantPlayRef.current = false
      video.pause()
      if (Math.abs(video.currentTime - tickSec) > VIDEO_PAUSED_SNAP_SEC) {
        try {
          video.currentTime = tickSec
          lastSeekAtRef.current = now
        } catch {
          /* not seekable yet — the next tick re-issues it */
        }
      }
      return
    }
    const action = videoSyncAction({
      kind: queue.kind,
      clockIsFileTime,
      tickSec,
      videoSec: video.currentTime,
      prevTickSec: prev?.sec ?? null,
      prevTickAt: prev?.at ?? null,
      now,
      rate,
      duration: video.duration,
      lastSeekAt: lastSeekAtRef.current,
      filmIsClock,
    })
    // AQU-2253 (review, Nov 9): the film is the clock and is held on its own
    // last frame: the queue is told it is over, whatever length was stored.
    const filmIsOver = filmIsClock && queue.running && clockIsFileTime
      && Number.isFinite(video.duration) && video.duration > 0

    if (action.kind === "pause") {
      // Terminal or unusable: forget the anchor so the next real playback
      // re-anchors instead of predicting from a stale one.
      prevTickRef.current = null
      wantPlayRef.current = false
      video.pause()
      if (filmIsOver) tickProgrammeFilm(video.currentTime, true)
      return
    }

    if (action.kind === "end") {
      // AQU-2253: past the film's end the panel holds the last frame.
      prevTickRef.current = null
      wantPlayRef.current = false
      video.pause()
      try {
        video.currentTime = action.sec
        lastSeekAtRef.current = now
      } catch {
        /* not seekable yet — the next tick re-issues it */
      }
      if (filmIsOver) tickProgrammeFilm(video.currentTime, true)
      return
    }

    if (prev?.sec !== tickSec) prevTickRef.current = { sec: tickSec, at: now }

    if (action.kind === "seek") {
      try {
        video.currentTime = action.sec
        lastSeekAtRef.current = now
      } catch {
        /* not seekable yet — the next tick re-issues it */
      }
    }

    // AQU-2253 (review, Nov 9): where the film is the clock, "loading" is the
    // transport waiting FOR the film, so the film stays wanted through it.
    // A newly wanted film is a fresh start for the stall watchdog.
    const wantFilm = queue.playing || (filmIsClock && queue.kind === "loading")
    if (wantFilm && !wantPlayRef.current) {
      stallRef.current = IDLE_STALL_STATE
      setNotArriving(false)
      wantSinceRef.current = now
    }
    wantPlayRef.current = wantFilm
    if (wantFilm) requestPlay(video)
    else video.pause()
  }, [slaved, failed, queue.kind, queue.playing, queue.running, filmIsClock, clockIsFileTime, tickSec, queueTickSec, holding, rate, mediaEpoch, requestPlay])

  // AQU-2253: an imported film while nothing plays — the file just opened, or
  // its timing just switched (which stops the queue). The playhead stays on its
  // second, which now means a moment of the other timing, so the picture is put
  // where that second is under the rule in force: the piece under it following
  // the recordings, that second of the film following the source. Without
  // this the panel went on showing the frame of the other timing.
  useEffect(() => {
    const video = videoRef.current
    if (!importedFilm || !video || !slaved || failed || queue.kind !== "idle") return
    const at = playheadSecRef.current ?? 0
    const sec = cutFilm ? (filmMomentAt(filmPieces!, at)?.sec ?? at) : at
    if (Math.abs(video.currentTime - sec) <= VIDEO_PAUSED_SNAP_SEC) return
    video.pause()
    try {
      video.currentTime = sec
      lastSeekAtRef.current = Date.now()
      prevTickRef.current = null
    } catch {
      /* not seekable yet — re-run when the element reloads (mediaEpoch) */
    }
  }, [importedFilm, slaved, failed, queue.kind, cutFilm, filmPieces, mediaEpoch])

  // Playback speed. Set both, because `defaultPlaybackRate` is what survives a
  // load, and re-apply whenever the element reloads. This is the STARTING
  // point; the transport effect above then trims it towards what the sound is
  // measurably doing. Changing the nominal rate discards the old measurement.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !slaved) return
    video.defaultPlaybackRate = rate
    video.playbackRate = rate
  }, [rate, slaved, mediaEpoch])

  // AQU-2253 (review, Nov 9): following the recordings the bottom strip's
  // volume and mute are the queue's, and the film's own sound is part of what
  // plays there: under the lines, and all there is over its tail. So it takes
  // the queue's volume, and at zero (the strip's mute) it is muted, which is
  // the part iPhone and iPad honour (they ignore an element's volume). Back
  // following the source, where the strip sets the film's volume itself, the
  // film has its own again.
  //
  // Sam, Nov 27: and the film's row has its own volume slider, like every
  // track's (track-volume.ts `applyFilmSoundDb`). The element plays at the
  // bar's volume times that level, so the bar keeps meaning the bar. This is
  // the one place the element's volume is set; the bar's own number lives in
  // the video clock's store and is never read back from the element.
  const queueVolume = queue.progress.volume
  const ownVolume = useVideoVolume()
  const filmDb = useFilmSoundDb()
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = filmElementVolume(followsRecordings ? queueVolume : ownVolume, filmDb)
  }, [followsRecordings, queueVolume, ownVolume, filmDb, mediaEpoch])

  // An explicit seek from the timeline. Applied whatever the queue thinks.
  const seekSec = useVideoSeek(seek)
  const seekNonce = seekSec?.nonce
  const seekTarget = seekSec?.sec
  /** AQU-1117: whether THIS seek also asked the picture to start. Read through
   *  a ref because the effect below is keyed on the nonce alone (re-running it
   *  on a changed flag would replay a stale seek); the render that carries a
   *  new nonce also carries the flag that belongs to it. */
  const seekWantsPlayRef = useRef(false)
  seekWantsPlayRef.current = seekSec?.play === true
  /** AQU-2253: the pieces an explicit seek lands in, read through a ref for
   *  the same reason (the seek effect is keyed on its nonce alone). Kept by an
   *  effect declared before that one, so it is current when the seek runs. */
  const filmPiecesRef = useRef<readonly FilmPiece[] | null>(null)
  const seekPieces = cutFilm ? filmPieces : null
  useEffect(() => {
    filmPiecesRef.current = seekPieces
  }, [seekPieces])
  /** A target held back because the element was still seeking. */
  const pendingScrubSeekRef = useRef<number | null>(null)
  /** The one place `currentTime` is written for a requested seek, so the
   *  coalescer and its drain cannot drift apart. */
  const applySeekRef = useRef<(sec: number) => void>(() => {})
  applySeekRef.current = (sec: number) => {
    const video = videoRef.current
    if (!video) return
    try {
      // AQU-2253: a seek past the film's end lands on its last frame, the same
      // place a playhead running off the end leaves it (see video-sync).
      video.currentTime = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(sec, Math.max(0, video.duration - VIDEO_END_GUARD_SEC))
        : sec
      lastSeekAtRef.current = Date.now()
      prevTickRef.current = null
      // The clock is about to jump, and a jump BACKWARDS looks exactly like a
      // frozen one to the watchdog. Drop its baseline rather than let a scrub
      // raise a spinner over a film that is fine.
      stallRef.current = forgetStallSample(stallRef.current)
    } catch {
      /* not seekable yet */
    }
    publishPositionRef.current(sec)
  }
  /** The element settled — issue whatever the hand asked for meanwhile. */
  const drainScrubSeek = () => {
    const decided = nextScrubSeek({
      seeking: false,
      pendingSec: pendingScrubSeekRef.current,
      requestSec: null,
    })
    pendingScrubSeekRef.current = decided.pendingSec
    if (decided.seekSec != null) applySeekRef.current(decided.seekSec)
  }
  useEffect(() => {
    if (seekNonce == null || seekTarget == null) return
    const video = videoRef.current
    // Deliberately NOT gated on `slaved`: in the standalone arrangement this is
    // the only thing that moves the picture, and a ruler or chip click that
    // moved the playhead but not the frame would leave the two contradicting
    // each other on screen.
    if (!video) return
    // AQU-2253: an imported film cut into pieces goes to the piece under the
    // timeline's second, not to that second of the film.
    playheadSecRef.current = Math.max(0, seekTarget)
    const pieces = filmPiecesRef.current
    const sec = pieces && pieces.length > 0
      ? (filmMomentAt(pieces, Math.max(0, seekTarget))?.sec ?? Math.max(0, seekTarget))
      : Math.max(0, seekTarget)
    // AQU-646 stage 5: NEVER TWO SEEKS IN FLIGHT.
    //
    // Dragging the playhead asks the picture to move continuously, and hls.js
    // has a documented way of dying under that — `useHlsVideo`'s own header
    // says it "stops producing frames without firing an event" after a burst.
    // So while the element is still seeking the newest target is held, and the
    // `seeked` below issues it. The trailing edge needs no timer: the last
    // place the hand asked for is the one sitting in `pendingScrubSeekRef`.
    //
    // This guards EVERY seek, not just a scrub — the playback bar's own
    // scrubber fires an uncapped stream of them too, and it costs nothing here.
    // AQU-2253 (review, Nov 9): a seek asked for, even one held back, is not
    // a seek stuck (`watchSeek`).
    seekAskedAtRef.current = Date.now()
    const decided = nextScrubSeek({
      seeking: video.seeking,
      pendingSec: pendingScrubSeekRef.current,
      requestSec: sec,
    })
    pendingScrubSeekRef.current = decided.pendingSec
    if (decided.seekSec == null) {
      // Still say where we are GOING, or the head sits on the old frame's
      // position for as long as the pipeline takes.
      publishPositionRef.current(sec)
    } else {
      applySeekRef.current(decided.seekSec)
    }

    // AQU-1117: "Play from this cue" — this seek asked for the film as well as
    // the frame. Issued AFTER the seek above so `requestPlayWhenReady` sees an
    // element that is either already at the cue or still seeking to it; either
    // way the first frame it starts on is the cue's, which is what separates
    // this from a play command sent from the press site.
    //
    // Deliberately NOT a toggle. Pressing the button on a second cue while the
    // film runs must jump and keep running, and a toggle would stop it.
    // Standalone only (a slaved picture is the queue's to command), and never
    // while the recorder holds the floor — `suspended`'s own watchdog would
    // pause it back within 250ms, which is 250ms of the film in the take.
    if (!seekWantsPlayRef.current || slaved || suspended) return
    wantPlayRef.current = true
    stallRef.current = IDLE_STALL_STATE
    setNotArriving(false)
    requestPlayWhenReady(video)
    // The NONCE is the command: re-running on `slaved`, `suspended` or the
    // stable play helper would replay a seek the user made long ago.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce, seekTarget])

  // THE FILM TAKES THE FLOOR WHEN IT STARTS (2026-09-30), in the standalone
  // arrangement, where it is the transport: a take playing on a waveform or a
  // chip's preview stops, and the next thing to start stops the film. The play
  // queue has done this since 09-29; the film did not, so a take went on
  // sounding under it (found in the throttled browser pass). A SLAVED picture
  // never claims — the queue it follows already holds the floor, and a claim
  // here would pause that queue and, through it, the picture itself.
  // `pause` goes through the registered controller, so a claim stops the film
  // exactly as the bar's pause does (intent, stall ladder, readiness wait).
  const registeredControllerRef = useRef<VideoController | null>(null)
  const [filmAudio] = useState<ActiveAudioController>(() => ({
    isPlaying: () => {
      const video = videoRef.current
      return Boolean(video && !video.paused)
    },
    play: async () => { registeredControllerRef.current?.play() },
    pause: () => { registeredControllerRef.current?.pause() },
  }))
  useEffect(() => {
    // Slaved, or gone: never the floor-holder.
    if (slaved) clearActiveAudioIf(filmAudio)
    return () => clearActiveAudioIf(filmAudio)
  }, [slaved, filmAudio])

  // Round 5: the playback bar has to DRIVE the picture it reports, so the pane
  // registers a controller reading the element live. Registered only in the
  // STANDALONE arrangement — a slaved picture is the queue's to command, and a
  // second driver would fight it.
  useEffect(() => {
    if (slaved) return
    const controller: VideoController = {
      play: () => {
        const video = videoRef.current
        if (!video) return
        wantPlayRef.current = true
        stallRef.current = IDLE_STALL_STATE
        setNotArriving(false)
        requestPlayWhenReady(video)
      },
      pause: () => {
        wantPlayRef.current = false
        stallRef.current = IDLE_STALL_STATE
        // Also abandons a readiness wait: a press during the spinner has to
        // mean "stop waiting", or the only way out of it is to sit through it.
        cancelPendingPlay()
        videoRef.current?.pause()
      },
      isPaused: () => videoRef.current?.paused ?? true,
      seek: (sec) => {
        const video = videoRef.current
        if (!video) return
        const at = Math.max(0, sec)
        try {
          video.currentTime = at
          // The prop-seek path stamps this and this one did not, so the slaved
          // arrangement's seek-storm guard had a blind spot on bar scrubs.
          lastSeekAtRef.current = Date.now()
          prevTickRef.current = null
          stallRef.current = forgetStallSample(stallRef.current)
        } catch {
          /* not seekable yet */
        }
        publishPositionRef.current(at)
      },
      setRate: (rate) => {
        const video = videoRef.current
        if (video) video.playbackRate = rate
      },
      // The bar's volume, kept as the bar's; the effect above sets the
      // element from it and the film row's level.
      setVolume: (volume) => setVideoVolume(volume),
    }
    setVideoController(controller)
    registeredControllerRef.current = controller
    return () => {
      clearVideoControllerIf(controller)
      if (registeredControllerRef.current === controller) registeredControllerRef.current = null
    }
  }, [slaved, requestPlayWhenReady, cancelPendingPlay])

  // Space from the timeline. Only in the STANDALONE arrangement: when the queue
  // is the transport it owns play/pause, and two writers would fight. Toggling
  // against the element's own `paused` means the app and the picture's native
  // controls can never disagree about what "pause" meant.
  const toggleNonce = togglePlay?.nonce
  useEffect(() => {
    if (toggleNonce == null || slaved) return
    const video = videoRef.current
    if (!video) return
    // Space during a readiness wait CANCELS it. The element is still `paused`
    // throughout that wait, so without this the press would re-arm the gate and
    // the only way to stop a picture you had asked for would be to let it start.
    // Matches the bar's button and the queue's own press-while-loading rule.
    if (pendingPlayRef.current) {
      wantPlayRef.current = false
      cancelPendingPlay()
      return
    }
    // INTENT, NOT THE ELEMENT'S FLAG. A stalled picture has `paused === false`
    // while sounding and showing nothing, so branching on it made the next
    // press PAUSE a thing that was not playing — and the press after that play
    // for another half second. What the transport wants is the honest question.
    if (!wantPlayRef.current || video.paused) {
      wantPlayRef.current = true
      // A press is a fresh start, so it is also a fresh ladder — including for
      // a picture that had run out of attempts.
      stallRef.current = IDLE_STALL_STATE
      setNotArriving(false)
      requestPlayWhenReady(video)
    } else {
      wantPlayRef.current = false
      // Stop waiting AND stop saying we are waiting — a stall reported through
      // `setVideoBuffering` has no pending-play object for `cancelPendingPlay`
      // to find, so the spinner would outlive the press that dismissed it.
      stallRef.current = IDLE_STALL_STATE
      setVideoBuffering(false)
      video.pause()
    }
    // The NONCE is the command; re-running on `slaved` or on either callback
    // would replay a stale press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleNonce])

  // The recorder is open: stop the picture, and keep stopping it. Re-asserted
  // on every tick of `suspended` rather than fired once, because the native
  // controls are right there and a stray click on play mid-take would put the
  // soundtrack straight into the recording.
  useEffect(() => {
    if (!suspended) return
    const video = videoRef.current
    if (!video) return
    wantPlayRef.current = false
    // A play waiting on a seek must die here too, or it would start the film
    // mid-take the moment the seek landed.
    cancelPendingPlay()
    video.pause()
    const t = window.setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) videoRef.current.pause()
    }, 250)
    return () => window.clearInterval(t)
  }, [suspended, cancelPendingPlay])

  // A new source is a fresh element as far as we're concerned.
  useEffect(() => {
    setAspect(DEFAULT_VIDEO_ASPECT)
    setFailed(false)
    setNeedsGesture(false)
    setNotArriving(false)
    playFailuresRef.current = 0
    prevTickRef.current = null
    lastSeekAtRef.current = null
    // A different film is a different episode: neither the ladder we spent on
    // the last one nor a position we were trying to get back to applies here.
    stallRef.current = IDLE_STALL_STATE
    resumeAtRef.current = null
    // A wait belongs to the element that was open when it started; the new one
    // will never fire that element's events.
    cancelPendingPlay()
  }, [src, cancelPendingPlay])

  // The fallback clock is a module store, so a position left in it would keep
  // re-writing the playhead long after this pane is gone — on another file, or
  // on this one once a take arrives and the queue takes over. Clear it whenever
  // we are not the one driving.
  useEffect(() => {
    if (slaved) {
      onVideoTime?.(null)
      onVideoPlaying?.(false)
    }
    return () => {
      onVideoTime?.(null)
      onVideoPlaying?.(false)
    }
  }, [slaved, onVideoTime, onVideoPlaying])

  /**
   * The console seam. `__aqQueueState()` is what ended the last argument about
   * the transport — three confident theories of mine died on one line of Sam's
   * output — and the picture has had no equivalent, which is why this stall got
   * diagnosed twice from code reading and fixed once wrongly.
   *
   * It deliberately reports what the element CLAIMS (`paused`, `readyState`,
   * `networkState`) beside what is actually true (whether the clock and the
   * decoder are moving, and how much is buffered ahead). A stall lives exactly
   * in the gap between those, and the two numbers that close it are Safari's
   * frame counters — frames that stop arriving while `readyState` still claims
   * data IS the wedge — and `videoHeight`, which says whether we are decoding
   * 4K into a pane a few hundred pixels wide.
   */
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return
    const snapshot = () => {
      const video = videoRef.current
      const buffered: [number, number][] = []
      if (video) {
        for (let i = 0; i < video.buffered.length; i += 1) {
          buffered.push([video.buffered.start(i), video.buffered.end(i)])
        }
      }
      const frames = video as
        | (HTMLVideoElement & { webkitDecodedFrameCount?: number; webkitDroppedFrameCount?: number })
        | null
      return {
        src,
        arrangement: slaved ? "slaved" : "standalone",
        player: stream.snapshot(),
        element: video && {
          paused: video.paused,
          ended: video.ended,
          seeking: video.seeking,
          readyState: video.readyState,
          networkState: video.networkState,
          currentTime: video.currentTime,
          duration: video.duration,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          playbackRate: video.playbackRate,
          muted: video.muted,
          volume: video.volume,
          error: video.error ? { code: video.error.code, message: video.error.message } : null,
          buffered,
          decodedFrames: frames?.webkitDecodedFrameCount ?? null,
          droppedFrames: frames?.webkitDroppedFrameCount ?? null,
        },
        pane: {
          wantPlay: wantPlayRef.current,
          pendingPlay: pendingPlayRef.current != null,
          needsGesture,
          failed,
          playFailures: playFailuresRef.current,
          resumeAt: resumeAtRef.current,
          stall: { ...stallRef.current },
        },
        clock: {
          buffering: getVideoBuffering(),
          playing: getVideoClockPlaying(),
          sec: getVideoClockSec(),
        },
      }
    }
    ;(window as unknown as Record<string, unknown>).__aqVideoState = snapshot
    return () => {
      delete (window as unknown as Record<string, unknown>).__aqVideoState
    }
  }, [src, slaved, stream, needsGesture, failed])

  const targetText = soundingCell?.translated?.trim() ?? ""
  // `effectiveSourceText` is blank for an untranscribed media segment, which is
  // what we want burned over the picture: that cell's stored source value is the
  // import FILENAME, and a caption reading "episode.mp3" is worse than none.
  const sourceText = soundingCell ? effectiveSourceText(soundingCell).trim() : ""
  const showTarget = mode === "target" || mode === "both"
  const showSource = mode === "source" || mode === "both"
  const captionTarget = showTarget ? targetText : ""
  const captionSource = showSource ? sourceText : ""
  const hasCaption = Boolean(captionTarget || captionSource)
  // The caption renders in one of two DOM parents (on the picture, or in the
  // black field below it), so the props travel together rather than being
  // written out twice.
  const captionProps = {
    target: captionTarget,
    source: captionSource,
    sourceDirectionMode,
    targetDirectionMode,
    sourceTextDirection,
    targetTextDirection,
  }

  /** What the element knowing its metadata changes: its shape, its length
   *  (`onVideoDuration`) and a stalled place to resume. `loadedmetadata`, or
   *  the catch-up below when that event came before anyone listened. */
  const takeMetadata = (video: HTMLVideoElement) => {
    metadataTakenRef.current.add(video)
    setMediaEpoch((n) => n + 1)
    // The element now knows its real shape — letterbox against THAT
    // rather than the assumed 16:9.
    const real = intrinsicAspect(video.videoWidth, video.videoHeight)
    if (real != null) setAspect(real)
    onVideoDuration?.(storedSrc, video.duration)
    // A reload or a rebuild left the picture at the start of the film.
    // Put it back where the stall caught it, and start it again if that
    // is still what the transport wants — otherwise recovering from a
    // freeze would cost the user their place.
    const resumeAt = resumeAtRef.current
    if (resumeAt != null) {
      resumeAtRef.current = null
      try {
        video.currentTime = resumeAt
      } catch {
        /* not seekable yet — the watchdog will come round again */
      }
      publishPositionRef.current(resumeAt)
      if (wantPlayRef.current) requestPlay(video)
    }
  }
  const takeMetadataRef = useRef(takeMetadata)
  takeMetadataRef.current = takeMetadata
  // The film bundle's browser pass (Nov 27): a fast or cached film can have
  // its metadata in before React listens to the element — it is made, with
  // its address, while the workspace is still rendering, and a media event
  // on an element not yet on screen reaches no handler. `loadedmetadata`
  // never comes again, so the film's length was never told: the strip and
  // Play ended with the lines, at random. Once the element is on screen, what
  // it already knows is taken as if the event had just come. A slow film
  // (a weak network) still tells it by the event, whenever it arrives.
  useEffect(() => {
    const video = videoRef.current
    if (!video || metadataTakenRef.current.has(video)) return
    if (video.readyState >= HAVE_METADATA) takeMetadataRef.current(video)
  }, [src, loadAttempt, pipeline, youTube, failed])

  if (failed) {
    // The error card renders the same header WITHOUT a mute control, and that
    // absence is deliberately the only gate: a source that will not load has no
    // soundtrack to silence, so the button must not appear beside the reason it
    // failed.
    return (
      <VideoPaneErrorCard
        failure={filmFailure(storedSrc, src, youTube, youTubeErrorCode)}
        onRetry={() => { setFailed(false); setLoadAttempt((n) => n + 1) }}
        onChangeVideo={onChangeVideo}
      />
    )
  }

  const Picture = youTube ? YouTubePicture : "video"
  return (
    <div
      data-testid="tl-video-pane"
      data-video-state={slaved ? "slaved" : "standalone"}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {/* Media redesign, layout: no header row. The panel's strip names it
          and carries its controls, and the film's name is on the top bar's
          Film button. The black field fills everything under the strip, and
          the picture is centred in it at the video's own proportions —
          leftover space becomes cinema bars instead of blank page. */}
      <div
        ref={fieldRef}
        data-testid="video-pane-field"
        className="group relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
      >
      {/* The picture, sized in real pixels so the caption has an edge to anchor
          to. Falls back to a plain 16:9 box before the field has been measured
          (and in any environment without layout, e.g. the test DOM). */}
      <div
        data-testid="video-pane-picture"
        className={cn("relative", picture ? "" : "aspect-video w-full")}
        style={picture ? { width: `${picture.width}px`, height: `${picture.height}px` } : undefined}
      >
        <Picture
          ref={videoRef}
          // The pipeline is part of the identity: switching players has to
          // start from a clean element, never one holding the other's buffer.
          key={`${src}#${loadAttempt}#${pipeline}`}
          // NO `src` WHERE THE STREAMING PLAYER IS DRIVING. It attaches its own
          // buffered source to the element, and an address sitting in `src`
          // beside it is a second source for the same picture.
          src={pipeline === "hls" ? undefined : src || undefined}
          data-testid="video-pane-media"
          data-video-pipeline={pipeline}
          aria-label={t("editor.timeline.videoPaneLinked")}
          className="h-full w-full object-contain"
          playsInline
          preload="metadata"
          // Slaved: a silent picture. Standalone: this IS the player, and it is
          // also the SOURCE AUDIO, so the mute in the corner below silences it.
          // (That button lived on the timeline's Source-audio track until stage
          // 2 made that track cue data, which mutes nothing, and in this pane's
          // header for a day after.) It publishes through the audibility module
          // into the queue store, which reaches the queue's own elements; there
          // are none in this arrangement, so the pane honours the flag directly.
          // (AQU-646, 2026-08-11 / 2026-08-13)
          // AQU-2253: following the recordings it is slaved AND keeps its own
          // sound, which plays straight through with the picture.
          // AQU-2253 (review, Nov 9): unless the uploaded recording is the
          // sound picked; then the film is silent in both timings.
          // AQU-2253 (Sam, Oct 30): an imported film is always silent: its
          // sound is the Source audio row's, by the rules any uploaded
          // recording follows in each timing.
          // AQU-2227 (review, Nov 9): a file that plays its heard lines has
          // only the film to voice the original, imported or linked.
          // AQU-2253 (review, Nov 9): and the bottom strip's mute, which
          // following the recordings is the queue's volume at zero.
          // Sam, Nov 27: and the film row's volume at −∞ (an element's volume
          // alone is ignored on iPhone and iPad).
          muted={(importedFilm && !playsHeardLines) || recordingIsTheSound || !sourceAudible || (followsRecordings && queueVolume === 0) || filmDb === -Infinity}
          // NO NATIVE CONTROLS, in either arrangement (2026-08-14, Sam).
          //
          // The standalone picture used to keep them, on the reasoning that it
          // is the player and therefore needs a transport. It does — but we
          // built that transport: VoicePlaybackBar has play/pause, prev/next
          // line, a seek slider, speed and volume, and routes all of them to
          // this element through the video controller whenever the film owns
          // the file. So the browser's bar was a SECOND set of controls for the
          // same picture, and the two could disagree.
          //
          // What settled it is that its geometry is unknowable. Safari draws a
          // large floating pill, Chrome a slim strip; neither reports its size.
          // Every overlay we own — both caption placements and both control
          // clusters — was landing on top of it or under it, and no arrangement
          // fixes that, because we are laying out against a box whose dimensions
          // another program decides. Accepted losses, all deliberate: fullscreen
          // (nothing does it today; rebuild it here when it is wanted, on the
          // FIELD not the element, or the captions do not come along), AirPlay,
          // and the ±15s skips, which prev/next LINE beats for this work.
          controls={false}
          // A floating window outlives this pane, so it would go on playing,
          // driving nothing, after you navigated away. The recording modal
          // refuses it for the same reason.
          disablePictureInPicture
          // NO `waiting`/`stalled` HANDLERS, and their absence is the fix rather
          // than an oversight. Safari fires neither for the wedge this pane
          // exists to survive, so a stall detector built on them ran never; the
          // watchdog above samples the clock instead and needs nothing from the
          // element beyond the time it is willing to admit to.
          onError={(e) => {
            // The YouTube element keeps the iframe player's error code on its
            // `error`; a <video>'s MediaError codes mean something else.
            const code = youTube
              ? (e.currentTarget as { error?: { code?: unknown } | null }).error?.code
              : undefined
            setYouTubeErrorCode(typeof code === "number" ? code : null)
            setFailed(true)
            // Whatever length we had is no longer trustworthy — a track sized
            // to a video that will not load is worse than one sized to the cues.
            onVideoDuration?.(storedSrc, null)
          }}
          onLoadedMetadata={(e) => takeMetadata(e.currentTarget)}
          onDurationChange={(e) => {
            setMediaEpoch((n) => n + 1)
            onVideoDuration?.(storedSrc, e.currentTarget.duration)
          }}
          onTimeUpdate={
            slaved
              // AQU-2253 (review, Nov 9): the film's second is the clock.
              // AQU-2253 (review 2, Nov 9): …or the queue gave up waiting on
              // it as a line's clock and listens for it while it follows the
              // playhead: heard moving, it is the clock again.
              ? (filmIsClock || filmListenedFor ? (e) => reportFilmClock(e.currentTarget) : undefined)
              : (e) => publishPosition(e.currentTarget.currentTime)
          }
          // Round 6: a seek's own landing. `timeupdate` is silent for the whole
          // duration of a seek, so on a paused film this is the ONLY event that
          // says where the picture actually ended up.
          // The DRAIN runs in both arrangements — a slaved picture is scrubbed
          // through the same nonce path and needs the same protection — while
          // publishing stays standalone-only, as it always was.
          onSeeked={(e) => {
            seekWatchRef.current = IDLE_SEEK_WATCH
            drainScrubSeek()
            if (!slaved) publishPosition(e.currentTarget.currentTime)
          }}
          // Standalone only: the queue is idle here, so it cannot tell the
          // playhead whether anything is running. `ended` is included because
          // it does not imply `pause` on every engine.
          // Mirror the element's own rate so the bar and these native
        // controls always agree — whichever the user reaches for.
        onRateChange={slaved ? undefined : (e) => setVideoRate((e.currentTarget as HTMLVideoElement).playbackRate)}
        // Not volume (Nov 27): the element plays the bar's volume times the
        // film row's level, so reading it back would fold that level into the
        // bar's number. The bar sets its number through the controller.
          onPlay={
            slaved
              ? undefined
              : () => {
                  // A start that worked clears the failure tally. Without this,
                  // two refusals over the life of one src armed the
                  // click-to-start overlay permanently, however well the
                  // picture played afterwards.
                  playFailuresRef.current = 0
                  claimActiveAudio(filmAudio)
                  onVideoPlaying?.(true)
                }
          }
          onPause={slaved ? undefined : () => { clearActiveAudioIf(filmAudio); onVideoPlaying?.(false) }}
          onEnded={slaved ? undefined : () => { clearActiveAudioIf(filmAudio); onVideoPlaying?.(false) }}
        />
        {/* Sam, Oct 5: clicking YouTube's own play button (or anywhere on its
             picture) started only the picture. With the uploaded recording
             chosen, that picture is silent and follows the queue, so nothing
             was heard and the playback bar did not know it was playing. A
             clear layer now takes every click on a YouTube picture and hands
             it to Aquilla's transport, the same toggle as Space and the bar's
             button, so the chosen sound always plays. Sam accepted the cost:
             YouTube's in-picture links (title, "Watch on YouTube") can no
             longer be clicked. It is a pointer convenience only, so it is
             hidden from assistive tech: the playback bar is the control.
             Below the caption (which takes no pointer anyway), the
             click-to-start overlay and the corner menus. A side effect worth
             having: the picture now reports hover, so the corner controls
             appear over it, not only over the black bars. */}
        {youTube && onPictureClick && (
          <div
            aria-hidden
            data-testid="video-pane-youtube-click-layer"
            className="absolute inset-0 z-[5]"
            onClick={onPictureClick}
          />
        )}
        {/* Anchored to the PICTURE, not the black field: the exported video
             has no bars, so this is where the line really lives — and it can
             never drift into a bar as the pane is resized. */}
        {/* i18n-exempt "picture" is a CaptionPlacement token, not copy */}
        {hasCaption && placement === "picture" && <VideoPaneCaption {...captionProps} />}
        {needsGesture && (
          <button
            type="button"
            data-testid="video-pane-play-gesture"
            onClick={() => {
              setNeedsGesture(false)
              playFailuresRef.current = 0
              // ...and a fresh ladder, so a picture that recovers and wedges
              // again gets every rung again rather than none.
              stallRef.current = IDLE_STALL_STATE
              // The click IS the transport asking for it — say so, or a second
              // refusal would find `wantPlayRef` false and never re-offer this.
              wantPlayRef.current = true
              const video = videoRef.current
              // NOT through the readiness gate, deliberately. This overlay only
              // exists because autoplay was refused, and the one thing that
              // gets past that is a play() call inside the click's own task —
              // user activation does not survive being deferred to a `canplay`
              // listener. Waiting here would break the only escape hatch.
              if (video) requestPlay(video)
              // AQU-2253 (review, Nov 9): where the film is the clock the
              // transport paused on the refusal; the click starts both.
              if (filmIsClock && queue.kind === "paused") void resumeQueue()
            }}
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 text-xs font-medium text-white"
          >
            {t("editor.timeline.videoPaneStart")}
          </button>
        )}
        {notArriving && !needsGesture && (
          <div
            role="status"
            data-testid="video-pane-not-arriving"
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/40 px-4 text-center text-xs font-medium text-white"
          >
            {t("editor.timeline.videoPaneNotArriving")}
          </div>
        )}
      </div>
      {/* The other choice: keep the image itself completely clear and put
           the line in the black below it. Anchored to the FIELD, so it
           lands in the bar when there is one. */}
      {/* i18n-exempt "bar" is a CaptionPlacement token, not copy */}
      {hasCaption && placement === "bar" && <VideoPaneCaption {...captionProps} />}
      {/* Bottom right (Sam, 2026-08-18). On the FIELD rather than the picture,
          like the two caption controls above and for the same reason: it keeps
          its corner when the picture is letterboxed down to a small box.
          AQU-1565 follow-up: keyboard focus reveals it too. The sound menu is
          the only way to hear an uploaded recording on a YouTube file, and a
          hover-only corner left a keyboard user tabbing onto an invisible
          control.
          And on a YouTube file with an uploaded recording it stays on screen.
          The YouTube player is a cross-origin frame that swallows the pointer,
          so hovering the picture itself never revealed the corner: only the
          black bars around it did, and the sound menu is the one way to hear
          the recording (browser pass, 2026-10-02). */}
      <div
        data-testid="video-audio-overlay"
        className={cn(
          "absolute bottom-2 right-2 z-30 transition-opacity duration-300",
          modeRevealed || audioMenuOpen || soundMenuOpen || offerSoundSource
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
        )}
      >
        <div className="flex items-center gap-1.5">
          {offerSoundSource && (
            <VideoSoundSourcePicker
              value={playbackSource}
              recordingName={recordingName}
              onChange={chooseSoundSource}
              onOpenChange={setSoundMenuOpen}
            />
          )}
          <VideoAudioPicker
            tracks={stream.audioTracks}
            activeLang={stream.activeAudioLang}
            onChange={chooseAudioLanguage}
            onOpenChange={setAudioMenuOpen}
          />
        </div>
      </div>
      {/* NO MUTE BUTTON ON THE PICTURE. It was here for a few hours on
          2026-08-14 and came straight back off (Sam): the playback bar already
          carries one, and the Source-audio row in the timeline gutter carries
          the matching one beside Target-audio's. A third copy on the film would
          be a third place to look for one piece of state.

          The element still HONOURS the flag — see `muted` above — it just does
          not offer a control for it. Whichever of those two buttons is clicked,
          this picture goes quiet. */}
      <VideoPaneControls
        mode={mode}
        placement={placement}
        revealed={modeRevealed}
        onModeChange={setMode}
        onPlacementChange={setPlacement}
      />
      </div>
    </div>
  )
}
