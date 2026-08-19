// The film, inside the recording modal. (AQU-646 stage 5)
//
// THE INVARIANT, and it is a review gate: this file imports NOTHING from
// `@/lib/timeline/video-controller` or `@/lib/timeline/video-clock`. Both are
// hard module singletons — "one picture is on screen at a time". A
// `setVideoController` call from here would displace the playback bar's driver.
// A `setVideoClockSec` call would be far worse: the external dub driver ticks
// off that clock, so every take would fire dub overlays straight into a live
// mic that has echo cancellation off. Publishing nothing is what makes this
// element provably inert — it is a picture and nothing else, and the main
// pane's own video goes on sitting paused behind the dialog exactly as
// `MediaVideoPane`'s `suspended` prop left it.
//
// The same reasoning is why there is no controller plumbing here at all: no
// readiness gate, no rate mirroring, no click-to-start overlay, no `controls`.
// Every one of those is a way for the film to make sound, or to move, at a
// moment nobody asked it to.
//
// WHY THE FILM IS STOPPED DURING RECORDING TODAY, which is the constraint the
// whole surface is shaped by: the mic is opened with `echoCancellation`,
// `noiseSuppression` and `autoGainControl` all FALSE, so an audible film
// records cleanly into the take. A MUTED picture is therefore safe outright,
// and unmuting is a headphones-only studio case that has to say so — hence the
// control at the bottom of the picture and the standing amber warning under it.

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Headphones, VolumeX } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useHlsVideo } from "@/hooks/useHlsVideo"
import { readFilmAudioLanguage } from "@/lib/video/film-audio-tracks"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  setRecordingFilmAudible,
  useRecordingFilmAudible,
} from "@/lib/store/recording-film-audible-pref"

/** `HAVE_METADATA` — the element knows its duration, which is the bar a
 *  `currentTime` write has to clear to land. Below it the write is dropped (or
 *  throws), and the element's own `loadedmetadata` is the only reliable signal
 *  that it can be retried. */
const HAVE_METADATA = 1

/** How far the picture may be from where the countdown says it should be
 *  before the lead-in corrects it. Below this a seek costs more than it buys —
 *  a visible stutter to fix an error nobody can perceive. */
const LEAD_IN_TOLERANCE_SEC = 0.12

/** Corrections stop this long before zero. A seek landing on the operator's
 *  entrance is worse than the drift it removes, and the take's timing does not
 *  depend on the picture anyway — the countdown is the clock. */
const LEAD_IN_SETTLE_SEC = 0.4

/**
 * Where the picture should sit for the line being recorded — pure, so the seek
 * target can be checked without a media pipeline (happy-dom has no decoder).
 *
 * null means "leave the picture where it is": a cell with no start time is an
 * untimed line, and 0 would be a lie about where it belongs rather than an
 * absence of information. Negative and non-finite values are rejected rather
 * than clamped silently — writing either to `currentTime` throws.
 */
export function seekTargetSec(startSec: number | null | undefined): number | null {
  if (startSec == null || !Number.isFinite(startSec)) return null
  return Math.max(0, startSec)
}

export interface RecordingVideoSurfaceProps {
  src: string
  /** Where the line starts in the film. Null for an untimed line. */
  startSec: number | null
  /** True only while the take is actually capturing — the modal passes
   *  `phase === "recording"`. See below. */
  running: boolean
  /**
   * THE ROLLING LEAD-IN (Sam, 2026-08-14). While the countdown runs, the film
   * plays the seconds LEADING UP TO the line and arrives at its first frame as
   * the count reaches zero, so the operator joins the picture the way you join
   * a duet — anticipating an entrance instead of reacting to one after it has
   * gone past. A frozen frame gives you nothing to come in on, and reaction
   * time is the one part of the take-shift problem no code may trim away
   * (Sam's ruling: never trim room noise — a performer's breath is content).
   *
   * `zeroAtMs` is wall-clock `Date.now()` for the countdown's zero. The picture
   * is slaved to THAT, not the other way round: the countdown is the take's
   * clock, and a film that cannot keep up is a reading aid that runs slightly
   * behind, never a take that records at the wrong moment.
   *
   * Null whenever no countdown is running.
   */
  leadIn: { zeroAtMs: number } | null
  /** Nonce-keyed "put the picture on this line", following the `seekSec:
   *  {sec, nonce}` idiom the timeline already uses for the main pane. A nonce
   *  and not a boolean because re-arming the SAME cell — retake, or coming back
   *  to a line you already recorded — must re-fire, which a boolean cannot
   *  express. */
  armNonce: number
  // An `overrun` prop used to draw a red ring round the whole picture when the
  // take ran past the end of the line. Removed 2026-08-16 (Sam: "get rid of
  // it") — the overrun already says so twice, in the duration bar and in the
  // red line under it, and ringing the FILM in red read as something being
  // wrong with the film. The picture is reference, not a status light.
}

export function RecordingVideoSurface({
  src,
  startSec,
  running,
  armNonce,
  leadIn,
}: RecordingVideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audible = useRecordingFilmAudible()
  /**
   * The same player the main pane uses, for the same two reasons: these films
   * are HLS playlists, which no Chromium or Firefox `<video>` can open at all,
   * and left to itself a player climbs to a rendition far larger than this
   * panel. It is a reference picture beside a live mic — the last thing it
   * should be doing is asking a machine to decode 4K while recording.
   *
   * It does NOT breach this file's invariant: the hook touches the element and
   * nothing else. No controller, no clock, nothing published.
   */
  // FOLLOWS the language chosen on the main picture, and offers no control of
  // its own (Sam, 2026-08-18: "the recording model should follow that"). The
  // preference is keyed by the film's address, and this is the same film — so
  // the two agree without either knowing about the other. A team working from
  // Spanish must not hear English the moment they hit record.
  const stream = useHlsVideo(videoRef, src, { audioLanguage: readFilmAudioLanguage(src) })
  const pipeline = stream.pipeline
  /** A source that will not load leaves NOTHING behind — see the render. */
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])

  // The seek is keyed on the nonce ALONE, so the latest target has to arrive
  // through a ref. Declared before the seek effect on purpose: effects run in
  // declaration order within a commit, so a cell change that bumps the nonce
  // and moves the target in the same render is read here first.
  const startSecRef = useRef(startSec)
  useEffect(() => {
    startSecRef.current = startSec
  }, [startSec])
  // Read through a ref for the same reason, and declared before the arm effect
  // so a countdown that starts in the same commit as the nonce bump is visible
  // to it.
  const leadInRef = useRef(leadIn)
  useEffect(() => {
    leadInRef.current = leadIn
  }, [leadIn])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const target = seekTargetSec(startSecRef.current)
    if (target == null) return
    const zeroAtMs = leadInRef.current?.zeroAtMs ?? null

    let playTimer: ReturnType<typeof setTimeout> | null = null
    let rafId: number | null = null
    let cancelled = false

    // Hold the picture where the countdown says it should be. A film opened
    // over the network can take a few hundred milliseconds to actually start,
    // and without this the lead-in arrives late by however long that was — the
    // exact class of drift this whole change exists to remove. Corrections
    // stop before the entrance so no seek ever lands under the operator.
    const track = () => {
      if (cancelled || zeroAtMs == null) return
      const toZeroSec = (zeroAtMs - Date.now()) / 1000
      if (toZeroSec <= LEAD_IN_SETTLE_SEC) return
      const expected = Math.max(0, target - toZeroSec)
      if (Math.abs(video.currentTime - expected) > LEAD_IN_TOLERANCE_SEC) {
        try { video.currentTime = expected } catch { /* not seekable yet */ }
      }
      rafId = requestAnimationFrame(track)
    }

    const apply = () => {
      if (cancelled) return
      if (zeroAtMs == null) {
        try {
          video.currentTime = target
        } catch {
          /* not seekable yet — nothing else is going to move the picture, and a
             frame from the wrong part of the film is better than a thrown error
             in the middle of arming a take */
        }
        return
      }
      // Rewind by however much runway is left, so playing forward from here
      // reaches the line's first frame exactly at zero.
      const remainingSec = Math.max(0, (zeroAtMs - Date.now()) / 1000)
      const from = Math.max(0, target - remainingSec)
      try { video.currentTime = from } catch { /* not seekable yet */ }
      // A line closer to the head of the film than one lead-in has less runway
      // than the countdown is long. Rather than start mid-count and arrive
      // early, the picture WAITS on frame 0 and sets off late enough to still
      // land on zero — a shorter run-up, never a wrong one.
      const beginAtMs = zeroAtMs - (target - from) * 1000
      const begin = () => {
        if (cancelled) return
        const attempt = video.play()
        if (attempt && typeof attempt.catch === "function") attempt.catch(() => {})
        track()
      }
      const delay = beginAtMs - Date.now()
      if (delay <= 0) begin()
      else playTimer = setTimeout(begin, delay)
    }

    if (video.readyState >= HAVE_METADATA) {
      apply()
    } else {
      video.addEventListener("loadedmetadata", apply, { once: true })
    }
    return () => {
      cancelled = true
      if (playTimer) clearTimeout(playTimer)
      if (rafId != null) cancelAnimationFrame(rafId)
      video.removeEventListener("loadedmetadata", apply)
    }
    // The NONCE is the command. Re-running on `startSec` would re-seek the
    // picture out from under a take whenever the caller happened to recompute
    // it; not re-running on an unchanged nonce is what makes a retake re-arm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armNonce])

  // ── The transport, such as it is.
  //
  // The picture is already rolling by the time this runs: the lead-in above
  // started it during the countdown and it crosses the line's first frame at
  // zero, so `running` does not START the film, it INHERITS it. Calling play()
  // on an element that is already playing is a no-op, and it is what covers the
  // arrangements with no lead-in (an untimed line, or a countdown that was
  // never run because the take began some other way).
  //
  // This is a READING AID, not a sync engine. Frame accuracy is neither
  // achievable from here nor the goal; "the picture is roughly where your voice
  // is" is the entire requirement, and anything more would mean mirroring one
  // element's clock onto another, which this codebase has deliberately
  // centralised behind the two singletons named at the top of this file.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!running) {
      // A countdown owns the picture — leave it rolling through the lead-in.
      if (leadIn) return
      // No rewind. The frame the take stopped on is informative — it is the
      // visible evidence of an overrun, and throwing it away to go back to the
      // line's first frame would discard the one thing worth looking at.
      video.pause()
      return
    }
    // Runs ON past the end of the line, on purpose: the client asked to SEE the
    // overrun, and a picture that froze at the out-point would hide exactly the
    // thing it was added to show.
    const attempt = video.play()
    if (attempt && typeof attempt.catch === "function") {
      // Autoplay refusal (Safari's "Never Auto-Play", iOS Low Power Mode) is
      // swallowed on purpose. The take is entirely unaffected — the mic is a
      // separate graph — so the honest outcome is to stay on the line's first
      // frame rather than to interrupt a recording with a prompt.
      attempt.catch(() => {})
    }
  }, [running, leadIn])

  // The element is captured at effect time rather than read from the ref in the
  // cleanup, because React detaches refs before passive cleanups run on an
  // unmount — the ref is already null by the time we would need it. Keyed on
  // `src` as well as mount so a source change pauses the OLD element: `key`
  // rebuilds the node, and an in-flight `play()` promise can resolve onto the
  // detached one and keep it decoding — and, unmuted, SOUNDING — with nothing
  // on screen left to stop it.
  useEffect(() => {
    const video = videoRef.current
    return () => video?.pause()
  }, [src])

  // Not hidden and not a placeholder: gone. An audio-import line has no film,
  // and a line whose film will not load has nothing to show either — in both
  // cases the modal falls back to exactly the markup it had before this
  // existed, rather than reserving a black rectangle for a picture that is
  // never coming.
  if (failed) return null

  return (
    // A full-height CINEMA panel, not a card (Sam's markup, 2026-08-13: the
    // first cut was a 280px thumbnail inside the stage and it read as
    // clutter). The panel is black and the video is object-contain inside it,
    // so the bars above and below fall out of the geometry — they are
    // letterboxing, not wasted space, and nothing is drawn to "fill" them.
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black">
        <video
          ref={videoRef}
          // The pipeline is part of the identity: a switch between players has
          // to start from a clean element.
          key={`${src}#${pipeline}`}
          // NO `src` where the streaming player is driving — it attaches its
          // own buffered source, and an address sitting here beside it would be
          // a second source for the same picture.
          src={pipeline === "hls" ? undefined : src}
          data-testid="rec-video"
          aria-label="Film for the line being recorded"
          className="h-full w-full object-contain"
          // NO `controls`, and this is not a style choice. A scrub bar invites
          // exactly what the main pane's `suspended` watchdog exists to
          // prevent, and a focused native control eats Space AND the arrow keys
          // the modal binds for start/stop and cell navigation.
          playsInline
          preload="metadata"
          // Picture-in-picture would outlive the dialog and go on sounding with
          // nothing on screen to stop it.
          disablePictureInPicture
          tabIndex={-1}
          // A PROP, not an attribute: `muted` as an attribute is only the
          // element's default and does not follow a re-render, which is how a
          // film silenced in the markup ends up audible in a take.
          // MediaVideoPane.test.tsx proves the prop form under happy-dom.
          muted={!audible}
          // No `poster`: the seek above puts the line's OWN first frame up,
          // which is both better than any static image and, being the frame the
          // line starts on, the affordance itself.
          onError={() => setFailed(true)}
        />
        <AppTooltip
          content={
            audible
              ? "The film is playing out loud. Unless you are on headphones it is going into your take — click to mute it."
              : "The film is muted. Unmuting is for headphones only — the mic records with echo cancellation off, so on speakers the film goes into your take."
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="rec-film-audible"
            aria-pressed={audible}
            aria-label={audible ? "Mute the film" : "Unmute the film (headphones only)"}
            // Allowed in BOTH directions at ALL times, mid-take included.
            // Blocking mute would trap someone who can hear bleed starting;
            // blocking unmute would disable the feature at the exact moment it
            // is wanted. The pref is device-wide and sticky, which is why the
            // warning below is permanent rather than a one-time confirmation.
            onClick={() => setRecordingFilmAudible(!audible)}
            // Above the warning below it, which is a full-width box sharing
            // this corner — see the comment there.
            className="absolute bottom-2 right-2 z-20 bg-black/55 text-white/70 backdrop-blur-sm hover:bg-black/70 hover:text-white"
          >
            {audible ? <Headphones className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </Button>
        </AppTooltip>
      {/* Headphones, not Volume2: the countdown-beep toggle in this same
          dialog's header already uses Volume2, and two identical glyphs
          meaning different things in one dialog is a legibility bug. */}
      {/* Permanent while audible, in every phase — not a toast and not tied to
          recording. The consequence is a ruined take, and the setting is sticky
          across cells and across sessions, so the operator has to be able to
          see the state they left themselves in before they press record.
          Overlaid on the lower letterbox bar: amber on cinema black, beside
          the mute button it argues with. */}
      {audible && (
        <p
          data-testid="rec-film-audible-warning"
          // POINTER-EVENTS-NONE, and this is the bug fix, not a nicety (Sam,
          // 2026-08-16: unmuting made the re-mute button very hard to click).
          // This is a full-width box pinned to bottom-0 and it comes AFTER the
          // button in the DOM, so at equal z it painted over the button and ate
          // its clicks. The `pr-12` only keeps the TEXT clear of the button —
          // padding is inside the box, so the box itself still covered it. The
          // warning is passive: nothing in it is clickable, so it has no
          // business intercepting anything.
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-start gap-1.5 bg-gradient-to-t from-black/80 to-transparent py-2 pl-3 pr-12 text-[11px] leading-snug text-amber-400"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            The film is not muted. Use headphones — on speakers it will be recorded into your take.
          </span>
        </p>
      )}
    </div>
  )
}
