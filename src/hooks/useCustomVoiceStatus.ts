// Training state of a custom voice (src/lib/audio/custom-voice.ts), polled once a
// minute until it is ready or failed. Null for any other voice, and before the
// first answer. Ready ids are remembered for the session so cast rows that
// remount don't ask again.
import { useEffect, useMemo, useState } from "react"
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

/**
 * Training state of every custom voice in `voices`, keyed by voice id (absent
 * until known). Same polling and session memory as `useCustomVoiceStatus`, for
 * a list that changes (Make speech's voice chips).
 */
export function useCustomVoiceStates(
  voices: readonly Pick<Voice, "id" | "libraryVoiceId" | "customVoice">[],
  ctx: { projectId?: string; fileId?: string | null; session?: FrontierSession | null },
): ReadonlyMap<string, CustomVoiceState> {
  const { projectId, fileId, session } = ctx
  const pending = voices
    .filter((v) => v.customVoice && v.libraryVoiceId && !readyVoiceIds.has(v.libraryVoiceId))
    .map((v) => `${v.id}=${v.libraryVoiceId}`)
    .join(",")
  const [states, setStates] = useState<ReadonlyMap<string, CustomVoiceState>>(new Map())

  useEffect(() => {
    if (!pending || !projectId || !fileId || !session) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pairs = pending.split(",").map((p) => p.split("=") as [string, string])
    const poll = async () => {
      let open = false
      for (const [id, libraryVoiceId] of pairs) {
        if (readyVoiceIds.has(libraryVoiceId)) continue
        try {
          const status = await fetchCustomVoiceStatus({
            projectId, fileId, voiceId: libraryVoiceId, getSyncToken: audioSyncTokenFetcherForSession(session),
          })
          if (cancelled) return
          if (status.state === "ready") readyVoiceIds.add(libraryVoiceId)
          if (status.state !== "ready" && status.state !== "failed") open = true
          setStates((cur) => new Map(cur).set(id, status.state))
        } catch {
          open = true // transient: ask again
        }
      }
      if (open && !cancelled) timer = setTimeout(() => void poll(), POLL_MS)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pending, projectId, fileId, session])

  return useMemo(() => {
    const out = new Map(states)
    for (const v of voices) if (v.libraryVoiceId && readyVoiceIds.has(v.libraryVoiceId)) out.set(v.id, "ready")
    return out
  }, [states, voices])
}
