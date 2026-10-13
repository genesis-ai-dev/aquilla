/**
 * Smart Extensions builds that outlive the page. A build can take minutes,
 * so it runs here — app-level, one per project — not in a component: the user
 * can leave the extensions page and keep working, and BuildJobNotifier tells
 * them when it's ready. The page reads the same state when they come back.
 * (In-memory: a reload ends the build.)
 */

import { useSyncExternalStore } from "react"
import type { ToolManifest } from "../../../shared/tools/manifest"
import { runBuildFlow, type BuildPhase } from "./build-flow"
import { runToolSmoke } from "./smoke"
import { buildToolAttempt } from "./tools-api"

export interface BuildCandidate {
  /** The user's own words (null for a ready-made starter). */
  request: string | null
  source: string
  manifest: ToolManifest
  origin: "builder" | "starter"
  buildMeta?: { request: string; model: string | null; attempts: number; cost: number }
}

export interface BuildJob {
  id: number
  /** What the user typed (shown back while building). */
  words: string
  phase: BuildPhase | null
  startedAt: number
  status: "running" | "done" | "failed"
  failure: string | null
  /** A change to the current candidate ("Change it…"), not a new build. */
  change: boolean
}

export interface ProjectBuildState {
  job: BuildJob | null
  candidate: BuildCandidate | null
}

const EMPTY: ProjectBuildState = { job: null, candidate: null }
const states = new Map<string, ProjectBuildState>()
const listeners = new Set<() => void>()
const finishListeners = new Set<(projectId: string, state: ProjectBuildState) => void>()
const watchers = new Map<string, number>()
let nextId = 1

function set(projectId: string, next: ProjectBuildState) {
  states.set(projectId, next)
  for (const l of listeners) l()
}

export function getBuildState(projectId: string): ProjectBuildState {
  return states.get(projectId) ?? EMPTY
}

export function subscribeBuilds(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Called when a build finishes (done or failed), with whether anyone is looking. */
export function onBuildFinished(listener: (projectId: string, state: ProjectBuildState) => void): () => void {
  finishListeners.add(listener)
  return () => finishListeners.delete(listener)
}

/** The extensions page registers while open, so a finish there needs no toast. */
export function watchBuilds(projectId: string): () => void {
  watchers.set(projectId, (watchers.get(projectId) ?? 0) + 1)
  return () => watchers.set(projectId, Math.max(0, (watchers.get(projectId) ?? 1) - 1))
}

export function isWatched(projectId: string): boolean {
  return (watchers.get(projectId) ?? 0) > 0
}

export function useBuildState(projectId: string): ProjectBuildState {
  return useSyncExternalStore(subscribeBuilds, () => getBuildState(projectId), () => EMPTY)
}

export function setCandidate(projectId: string, candidate: BuildCandidate | null) {
  set(projectId, { ...getBuildState(projectId), candidate })
}

/** Forget a finished or failed build (the failure card's "Edit"). */
export function clearJob(projectId: string) {
  const s = getBuildState(projectId)
  if (s.job?.status !== "running") set(projectId, { ...s, job: null })
}

/** Stop waiting: the in-flight build's result is ignored. */
export function cancelBuild(projectId: string) {
  set(projectId, { ...getBuildState(projectId), job: null })
}

/**
 * Build (or, with the current candidate as base, change) an extension.
 * `words` is what the user typed; `request` what the model receives.
 */
export async function startBuild(
  projectId: string,
  jwt: string,
  opts: { words: string; request: string; change?: boolean },
): Promise<void> {
  const id = nextId++
  const base = opts.change ? getBuildState(projectId).candidate : null
  const job: BuildJob = { id, words: opts.words, phase: null, startedAt: Date.now(), status: "running", failure: null, change: Boolean(base) }
  set(projectId, { ...getBuildState(projectId), job })
  const current = () => getBuildState(projectId).job?.id === id
  const patch = (p: Partial<BuildJob>) => {
    const s = getBuildState(projectId)
    if (s.job?.id === id) set(projectId, { ...s, job: { ...s.job, ...p } })
  }
  let finished: ProjectBuildState | null = null
  try {
    const result = await runBuildFlow(
      opts.request,
      {
        attempt: (body) => buildToolAttempt(jwt, projectId, body),
        smoke: (source, manifest) => runToolSmoke(source, manifest),
        onPhase: (phase) => patch({ phase }),
      },
      base ? { source: base.source, manifest: base.manifest } : undefined,
    )
    if (!current()) return
    if (!result.ok || !result.source || !result.manifest) {
      patch({ status: "failed", failure: result.failures[result.failures.length - 1] ?? "" })
    } else {
      const words = base ? `${base.request ?? ""}\n${opts.words}`.trim() : opts.words
      set(projectId, {
        job: null,
        candidate: {
          request: words,
          source: result.source,
          manifest: result.manifest,
          origin: "builder",
          buildMeta: { request: words, model: result.model, attempts: result.attempts, cost: result.cost },
        },
      })
    }
    finished = getBuildState(projectId)
  } catch (err) {
    if (!current()) return
    patch({ status: "failed", failure: err instanceof Error ? err.message : String(err) })
    finished = getBuildState(projectId)
  }
  if (finished) for (const l of finishListeners) l(projectId, finished)
}

/** Tests only. */
export function resetBuildJobs() {
  states.clear()
  watchers.clear()
  for (const l of listeners) l()
}
