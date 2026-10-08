/**
 * The builder loop: model attempt → server gates (parse, manifest, lint) →
 * client smoke render → save. Any failed gate sends the error back to the
 * model, at most MAX_REPAIRS times. Dependencies are injected so the loop is
 * unit-testable without a model or a browser frame.
 */

import { lintToolSource, formatLintIssues } from "../../../shared/tools/lint"
import type { ToolManifest } from "../../../shared/tools/manifest"
import type { BuildAttempt } from "./tools-api"
import { formatSmokeErrors, type SmokeResult } from "./smoke"

export const MAX_REPAIRS = 2

export type BuildPhase =
  | { kind: "generating"; attempt: number }
  | { kind: "linting"; attempt: number }
  | { kind: "smoke"; attempt: number }
  | { kind: "repairing"; attempt: number; failure: string }
  | { kind: "done"; attempts: number }
  | { kind: "failed"; attempts: number; failure: string }

export interface BuildFlowDeps {
  attempt: (body: {
    request: string
    attempt: number
    repair?: { previousSource: string; previousManifest: string; failure: string }
  }) => Promise<BuildAttempt>
  smoke: (source: string, manifest: ToolManifest) => Promise<SmokeResult>
  onPhase?: (phase: BuildPhase) => void
}

export interface BuildFlowResult {
  ok: boolean
  source: string | null
  manifest: ToolManifest | null
  attempts: number
  /** Sum of OpenRouter-reported cost across attempts (USD). */
  cost: number
  model: string | null
  failures: string[]
}

export async function runBuildFlow(request: string, deps: BuildFlowDeps): Promise<BuildFlowResult> {
  let repair: { previousSource: string; previousManifest: string; failure: string } | undefined
  const failures: string[] = []
  let cost = 0
  let model: string | null = null

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    deps.onPhase?.(repair ? { kind: "repairing", attempt, failure: repair.failure } : { kind: "generating", attempt })
    const out = await deps.attempt({ request, attempt, ...(repair ? { repair } : {}) })
    cost += out.usage.cost
    model = out.model

    if (!out.ok) {
      failures.push(out.failure)
      repair = { previousSource: out.source ?? "", previousManifest: out.manifestJson ?? "{}", failure: out.failure }
      continue
    }

    // The server already linted; re-lint here so a server/client drift can
    // never let an unlinted source into the smoke frame.
    deps.onPhase?.({ kind: "linting", attempt })
    const lint = lintToolSource(out.source)
    if (!lint.ok) {
      const failure = `Lint errors:\n${formatLintIssues(lint.issues)}`
      failures.push(failure)
      repair = { previousSource: out.source, previousManifest: JSON.stringify(out.manifest, null, 2), failure }
      continue
    }

    deps.onPhase?.({ kind: "smoke", attempt })
    const smoke = await deps.smoke(out.source, out.manifest)
    if (!smoke.ok) {
      const failure = `The smoke render (stub bridge, empty then populated project) threw:\n${formatSmokeErrors(smoke)}`
      failures.push(failure)
      repair = { previousSource: out.source, previousManifest: JSON.stringify(out.manifest, null, 2), failure }
      continue
    }

    deps.onPhase?.({ kind: "done", attempts: attempt + 1 })
    return { ok: true, source: out.source, manifest: out.manifest, attempts: attempt + 1, cost, model, failures }
  }

  const last = failures[failures.length - 1] ?? "unknown failure"
  deps.onPhase?.({ kind: "failed", attempts: MAX_REPAIRS + 1, failure: last })
  return { ok: false, source: null, manifest: null, attempts: MAX_REPAIRS + 1, cost, model, failures }
}
