/**
 * edit_tool on the client: change an installed extension by prompt, "Heal it"
 * after a runtime error, or rebuild it for the current bridge API. Same loop
 * as a build (model → lint → sandboxed smoke → ≤2 repairs) with the current
 * version as the base; a passing result is saved as a new version
 * (origin "edit"), so attribution and revert keep working per version.
 */

import { useCallback, useState } from "react"
import { runBuildFlow, type BuildPhase } from "@/lib/tools/build-flow"
import { runToolSmoke } from "@/lib/tools/smoke"
import { buildToolAttempt, saveToolVersion, type ToolDetail } from "@/lib/tools/tools-api"

export interface EditToolState {
  busy: boolean
  phase: BuildPhase | null
  error: string | null
  run: (tool: ToolDetail, request: string) => Promise<ToolDetail | null>
}

/** The builder request a "Heal it" click sends. */
export function healRequest(errorMessage: string): string {
  return `Fix this runtime error without changing what the extension does or how it looks:\n${errorMessage}`
}

export function useEditTool(projectId: string, jwt: string | null): EditToolState {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<BuildPhase | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (tool: ToolDetail, request: string): Promise<ToolDetail | null> => {
      if (!jwt) return null
      setBusy(true)
      setError(null)
      try {
        const result = await runBuildFlow(
          request,
          {
            attempt: (body) => buildToolAttempt(jwt, projectId, body),
            smoke: (source, manifest) => runToolSmoke(source, manifest),
            onPhase: setPhase,
          },
          { source: tool.source, manifest: tool.manifest },
        )
        if (!result.ok || !result.source || !result.manifest) {
          setError(result.failures[result.failures.length - 1] ?? "the builder failed")
          return null
        }
        return await saveToolVersion(jwt, projectId, tool.id, {
          source: result.source,
          manifest: result.manifest,
          origin: "edit",
          buildMeta: { request, model: result.model, attempts: result.attempts, cost: result.cost, fromVersion: tool.currentVersion },
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setBusy(false)
      }
    },
    [jwt, projectId],
  )
  return { busy, phase, error, run }
}
