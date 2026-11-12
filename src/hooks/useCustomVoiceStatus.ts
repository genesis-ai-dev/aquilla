// Training state of a custom voice (src/lib/audio/custom-voice.ts), polled once a
// minute until it is ready or failed. Null for any other voice, and before the
// first answer. Ready ids are remembered for the session so cast rows that
// remount don't ask again.
import { useEffect, useState } from "react"
import type { Voice } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { fetchCustomVoiceStatus, type CustomVoiceState } from "@/lib/audio/custom-voice"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"

const POLL_MS = 60_000
const readyVoiceIds = new Set<string>()

export function useCustomVoiceStatus(
  voice: Pick<Voice, "libraryVoiceId" | "customVoice">,
  ctx: { projectId?: string; fileId?: string | null; session?: FrontierSession | null },
): CustomVoiceState | null {
  const voiceId = voice.customVoice ? voice.libraryVoiceId : undefined
  const { projectId, fileId, session } = ctx
  const [state, setState] = useState<{ voiceId: string; state: CustomVoiceState } | null>(null)

  useEffect(() => {
    if (!voiceId || readyVoiceIds.has(voiceId) || !projectId || !fileId || !session) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const status = await fetchCustomVoiceStatus({
          projectId, fileId, voiceId, getSyncToken: audioSyncTokenFetcherForSession(session),
        })
        if (cancelled) return
        setState({ voiceId, state: status.state })
        if (status.state === "ready") readyVoiceIds.add(voiceId)
        if (status.state === "ready" || status.state === "failed") return
      } catch {
        // Transient (offline, worker restart): keep the last known state, ask again.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [voiceId, projectId, fileId, session])

  if (!voiceId) return null
  if (readyVoiceIds.has(voiceId)) return "ready"
  return state?.voiceId === voiceId ? state.state : null
}
