// AQU-2682: may the signed-in person store this project's source audio?
//
// "Upload a recording to make lines" and attaching media by url both store
// the file's source audio, which the server takes only from someone whose
// access covers every language. The server answers that question itself
// (fetchSourceAudioAccess); the workspace offers the two actions only on its
// yes. Null means "not answered yet": on a slow network, offline, or after a
// failed read, nothing that stores source audio is offered, and the read is
// tried again after a pause and whenever the browser comes back online.
//
// Plain `useState` + a race-guarded `useEffect`, per AD-3 — never `useQuery`.

import { useEffect, useRef, useState } from "react"
import { fetchSourceAudioAccess } from "@/lib/sync/source-audio-access"

/** Pauses between retries of a failed read; the last one repeats. */
export const SOURCE_AUDIO_ACCESS_RETRY_MS: readonly number[] = [3_000, 10_000, 30_000, 60_000]

export function useSourceAudioAccess(args: {
  projectId: string | null | undefined
  /** Any file of the project: its sync token carries the project's grants. */
  fileId: string | null | undefined
  getToken: (fileId: string) => Promise<string | null>
  /** False when the answer cannot matter (below Project Lead). */
  enabled: boolean
}): boolean | null {
  const { projectId, getToken, enabled } = args
  const [answer, setAnswer] = useState<{ projectId: string; covers: boolean } | null>(null)
  // The file only picks the token; switching files must not re-ask.
  const fileIdRef = useRef(args.fileId)
  useEffect(() => { fileIdRef.current = args.fileId })
  const hasFile = Boolean(args.fileId)

  useEffect(() => {
    if (!enabled || !projectId || !hasFile) return
    let live = true
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false

    const ask = () => {
      const fileId = fileIdRef.current
      if (!live || inFlight || !fileId) return
      if (timer) { clearTimeout(timer); timer = null }
      inFlight = true
      fetchSourceAudioAccess({ projectId, fileId, getToken })
        .then((covers) => {
          if (live) setAnswer({ projectId, covers })
        })
        .catch(() => {
          if (!live) return
          const pause = SOURCE_AUDIO_ACCESS_RETRY_MS[Math.min(attempt, SOURCE_AUDIO_ACCESS_RETRY_MS.length - 1)]!
          attempt += 1
          timer = setTimeout(ask, pause)
        })
        .finally(() => { inFlight = false })
    }

    ask()
    window.addEventListener("online", ask)
    return () => {
      live = false
      if (timer) clearTimeout(timer)
      window.removeEventListener("online", ask)
    }
  }, [enabled, projectId, hasFile, getToken])

  // Another project's answer, or one given while the question did not apply,
  // is never this project's.
  return enabled && answer && answer.projectId === projectId ? answer.covers : null
}
