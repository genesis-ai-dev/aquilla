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
  type StoredTranscribeRun,
  type TranscribeRunHandle,
} from "@/lib/audio/transcribe-runs"

/** Wait this long after the open file's rows last changed before carrying a
 *  run on, so a page still settling is not raced. */
export const CARRY_ON_SETTLE_MS = 2_000
/** Look again this often while another transcription is running. */
const BUSY_RETRY_MS = 5_000

export interface CarryOnTranscribeRunsArgs {
  projectId: string | null | undefined
  activeFileId: string | null | undefined
  /** True once the open file's rows AND their recordings have loaded: the
   *  rows still to do can only be told from rows with nothing to do then. */
  ready: boolean
  /** Changes whenever the open file's rows or recordings change. */
  version: unknown
  /** Carry the run on in this page. `handle` is this page's claim on it. */
  carryOn: (run: StoredTranscribeRun, handle: TranscribeRunHandle) => void
  /** The run's file is not the open one: say where it stopped. Once per run. */
  announce: (run: StoredTranscribeRun) => void
}

export function useCarryOnTranscribeRuns(args: CarryOnTranscribeRunsArgs): void {
  const { projectId, activeFileId, ready, version } = args
  const announced = useRef(new Set<string>())
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
        announced.current.add(run.id)
        callbacks.current.announce(run)
      }
    })
    return () => { gone = true }
    // The open file is read, not watched: switching files must not say it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

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
  }, [projectId, activeFileId, ready, version])
}
