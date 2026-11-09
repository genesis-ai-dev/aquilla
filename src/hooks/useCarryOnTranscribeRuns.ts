// AQU-2375: carry on a transcription run that a page reload stopped.
//
// The run's record (lib/audio/transcribe-runs.ts) names its file. When that
// file is open and its rows and recordings have loaded, this page claims the
// run and carries it on by itself: no button, as AQU-1917's rule asks. A run
// whose file is not open is said once, in a toast that says where it stopped
// and that it carries on when that file is opened.

import { useEffect, useRef } from "react"
import { getBatchProgress } from "@/lib/audio/batch-progress"
import {
  claimStoredTranscribeRun,
  interruptedTranscribeRuns,
  transcribeRunFits,
  type StoredTranscribeRun,
  type TranscribeRunHandle,
} from "@/lib/audio/transcribe-runs"

/** Wait this long after the open file's rows last changed before carrying a
 *  run on, so a page still settling is not raced. */
export const CARRY_ON_SETTLE_MS = 2_000
/** Look again this often while another transcription is running. */
const BUSY_RETRY_MS = 5_000

/**
 * AQU-2375 (review, Nov 9): may a run be carried on yet? Only once EVERY row of
 * the open file is in, with its recordings. A long file's rows arrive in pages
 * (500, then 2,000 at a time), and "first paint" is the first page: a run
 * carried on then dropped each row not in the store yet, reported them as
 * never reached, and ended its record.
 */
export function carryOnReady(file: {
  /** The first page of rows has painted. */
  firstPaint: boolean
  /** Rows are still arriving. */
  rowsLoading: boolean
  recordingsLoaded: boolean
  heardLinesLoading: boolean
}): boolean {
  return file.firstPaint && !file.rowsLoading && file.recordingsLoaded && !file.heardLinesLoading
}

export interface CarryOnTranscribeRunsArgs {
  projectId: string | null | undefined
  activeFileId: string | null | undefined
  /** True once the open file's rows AND their recordings have loaded: the
   *  rows still to do can only be told from rows with nothing to do then
   *  (`carryOnReady`). */
  ready: boolean
  /** Changes whenever the open file's rows or recordings change. */
  version: unknown
  /**
   * AQU-2375 (review, Nov 9): who is signed in (null = nobody) and the
   * language lane that is open. A run someone else started is left for them,
   * unsaid; a run over takes started in another language waits for that
   * language. Not given: not checked.
   */
  username?: string | null
  lane?: string
  /** Carry the run on in this page. `handle` is this page's claim on it. */
  carryOn: (run: StoredTranscribeRun, handle: TranscribeRunHandle) => void
  /** The run can't be carried on here yet: say where it stopped. Once per run
   *  and reason. "file": its file is not the open one. "lane": its file is
   *  open, in another language than the run's. */
  announce: (run: StoredTranscribeRun, why: "file" | "lane") => void
}

export function useCarryOnTranscribeRuns(args: CarryOnTranscribeRunsArgs): void {
  const { projectId, activeFileId, ready, version, username, lane } = args
  const announced = useRef(new Set<string>())
  const announcedLane = useRef(new Set<string>())
  const handled = useRef(new Set<string>())
  const callbacks = useRef({ carryOn: args.carryOn, announce: args.announce })
  // The latest callbacks, for the effects below (declared first, so it runs
  // before them in the same commit).
  useEffect(() => {
    callbacks.current = { carryOn: args.carryOn, announce: args.announce }
  })

  // Runs whose file is elsewhere: said once, when the project opens.
  useEffect(() => {
    if (!projectId) return
    let gone = false
    void interruptedTranscribeRuns(projectId).then((runs) => {
      if (gone) return
      for (const run of runs) {
        if (run.fileId === activeFileId || announced.current.has(run.id)) continue
        // Someone else's run is theirs to hear about.
        if (transcribeRunFits(run, { username }) === "person") continue
        announced.current.add(run.id)
        callbacks.current.announce(run, "file")
      }
    })
    return () => { gone = true }
    // The open file is read, not watched: switching files must not say it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, username])

  // The open file's runs: carried on once its rows have settled.
  useEffect(() => {
    if (!projectId || !activeFileId || !ready) return
    let gone = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const attempt = async () => {
      if (gone) return
      // One transcription at a time: they share the cancel flag and the banner.
      if (getBatchProgress()?.kind === "transcribe") {
        timer = setTimeout(() => void attempt(), BUSY_RETRY_MS)
        return
      }
      const runs = (await interruptedTranscribeRuns(projectId))
        .filter((r) => r.fileId === activeFileId && !handled.current.has(r.id))
      for (const run of runs) {
        if (gone) return
        // Not this person's, or not this language's: left where it is (and
        // not marked handled, so it is picked up once the language is opened).
        const fits = transcribeRunFits(run, { username, lane })
        if (fits === "person") continue
        if (fits === "lane") {
          if (!announcedLane.current.has(run.id)) {
            announcedLane.current.add(run.id)
            callbacks.current.announce(run, "lane")
          }
          continue
        }
        const handle = await claimStoredTranscribeRun(run.id)
        handled.current.add(run.id)
        if (!handle) continue
        callbacks.current.carryOn(run, handle)
        // One at a time, for the same reason; the next is picked up on the
        // next look.
        return
      }
    }
    timer = setTimeout(() => void attempt(), CARRY_ON_SETTLE_MS)
    return () => {
      gone = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [projectId, activeFileId, ready, version, username, lane])
}
