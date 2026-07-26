// Contextual translation run store — a MIRROR of a durable server-side run,
// not a driver (contrast batch-completion.ts, which drives its own loop).
//
// State hydrates from a transport snapshot (`fetchSnapshot`) and updates from
// `contextual.*` frames broadcast by the project DO over the existing project
// WebSocket (`applyRemoteFrame`). Play/pause/terminate are transport commands
// against the durable run; the client never sequences spans itself.
//
// Idioms copied from the house patterns:
//   - module pub-sub + useSyncExternalStore (batch-completion.ts)
//   - split state/progress stores so frequent progress frames don't re-render
//     the pill chrome (play-queue.ts QueueState vs QueueProgress)
//   - monotonic runId guard: run ids are server-minted UUIDv7 (time-ordered,
//     so lexicographic compare is chronological). Frames from a superseded
//     run are dropped; frames from a newer run adopt it.
//   - retain-on-failure: a failed run's summary stays visible until dismissed.
//
// The backend Workflow does not exist yet — the default transport stub reports
// `{ available: false }` so the UI renders its idle/setup state.

import { useSyncExternalStore } from "react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextualRunStatus =
  | "idle"
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "parked"
  | "done"
  | "failed"
  | "terminated"

/** Full run snapshot as the transport reports it (GET …/contextual/runs). */
export interface ContextualRunSnapshot {
  runId: string
  fileId: string
  status: ContextualRunStatus
  /** User-facing phase words ("Reading context…"), never spec jargon. */
  phase: string | null
  /** Display label of the span being worked ("LUK 1:1–1:8"). */
  spanLabel: string | null
  done: number
  total: number
  failed: number
  /** Active free-text steering directions (display strings). */
  activeDirections: string[]
}

// ── DO frames (contextual.* on the project WebSocket) ───────────────────────

export interface ContextualRunStateFrame {
  type: "contextual.run.state"
  runId: string
  fileId: string
  status: Exclude<ContextualRunStatus, "idle" | "starting" | "pausing">
  done: number
  total: number
  failed?: number
}

export interface ContextualSceneFrame {
  type: "contextual.scene"
  runId: string
  sceneBriefId: string
  spanLabel: string
  ambiguityCount: number
}

export interface ContextualSpanFrame {
  type: "contextual.span"
  runId: string
  spanLabel: string
  staged: number
  skipped: number
  verdictSummary: string
}

export type ContextualFrame =
  | ContextualRunStateFrame
  | ContextualSceneFrame
  | ContextualSpanFrame

// ── Transport ───────────────────────────────────────────────────────────────

export interface ContextualTransportSnapshot {
  /** False when the backend isn't deployed/configured — UI renders setup state. */
  available: boolean
  /** The live (or last) run for this file, when one exists. */
  run?: ContextualRunSnapshot | null
}

export interface ContextualTransport {
  fetchSnapshot(projectId: string, fileId: string): Promise<ContextualTransportSnapshot>
  start(projectId: string, fileId: string): Promise<{ runId: string }>
  pause(runId: string): Promise<void>
  resume(runId: string): Promise<void>
  terminate(runId: string): Promise<void>
}

/** Default stub until the durable backend (slice D) exists. */
const stubTransport: ContextualTransport = {
  fetchSnapshot: async () => ({ available: false }),
  start: async () => { throw new Error("Contextual drafting is not available yet") },
  pause: async () => { throw new Error("Contextual drafting is not available yet") },
  resume: async () => { throw new Error("Contextual drafting is not available yet") },
  terminate: async () => { throw new Error("Contextual drafting is not available yet") },
}

let _transport: ContextualTransport = stubTransport

export function setContextualTransport(t: ContextualTransport | null): void {
  _transport = t ?? stubTransport
}

// ---------------------------------------------------------------------------
// Split stores: state (pill chrome) vs progress (frequent counters)
// ---------------------------------------------------------------------------

export interface ContextualRunState {
  /** False until a transport snapshot reports the backend is reachable. */
  available: boolean
  runId: string | null
  fileId: string | null
  status: ContextualRunStatus
  phase: string | null
  spanLabel: string | null
  activeDirections: string[]
}

export interface ContextualRunProgress {
  done: number
  total: number
  failed: number
}

const IDLE_STATE: ContextualRunState = {
  available: false,
  runId: null,
  fileId: null,
  status: "idle",
  phase: null,
  spanLabel: null,
  activeDirections: [],
}

const IDLE_PROGRESS: ContextualRunProgress = { done: 0, total: 0, failed: 0 }

let _state: ContextualRunState = IDLE_STATE
let _progress: ContextualRunProgress = IDLE_PROGRESS

const _stateListeners = new Set<() => void>()
const _progressListeners = new Set<() => void>()

function setState(next: ContextualRunState): void {
  _state = next
  for (const l of _stateListeners) l()
}

function setProgress(next: ContextualRunProgress): void {
  _progress = next
  for (const l of _progressListeners) l()
}

export function getContextualRunState(): ContextualRunState { return _state }
export function getContextualRunProgress(): ContextualRunProgress { return _progress }

function subscribeState(l: () => void): () => void {
  _stateListeners.add(l)
  return () => { _stateListeners.delete(l) }
}

function subscribeProgress(l: () => void): () => void {
  _progressListeners.add(l)
  return () => { _progressListeners.delete(l) }
}

export function useContextualRunState(): ContextualRunState {
  return useSyncExternalStore(subscribeState, getContextualRunState, () => IDLE_STATE)
}

export function useContextualRunProgress(): ContextualRunProgress {
  return useSyncExternalStore(subscribeProgress, getContextualRunProgress, () => IDLE_PROGRESS)
}

// ---------------------------------------------------------------------------
// runId guard
// ---------------------------------------------------------------------------

/**
 * True when `incoming` belongs to a run superseded by the one the store
 * mirrors. Run ids are UUIDv7 — time-ordered, so lexicographic comparison is
 * chronological. An id NEWER than the current one is not stale: the server
 * started a fresh run and the store adopts it.
 */
function isStaleRunId(incoming: string): boolean {
  return _state.runId !== null && incoming < _state.runId
}

// User-facing phase words. `ui-jargon-guard.test.ts` bans internal spec ids in
// component strings; these live here so every surface shows the same words.
const PHASE_READING = "Reading context…"
const PHASE_DRAFTING = "Drafting…"

// ---------------------------------------------------------------------------
// Remote frames (project DO → WebSocket → here)
// ---------------------------------------------------------------------------

export function applyRemoteFrame(frame: ContextualFrame): void {
  if (isStaleRunId(frame.runId)) return

  if (frame.type === "contextual.run.state") {
    const sameRun = frame.runId === _state.runId
    // A locally-requested pause ("pausing") sticks over a still-"running"
    // frame from the same run — the workflow hasn't parked yet; flipping the
    // pill back to "running" would make the pause look ignored.
    const status: ContextualRunStatus =
      sameRun && _state.status === "pausing" && frame.status === "running"
        ? "pausing"
        : frame.status
    setState({
      ..._state,
      available: true,
      runId: frame.runId,
      fileId: frame.fileId,
      status,
      // First running frame of a span/run with no phase yet: the analyzer is
      // reading. Terminal/idle-ish states drop the phase readout.
      phase:
        status === "running"
          ? (sameRun ? _state.phase : null) ?? PHASE_READING
          : status === "pausing"
            ? _state.phase
            : null,
      spanLabel: sameRun ? _state.spanLabel : null,
      activeDirections: sameRun ? _state.activeDirections : [],
    })
    setProgress({
      done: frame.done,
      total: frame.total,
      failed: frame.failed ?? (sameRun ? _progress.failed : 0),
    })
    return
  }

  if (frame.type === "contextual.scene") {
    // Scene construed → the performer drafts this span next.
    setState({
      ..._state,
      runId: _state.runId ?? frame.runId,
      spanLabel: frame.spanLabel,
      phase: PHASE_DRAFTING,
    })
    return
  }

  // contextual.span — span finished (staged/skipped); the run moves on.
  setState({
    ..._state,
    runId: _state.runId ?? frame.runId,
    spanLabel: frame.spanLabel,
    phase: PHASE_READING,
  })
}

// ---------------------------------------------------------------------------
// Attach (snapshot hydration)
// ---------------------------------------------------------------------------

let _fetchSeq = 0

/**
 * Hydrate the mirror for a file. Race-guarded: only the latest attach call
 * may write (a stale fetch resolving after a file switch is discarded), and a
 * snapshot never rolls the store back to an older runId than a frame already
 * delivered.
 */
export async function attachContextualRun(projectId: string, fileId: string): Promise<void> {
  const seq = ++_fetchSeq
  let snap: ContextualTransportSnapshot
  try {
    snap = await _transport.fetchSnapshot(projectId, fileId)
  } catch {
    snap = { available: false }
  }
  if (seq !== _fetchSeq) return
  if (!snap.available) {
    setState({ ...IDLE_STATE, fileId })
    setProgress(IDLE_PROGRESS)
    return
  }
  const run = snap.run
  if (!run || isStaleRunId(run.runId)) {
    setState({ ...IDLE_STATE, available: true, fileId })
    setProgress(IDLE_PROGRESS)
    return
  }
  setState({
    available: true,
    runId: run.runId,
    fileId: run.fileId,
    status: run.status,
    phase: run.phase,
    spanLabel: run.spanLabel,
    activeDirections: run.activeDirections,
  })
  setProgress({ done: run.done, total: run.total, failed: run.failed })
}

// ---------------------------------------------------------------------------
// Transport commands (optimistic; frames/acks correct the mirror)
// ---------------------------------------------------------------------------

export async function startContextualRun(projectId: string, fileId: string): Promise<boolean> {
  setState({ ..._state, fileId, status: "starting" })
  setProgress(IDLE_PROGRESS)
  try {
    const { runId } = await _transport.start(projectId, fileId)
    if (!isStaleRunId(runId)) {
      setState({ ..._state, runId, fileId, status: "running", phase: _state.phase ?? PHASE_READING })
    }
    return true
  } catch {
    setState({ ..._state, status: "idle" })
    return false
  }
}

/** Request a pause of the durable run. The workflow parks at its next step
 *  boundary — status shows "pausing" until a `paused` frame confirms. */
export async function requestPauseContextualRun(): Promise<void> {
  const runId = _state.runId
  if (!runId || (_state.status !== "running" && _state.status !== "starting")) return
  setState({ ..._state, status: "pausing" })
  try {
    await _transport.pause(runId)
  } catch {
    // Pause request failed — the run is still going; reflect that honestly.
    setState({ ..._state, status: "running" })
  }
}

export async function resumeContextualRun(): Promise<void> {
  const runId = _state.runId
  if (!runId || _state.status !== "paused") return
  setState({ ..._state, status: "running", phase: _state.phase ?? PHASE_READING })
  try {
    await _transport.resume(runId)
  } catch {
    setState({ ..._state, status: "paused" })
  }
}

/** Terminate is NOT pause: the run is over and cannot resume. */
export async function terminateContextualRun(): Promise<void> {
  const runId = _state.runId
  if (!runId || _state.status === "terminated" || _state.status === "idle") return
  const prior = _state.status
  setState({ ..._state, status: "terminated", phase: null })
  try {
    await _transport.terminate(runId)
  } catch {
    setState({ ..._state, status: prior })
  }
}

/** Dismiss a retained failed/terminated summary back to idle (keeps availability). */
export function dismissContextualRunSummary(): void {
  setState({ ...IDLE_STATE, available: _state.available, fileId: _state.fileId })
  setProgress(IDLE_PROGRESS)
}

/** Test-only: full reset, including the transport. */
export function resetContextualRunStore(): void {
  _transport = stubTransport
  _fetchSeq = 0
  _state = IDLE_STATE
  _progress = IDLE_PROGRESS
}
