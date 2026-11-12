// The Transcribe lens starts the Omnilingual CTC model as the view opens, so
// the first transcription does not sit through a cold GPU start (it waited
// ~100 s in Modal's GPU queue on 2026-10-27, and timed out once). While it
// starts, the toolbar says so, with a bar paced on a typical start that jumps
// to the end when the model is ready.
//
// Only CTC is warmed here. Whisper and Qwen need no warm-up, and zero-shot
// keeps its own warm-up per run (omni-warmup.ts): it is the expensive model,
// and opening a view is not a reason to start it.

import { useEffect, useState } from "react"
import type { FrontierSession } from "@/lib/frontier/types"
import { autoRouteIsOpenRouter } from "@/lib/audio/asr-catalog"
import { hostedLanguageTag } from "@/lib/audio/transcribe-hosted"
import { getTranscriptionModel } from "@/lib/audio/transcription-model"
import { usesHostedTranscription } from "@/lib/audio/transcription-preference"
import { fetchOmniStatus, warmOmni, WARMUP_CAP_MS, WARMUP_POLL_MS } from "@/lib/audio/omni-warmup"

/** A cold CTC start: GPU queue plus an ~8 s model load. Paces the bar only. */
export const TYPICAL_CTC_START_MS = 90_000
/** How long "ready" stays up before the banner goes. */
const READY_SHOWN_MS = 4000

export type SpeechModelState = { kind: "hidden" } | { kind: "starting"; since: number } | { kind: "ready" }

/** Whether a row in this language goes to Omnilingual CTC under the account's choice. */
export function routesToCtc(username: string | undefined, language: string | undefined): boolean {
  const model = getTranscriptionModel(username)
  if (model === "omni-ctc") return true
  return model === "auto" && !autoRouteIsOpenRouter(hostedLanguageTag(language))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function useSpeechModelWarmup(session: FrontierSession | null, projectId: string, needed: boolean): SpeechModelState {
  const [state, setState] = useState<SpeechModelState>({ kind: "hidden" })
  const jwt = session?.jwt
  const hosted = usesHostedTranscription(session, projectId)
  useEffect(() => {
    if (!needed || !jwt || !hosted) return
    let live = true
    void (async () => {
      const first = await fetchOmniStatus(jwt, projectId, "ctc").catch(() => null)
      // No answer, or already up: nothing to show. The run itself still waits.
      if (!live || !first || first.state === "ready") return
      // A warm-up spends a little GPU time; one already starting needs none.
      if (first.state === "cold") await warmOmni(jwt, projectId, "ctc")
      if (!live) return
      setState({ kind: "starting", since: Date.now() })
      const deadline = Date.now() + WARMUP_CAP_MS
      while (live && Date.now() < deadline) {
        await sleep(WARMUP_POLL_MS)
        const status = await fetchOmniStatus(jwt, projectId, "ctc").catch(() => null)
        if (!live) return
        if (status?.state === "ready") {
          setState({ kind: "ready" })
          await sleep(READY_SHOWN_MS)
          break
        }
      }
      if (live) setState({ kind: "hidden" })
    })()
    return () => { live = false }
  }, [needed, jwt, hosted, projectId])
  return needed ? state : { kind: "hidden" }
}

