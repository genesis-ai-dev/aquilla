// The timeline's playhead and everything that moves with it.
//
// The transports publish a position ~4×/sec (the queue and a film's
// `timeupdate`) or 20×/sec (the virtual clock), and the scrub on every pointer
// move. When those seconds were the editor's own state, each one re-rendered
// the whole editor and every lane in it — well over 100ms a tick on a book with
// takes, which is what made playback and dragging the head stutter. Here they
// re-render this component and nothing else. The editor reads the position
// through `PlayheadStore` when a handler needs it, and subscribes only to what
// changes at a line boundary.

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react"
import type { CellData } from "@/hooks/useCells"
import { queueClockIsFileTime, useQueueForFile } from "@/lib/audio/play-queue"
import { armOutputLatency, displaySec } from "@/lib/audio/output-latency"
import { computeFollowScroll } from "@/lib/timeline/follow"
import { secToPx } from "@/lib/timeline/scale"
import { useVideoClockPlaying, useVideoClockSec } from "@/lib/timeline/video-clock"
import { useVirtualClockPlaying, useVirtualClockSec } from "@/lib/timeline/virtual-clock"
import type { PlayheadStoreInternals } from "./playhead-store"
import { TimelinePlayhead } from "./TimelinePlayhead"
import { useOutputLatency } from "./useOutputLatency"

export interface TimelineTransportClockProps {
  store: PlayheadStoreInternals
  cellIds: ReadonlySet<string>
  cells: readonly CellData[]
  audioFirst: boolean
  /** True from the moment the head is grabbed. The writers stand down. */
  scrubbingRef: RefObject<boolean>
  pxPerSec: number
  follow: boolean
  viewportPx: number
  trackWidthPx: number
  scrollRef: RefObject<HTMLDivElement | null>
  scrollTrackTo: (left: number) => void
}

export function TimelineTransportClock({
  store, cellIds, cells, audioFirst, scrubbingRef, pxPerSec,
  follow, viewportPx, trackWidthPx, scrollRef, scrollTrackTo,
}: TimelineTransportClockProps) {
  const sec = useSyncExternalStore(store.subscribe, store.sec, store.sec)
  const scrubSec = useSyncExternalStore(store.subscribe, store.scrubSec, store.scrubSec)
  const compensating = useSyncExternalStore(store.subscribe, store.compensating, store.compensating)

  const queue = useQueueForFile(cellIds)
  const queueProgress = queue.progress
  const { active: queueActive, playing: queuePlaying } = queue
  // 2026-08-11: the queue's progress is only a FILE position when the master
  // element is the shared source clip. On a take it is a per-take clock that
  // restarts at 0, so writing it here yanked the playhead to zero whenever a
  // take was played from a row's rail.
  const queueSoundingCell = useMemo(
    () => (queue.cellId != null ? cells.find((c) => c.id === queue.cellId) : undefined),
    [cells, queue.cellId],
  )
  // AQU-1747: in FREE TIMING the x-axis is the programme, the verses laid end
  // to end, so a shared source clip's file position is the wrong number there.
  // Each mode is asked for the clock IT draws, and nothing else is accepted.
  const queueClockOnTimeline = audioFirst
    ? queueProgress.programmeClock
    : queueClockIsFileTime(queueSoundingCell)

  // THREE WRITERS, each gated on the others being idle: two writers on one
  // clock is what made the playhead and the film detach. While the head is
  // grabbed the hand owns the clock — a transport's landed position is always
  // behind the pointer, and letting it write yanked the head back to it.
  useEffect(() => {
    if (scrubbingRef.current) return
    if (queueActive && queueClockOnTimeline) store.write(queueProgress.currentTime)
  }, [store, scrubbingRef, queueActive, queueClockOnTimeline, queueProgress.currentTime])
  // A file with a linked video but no audio never starts the queue; the
  // picture plays itself and owns the playhead.
  const videoClockSec = useVideoClockSec()
  const videoPlaying = useVideoClockPlaying()
  useEffect(() => {
    if (scrubbingRef.current) return
    if (!queueActive && videoClockSec != null) store.write(videoClockSec)
  }, [store, scrubbingRef, queueActive, videoClockSec])
  // AQU-646 stage 3h: a file with timings and no master at all.
  const virtualClockSec = useVirtualClockSec()
  const virtualPlaying = useVirtualClockPlaying()
  useEffect(() => {
    if (scrubbingRef.current) return
    if (!queueActive && videoClockSec == null && virtualClockSec != null) store.write(virtualClockSec)
  }, [store, scrubbingRef, queueActive, videoClockSec, virtualClockSec])

  // Parking matters, not just withholding seconds: the playhead extrapolates
  // from its last anchor while playing, so running it against a position
  // nobody updates draws steady, confident, wrong motion.
  const transportPlaying = queueActive
    ? queuePlaying && queueClockOnTimeline
    : videoClockSec != null
      ? videoPlaying
      : virtualPlaying
  const transportRate = queueActive ? queueProgress.rate : 1

  // AQU-646: how far behind the clock your EARS are. COMPENSATION IS A LATCH,
  // NOT A GATE ON `transportPlaying` — that flag dips false at every cold verse
  // gate, and gating on it bounced the head at every verse. Armed on the rising
  // edge of playing, disarmed when the transport goes idle or on a seek.
  const outputLatencySec = useOutputLatency()
  const transportActive = queueActive || videoClockSec != null
  const wasPlayingRef = useRef(false)
  useEffect(() => {
    if (transportPlaying && !wasPlayingRef.current) {
      armOutputLatency()
      store.setCompensating(true)
    }
    wasPlayingRef.current = transportPlaying
  }, [store, transportPlaying])
  useEffect(() => {
    if (!transportActive) store.setCompensating(false)
  }, [store, transportActive])

  // While scrubbing the hand IS the position: latency describes where a sound
  // will be heard, and means nothing for a picture being dragged.
  const shownSec = scrubSec != null ? scrubSec : displaySec(sec, outputLatencySec, compensating)
  useLayoutEffect(() => {
    store.publish(shownSec, transportPlaying)
  }, [store, shownSec, transportPlaying])

  // AQU-646 follow-playhead: page-flip the view when the head nears the right
  // edge (or leaves the left). Reads the element's live scrollLeft — state can
  // lag a programmatic scroll by a frame.
  const scrollTo = useRef(scrollTrackTo)
  useLayoutEffect(() => { scrollTo.current = scrollTrackTo })
  useEffect(() => {
    if (!follow || !transportPlaying) return
    const el = scrollRef.current
    if (!el) return
    const target = computeFollowScroll(secToPx(shownSec, pxPerSec), el.scrollLeft, viewportPx, trackWidthPx)
    if (target != null) scrollTo.current(target)
  }, [follow, transportPlaying, shownSec, pxPerSec, viewportPx, trackWidthPx, scrollRef])

  return (
    <TimelinePlayhead
      currentSec={shownSec}
      pxPerSec={pxPerSec}
      // AQU-646 stage 5: NOT just `transportPlaying`, which lags a pause by a
      // commit or two; while still true the playhead's own rAF would keep
      // extrapolating FORWARD over the scrub position.
      playing={transportPlaying && scrubSec == null}
      rate={transportRate}
    />
  )
}
