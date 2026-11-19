// The Transcribe lens wakes the speech model its rows will use as the view
// opens, so the first transcription does not sit through a cold start (CTC
// waited ~100 s in Modal's GPU queue on 2026-10-27, and timed out once). While
// the model wakes, the toolbar says so and counts the seconds, and a row asked
// to run meanwhile says it is waiting for the model rather than just spinning.
//
// Which model: whatever the lens's Fast / Smart choice runs for this file
// (transcribe-speed.ts). Whisper and Qwen need no wake-up. Zero-shot is the
// expensive one, so it is only woken when Smart is the person's own pick.

import { useEffect, useState } from "react"
import type { FrontierSession } from "@/lib/frontier/types"
import { usesHostedTranscription } from "@/lib/audio/transcription-preference"
import { fetchOmniStatus, warmOmni, WARMUP_CAP_MS, WARMUP_POLL_MS, type OmniModelName } from "@/lib/audio/omni-warmup"

/** A typical cold start per model. Paces the bar and the "about N s" hint only:
 *  the fast model restores a snapshot on CPU, CTC queues for a GPU and loads,
 *  zero-shot loads a 30 GB checkpoint. */
export const TYPICAL_START_MS: Record<OmniModelName, number> = { fast: 20_000, ctc: 90_000, zs: 150_000 }
/** How long "ready" stays up before the banner goes. */
const READY_SHOWN_MS = 4000
/** The fast model wakes in seconds, so it is asked about more often. */
const POLL_MS: Record<OmniModelName, number> = { fast: 1500, ctc: WARMUP_POLL_MS, zs: WARMUP_POLL_MS }

export type SpeechModelState =
  | { kind: "hidden" }
  | { kind: "starting"; since: number; model: OmniModelName }
  | { kind: "ready"; model: OmniModelName }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `model`: the Omnilingual model to wake, or null when the lens needs none. */
export function useSpeechModelWarmup(session: FrontierSession | null, projectId: string, model: OmniModelName | null): SpeechModelState {
  const [state, setState] = useState<SpeechModelState>({ kind: "hidden" })
  const jwt = session?.jwt
  const hosted = usesHostedTranscription(session, projectId)
  useEffect(() => {
    if (!model || !jwt || !hosted) return
    let live = true
    void (async () => {
      const first = await fetchOmniStatus(jwt, projectId, model).catch(() => null)
      // No answer, or already up: nothing to show. The run itself still waits.
      if (!live || !first || first.state === "ready") return
      // A warm-up spends a little compute; one already starting needs none.
      if (first.state === "cold") await warmOmni(jwt, projectId, model)
      if (!live) return
      setState({ kind: "starting", since: Date.now(), model })
      const deadline = Date.now() + WARMUP_CAP_MS
      while (live && Date.now() < deadline) {
        await sleep(POLL_MS[model])
        const status = await fetchOmniStatus(jwt, projectId, model).catch(() => null)
        if (!live) return
        if (status?.state === "ready") {
          setState({ kind: "ready", model })
          await sleep(READY_SHOWN_MS)
          break
        }
      }
      if (live) setState({ kind: "hidden" })
    })()
    return () => { live = false }
  }, [model, jwt, hosted, projectId])
  // A state left over from another model (the person switched Fast / Smart)
  // is not this model's: it reads as hidden until this model reports.
  return model && state.kind !== "hidden" && state.model === model ? state : { kind: "hidden" }
}
