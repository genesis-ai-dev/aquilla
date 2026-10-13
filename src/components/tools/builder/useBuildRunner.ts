import { useCallback, useRef, useState } from "react"
import { runBuildFlow, type BuildFlowResult, type BuildPhase } from "@/lib/tools/build-flow"
import { runToolSmoke } from "@/lib/tools/smoke"
import { buildToolAttempt } from "@/lib/tools/tools-api"
import type { ToolManifest } from "../../../../shared/tools/manifest"

export interface BuildRunner {
  phase: BuildPhase | null
  running: boolean
  /** When the current build started (drives the elapsed timer). */
  startedAt: number | null
  /** The request being built (echoed while building). */
  request: string | null
  /** The last failure's technical text, or null. */
  failure: string | null
  /** Build (or, with `base`, change) an extension. Resolves null when the
   *  build was cancelled or failed. */
  run: (request: string, base?: { source: string; manifest: ToolManifest }) => Promise<BuildFlowResult | null>
  /** Stop waiting: the in-flight build's result is ignored. */
  cancel: () => void
  clearFailure: () => void
}

/** The builder loop (model → lint → sandboxed smoke → repair ≤2×) as page state. */
export function useBuildRunner(projectId: string, jwt: string | null): BuildRunner {
  const [phase, setPhase] = useState<BuildPhase | null>(null)
  const [running, setRunning] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [request, setRequest] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const runId = useRef(0)

  const run = useCallback(async (text: string, base?: { source: string; manifest: ToolManifest }) => {
    if (!jwt) return null
    const id = ++runId.current
    setRunning(true)
    setPhase(null)
    setFailure(null)
    setRequest(text)
    setStartedAt(Date.now())
    try {
      const result = await runBuildFlow(
        text,
        {
          attempt: (body) => buildToolAttempt(jwt, projectId, body),
          smoke: (source, manifest) => runToolSmoke(source, manifest),
          onPhase: (p) => {
            if (runId.current === id) setPhase(p)
          },
        },
        base,
      )
      if (runId.current !== id) return null
      if (!result.ok) {
        setFailure(result.failures[result.failures.length - 1] ?? "")
        return null
      }
      return result
    } catch (err) {
      if (runId.current === id) setFailure(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      if (runId.current === id) {
        setRunning(false)
        setStartedAt(null)
      }
    }
  }, [jwt, projectId])

  const cancel = useCallback(() => {
    runId.current++
    setRunning(false)
    setPhase(null)
    setStartedAt(null)
  }, [])

  const clearFailure = useCallback(() => setFailure(null), [])

  return { phase, running, startedAt, request, failure, run, cancel, clearFailure }
}
