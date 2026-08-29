/**
 * react-loop.ts — the server-side react watcher
 * (docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md §v3).
 *
 * Premise from the design session: "anytime you have human expert data
 * injected, there are implications of that." So for each project with
 * `agentMode.react` on, walk the append-only `events` log past a per-project
 * cursor, keep only HUMAN expert input, group it by file, and start ONE
 * contextual run per qualifying file with an auto-steering direction naming
 * the trigger.
 *
 * A reaction is a THREAD, not a notification. Three anti-noise gates, all of
 * them cheap and all of them checked before any model budget is committed:
 *
 *   • DEBOUNCE   — an event is invisible until it is REACT_DEBOUNCE_MS old, so
 *                  a translator mid-paragraph is not reacted to keystroke by
 *                  keystroke. The cursor stops at the debounce boundary, never
 *                  past it, so those events are simply seen on the next sweep.
 *   • ONE OPEN   — a file with an active contextual run is skipped; the run
 *                  that is already there is the reaction.
 *   • COOLDOWN   — REACT_COOLDOWN_MS between reactions on the same file.
 *
 * Two drivers share this module: the 5-minute cron (`runReactSweep`, wrapped
 * in try/catch by the caller — it must never fail the cron) and the manual
 * "check for updates now" route (`reactCheckProject`). Starting a run is
 * injected as `deps.startRun` rather than imported, because the starter lives
 * in routes/contextual.ts next to the tick loop it kicks; importing it here
 * would make that module and this one mutually recursive.
 */

import type { AquillaDb } from "../../../db/shim/postgres"
import type { Env } from "../types"
import {
  loadProjectSettings,
  patchProjectSettingsShared,
} from "../../../db/shared/projects"
import {
  AGENT_REACT_STATE_KEY,
  agentReactStateValue,
  readAgentMode,
  readAgentReactState,
  type AgentReactState,
  type AgentScope,
} from "./agent-mode"
import { appendMessage, touchThread } from "./team-channel"
import { ensureRunThread } from "./team-ingest"
import {
  groupByFile,
  NON_DISCOURSE_KINDS,
  readActiveRunFiles,
  readExpertEvents,
  readFileKinds,
  REACT_MAX_EVENTS_PER_SWEEP,
  type ExpertEventRow,
} from "./react-signals"

/** How old an event must be before the watcher will act on it. Long enough
 *  that a burst of commits from one editing session lands as ONE reaction. */
export const REACT_DEBOUNCE_MS = 60_000
/** Minimum gap between two reactions on the same file. */
export const REACT_COOLDOWN_MS = 10 * 60_000
/** First sweep of a newly-switched-on project looks back this far instead of
 *  reacting to the project's entire history. */
export const REACT_INITIAL_LOOKBACK_MS = 60 * 60_000
/** Projects one cron sweep will visit. */
export const REACT_MAX_PROJECTS_PER_SWEEP = 10
/** Reactions one project may start in a single sweep. Files are considered
 *  freshest-first, so the cap drops the stalest signal, not the newest. */
export const REACT_MAX_FILES_PER_SWEEP = 5
/** Canonical refs quoted in the auto-steering direction. */
const REACT_MAX_REFS_IN_DIRECTION = 3

// ── The starter seam ────────────────────────────────────────────────────────

export interface StartReactionRunInput {
  projectId: string
  fileId: string
  /** Most recently edited cell — the first wave starts there. */
  anchorCellId: string | null
  /** Auto-steering direction queued before the first tick reads steering. */
  direction: string
}

export type StartReactionRunResult =
  | { status: "ok"; runId: string; done: Promise<void> }
  | { status: "skipped"; reason: string }

/** Starts a run through the same helper the start route uses, so the active-run
 *  refusal, the durable project concurrency lease and the tick loop all hold. */
export type StartReactionRun = (
  env: Env,
  input: StartReactionRunInput,
) => Promise<StartReactionRunResult>

export interface ReactDeps {
  startRun: StartReactionRun
}

export interface ReactSkip {
  fileId: string | null
  reason: string
}

export interface ReactResult {
  reactions: { fileId: string; runId: string }[]
  skipped: ReactSkip[]
  /** Settles when every run this call started has finished driving. Callers
   *  holding a request-scoped Postgres connection MUST await it. */
  done: Promise<void>
}

// ── Auto-steering ───────────────────────────────────────────────────────────

function refsLabel(refs: string[]): string {
  if (refs.length === 0) return "the edited passages"
  const shown = refs.slice(0, REACT_MAX_REFS_IN_DIRECTION)
  const more = refs.length - shown.length
  return more > 0 ? `${shown.join(", ")} (+${more} more)` : shown.join(", ")
}

/** The direction the reaction run is seeded with. `scope` is the whole point
 *  of the mode dial: "qa" verifies and reports, everything else may redraft. */
export function reactionDirection(
  scope: AgentScope,
  count: number,
  refs: string[],
): string {
  const plural = count === 1 ? "edit" : "edits"
  const trigger = `React to ${count} human ${plural} near ${refsLabel(refs)}`
  return scope === "qa"
    ? `${trigger}: verify and report on the surrounding drafts; do not redraft unless a check fails.`
    : `${trigger}: reassess the surrounding passages and update drafts where the human's changes have implications.`
}

/**
 * Say in the run's own thread why it exists. Best-effort by contract: the
 * reaction is already real and driving, and a channel outage must not undo it.
 */
async function announceReaction(
  db: AquillaDb,
  input: { projectId: string; runId: string; fileId: string; count: number; refs: string[] },
): Promise<void> {
  try {
    const thread = await ensureRunThread(db, {
      projectId: input.projectId,
      runId: input.runId,
      fileId: input.fileId,
    })
    const plural = input.count === 1 ? "edit" : "edits"
    await appendMessage(db, {
      projectId: input.projectId,
      threadId: thread.id,
      author: { kind: "persona", id: "coordinator" },
      bodyKind: "text",
      body: {
        text:
          `Reacting to ${input.count} human ${plural} near ${refsLabel(input.refs)} — ` +
          `re-reading the surrounding passages.`,
      },
    })
    await touchThread(db, thread.id)
  } catch (err) {
    console.warn(`[react] channel note failed for run ${input.runId}:`, err)
  }
}

// ── Cursor persistence ──────────────────────────────────────────────────────

/**
 * Read-modify-write `agentReactState` back into the settings blob.
 *
 * `patchProjectSettingsShared` replaces only the named top-level key, so a
 * concurrent settings edit elsewhere in the blob is preserved; its version
 * guard turns a lost race into `conflict`, which we retry ONCE and then drop.
 * Dropping is safe: the cursor simply does not advance, and the next sweep
 * reconsiders the same window (the per-file cooldown is what stops that
 * turning into a second reaction).
 */
async function persistReactState(
  db: AquillaDb,
  projectId: string,
  state: AgentReactState,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await loadProjectSettings(db, projectId)
    const result = await patchProjectSettingsShared(db, {
      projectId,
      ops: [{ key: AGENT_REACT_STATE_KEY, value: agentReactStateValue(state) }],
      ifMatchVersion: current.version,
      // System-authored: no human pressed anything, and settings.updated_by is
      // informational (no FK), so 0 reads as "the platform did this".
      updatedBy: 0,
    })
    if (result.status === "ok") return true
    if (result.status === "error") {
      console.warn(`[react] cursor write failed for ${projectId}: ${result.message}`)
      return false
    }
  }
  console.warn(`[react] cursor write lost two races for ${projectId} — retrying next sweep`)
  return false
}

/** Forget cooldown stamps for files nothing will look at again, so the blob
 *  cannot grow without bound on a long-lived project. */
function pruneCooldowns(
  lastReactionAt: Record<string, string>,
  now: number,
): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [fileId, at] of Object.entries(lastReactionAt)) {
    const ts = Date.parse(at)
    if (Number.isFinite(ts) && now - ts < REACT_COOLDOWN_MS) kept[fileId] = at
  }
  return kept
}

// ── One project ─────────────────────────────────────────────────────────────

/**
 * Sweep one project once. Never throws — every failure becomes a `skipped`
 * entry or a warning, because both callers (a cron and an HTTP route) must
 * stay up when one project's data is unreadable.
 */
export async function reactCheckProject(
  env: Env,
  projectId: string,
  deps: ReactDeps,
): Promise<ReactResult> {
  const db = env.AQUILLA_PG
  const now = Date.now()
  const reactions: ReactResult["reactions"] = []
  const skipped: ReactSkip[] = []
  const drivers: Promise<void>[] = []
  const settle = (): ReactResult => ({
    reactions,
    skipped,
    done: Promise.allSettled(drivers).then(() => {}),
  })

  const stored = await loadProjectSettings(db, projectId)
  const mode = readAgentMode(stored.settings)
  if (!mode.react) {
    skipped.push({ fileId: null, reason: "react mode is off for this project" })
    return settle()
  }

  const state = readAgentReactState(stored.settings)
  const windowEnd = now - REACT_DEBOUNCE_MS
  const cursor = state.cursor ?? now - REACT_INITIAL_LOOKBACK_MS
  if (windowEnd <= cursor) {
    skipped.push({ fileId: null, reason: "nothing outside the debounce window yet" })
    return settle()
  }

  let rows: ExpertEventRow[]
  try {
    rows = await readExpertEvents(db, projectId, cursor, windowEnd)
  } catch (err) {
    console.warn(`[react] event read failed for ${projectId}:`, err)
    skipped.push({ fileId: null, reason: "event log unreadable" })
    return settle()
  }

  // Everything up to windowEnd has now been CONSIDERED — except when the read
  // was truncated, where only rows strictly older than the last one we saw are
  // safe to consume (rows sharing that millisecond may be beyond the LIMIT).
  const capped = rows.length >= REACT_MAX_EVENTS_PER_SWEEP
  const nextCursor = capped
    ? Math.max(cursor, Number(rows[rows.length - 1]?.server_ts ?? cursor) - 1)
    : windowEnd
  if (capped) {
    console.log(`[react] ${projectId}: event read hit its cap — continuing next sweep`)
  }

  const signals = groupByFile(rows)
  if (signals.length > 0) {
    const [kinds, activeFiles] = await Promise.all([
      readFileKinds(db, projectId, signals.map((s) => s.fileId)),
      readActiveRunFiles(db, projectId),
    ])
    const lastReactionAt = { ...state.lastReactionAt }

    for (const signal of signals) {
      if (reactions.length >= REACT_MAX_FILES_PER_SWEEP) {
        // Deliberately consumed, not deferred: the cursor still advances past
        // these events. A file that keeps receiving edits earns its reaction on
        // the next sweep; holding the cursor back would instead replay the
        // whole window forever whenever a project is busier than the cap.
        skipped.push({ fileId: signal.fileId, reason: "reaction batch limit" })
        continue
      }
      const kind = kinds.get(signal.fileId)
      if (kind === undefined) {
        skipped.push({ fileId: signal.fileId, reason: "file not found or deleted" })
        continue
      }
      if (NON_DISCOURSE_KINDS.has(kind)) {
        skipped.push({ fileId: signal.fileId, reason: "not a discourse file" })
        continue
      }
      if (activeFiles.has(signal.fileId)) {
        skipped.push({ fileId: signal.fileId, reason: "a run is already active on this file" })
        continue
      }
      const previous = Date.parse(lastReactionAt[signal.fileId] ?? "")
      if (Number.isFinite(previous) && now - previous < REACT_COOLDOWN_MS) {
        skipped.push({ fileId: signal.fileId, reason: "cooldown" })
        continue
      }

      let started: StartReactionRunResult
      try {
        started = await deps.startRun(env, {
          projectId,
          fileId: signal.fileId,
          anchorCellId: signal.anchorCellId,
          direction: reactionDirection(mode.scope, signal.count, signal.refs),
        })
      } catch (err) {
        // One unstartable file must not cost the others their turn — or the
        // cursor advance that keeps the sweep from replaying this window.
        console.warn(`[react] start failed for ${projectId}/${signal.fileId}:`, err)
        skipped.push({ fileId: signal.fileId, reason: "start_failed" })
        continue
      }
      if (started.status !== "ok") {
        skipped.push({ fileId: signal.fileId, reason: started.reason })
        continue
      }

      lastReactionAt[signal.fileId] = new Date(now).toISOString()
      reactions.push({ fileId: signal.fileId, runId: started.runId })
      drivers.push(started.done)
      await announceReaction(db, {
        projectId,
        runId: started.runId,
        fileId: signal.fileId,
        count: signal.count,
        refs: signal.refs,
      })
    }
    state.lastReactionAt = pruneCooldowns(lastReactionAt, now)
  }

  state.cursor = nextCursor
  await persistReactState(db, projectId, state)
  return settle()
}

// ── The cron sweep ──────────────────────────────────────────────────────────

/** Live projects with `agentMode.react` on, read off the generated column
 *  (migration 0085) — never by parsing the multi-MB settings blobs. */
async function listReactProjects(db: AquillaDb, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT ps.project_id FROM project_settings ps
         JOIN projects p ON p.id = ps.project_id
        WHERE ps.agent_react
          AND p.is_active AND p.archived_at IS NULL
        ORDER BY ps.project_id ASC
        LIMIT ?`,
    )
    .bind(limit + 1)
    .all<{ project_id: string }>()
  return results.map((row) => row.project_id)
}

export interface ReactSweepResult {
  projects: number
  reactions: { projectId: string; fileId: string; runId: string }[]
  /** Settles when every run this sweep started has finished driving. The cron
   *  MUST keep its Postgres connection alive until then — same contract as
   *  SweepResult in routes/contextual.ts, and for the same reason. */
  done: Promise<void>
}

/**
 * The cron's entry point. Bounded, best-effort and total: one project's bad
 * data or a failed start is logged and the sweep moves on.
 */
export async function runReactSweep(
  env: Env,
  deps: ReactDeps,
  limit = REACT_MAX_PROJECTS_PER_SWEEP,
): Promise<ReactSweepResult> {
  const db = env.AQUILLA_PG
  if (!db) return { projects: 0, reactions: [], done: Promise.resolve() }

  let candidates: string[]
  try {
    candidates = await listReactProjects(db, limit)
  } catch (err) {
    console.warn("[react] candidate query failed:", err)
    return { projects: 0, reactions: [], done: Promise.resolve() }
  }
  if (candidates.length > limit) {
    console.log(
      `[react] more than ${limit} projects have react on — sweeping the first ${limit}`,
    )
    candidates = candidates.slice(0, limit)
  }

  const reactions: ReactSweepResult["reactions"] = []
  const drivers: Promise<void>[] = []
  for (const projectId of candidates) {
    try {
      const result = await reactCheckProject(env, projectId, deps)
      for (const reaction of result.reactions) reactions.push({ projectId, ...reaction })
      drivers.push(result.done)
    } catch (err) {
      console.warn(`[react] sweep failed for ${projectId}:`, err)
    }
  }
  return {
    projects: candidates.length,
    reactions,
    done: Promise.allSettled(drivers).then(() => {}),
  }
}
