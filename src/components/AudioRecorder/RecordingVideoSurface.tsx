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
import { AppTooltip } from "@/components/ui/tooltip"
import {
  setRecordingFilmAudible,
  useRecordingFilmAudible,
} from "@/lib/store/recording-film-audible-pref"
import { cn } from "@/lib/utils"

/** `HAVE_METADATA` — the element knows its duration, which is the bar a
 *  `currentTime` write has to clear to land. Below it the write is dropped (or
 *  throws), and the element's own `loadedmetadata` is the only reliable signal
 *  that it can be retried. */
const HAVE_METADATA = 1

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
   *  `phase === "recording"`, NOT the end of the countdown. See below. */
  running: boolean
  /** Nonce-keyed "put the picture on this line", following the `seekSec:
   *  {sec, nonce}` idiom the timeline already uses for the main pane. A nonce
   *  and not a boolean because re-arming the SAME cell — retake, or coming back
   *  to a line you already recorded — must re-fire, which a boolean cannot
   *  express. */
  armNonce: number
  /** The caller's existing overrun signal: the take has run past the end of the
   *  line. Drawn on the picture rather than raised as its own state, so there is
   *  one overrun in the dialog and not two that can disagree. */
  overrun: boolean
}

export function RecordingVideoSurface({
  src,
  startSec,
  running,
  armNonce,
  overrun,
}: RecordingVideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audible = useRecordingFilmAudible()
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

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const target = seekTargetSec(startSecRef.current)
    if (target == null) return
    const apply = () => {
      try {
        video.currentTime = target
      } catch {
        /* not seekable yet — nothing else is going to move the picture, and a
           frame from the wrong part of the film is better than a thrown error
           in the middle of arming a take */
      }
    }
    if (video.readyState >= HAVE_METADATA) {
      apply()
      return
    }
    video.addEventListener("loadedmetadata", apply, { once: true })
    return () => video.removeEventListener("loadedmetadata", apply)
    // The NONCE is the command. Re-running on `startSec` would re-seek the
    // picture out from under a take whenever the caller happened to recompute
    // it; not re-running on an unchanged nonce is what makes a retake re-arm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armNonce])

  // ── The transport, such as it is.
  //
  // Bound to `running` — the modal's `phase === "recording"` — and deliberately
  // NOT to the end of the countdown: `recorder.start()` is async, so binding to
  // the phase is what makes picture-start equal capture-start. That equality is
  // the whole point of showing the film at all. What you see running past the
  // end of the line is what you recorded running past the end of the line.
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
  }, [running])

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
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden bg-black",
        // The caller's overrun flag, drawn inset so the ring reads against
        // the black rather than being clipped by the dialog's rounding.
        overrun && "ring-2 ring-inset ring-red-500",
      )}
    >
        <video
          ref={videoRef}
          key={src}
          src={src}
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
            className="absolute bottom-2 right-2 z-10 bg-black/55 text-white/70 backdrop-blur-sm hover:bg-black/70 hover:text-white"
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
          className="absolute inset-x-0 bottom-0 z-10 flex items-start gap-1.5 bg-gradient-to-t from-black/80 to-transparent py-2 pl-3 pr-12 text-[11px] leading-snug text-amber-400"
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
