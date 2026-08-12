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
//   - project/file-scoped monotonic runId guard: run ids are server-minted UUIDv7
//     (time-ordered, so lexicographic compare is chronological). Frames from
//     a superseded run of the attached file are dropped; project fan-out
//     frames for other files never enter this single-editor mirror.
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
  targetLang: string
  status: Exclude<ContextualRunStatus, "idle" | "starting">
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
  spanId?: string
}

export interface ContextualSpanFrame {
  type: "contextual.span"
  runId: string
  spanLabel: string
  staged: number
  skipped: number
  verdictSummary: string
  spanId?: string
}

/** A passage started. Arrives BEFORE any model call for that span, so the UI
 *  can show the lane through the slowest phase instead of showing nothing. */
export interface ContextualSpanStartFrame {
  type: "contextual.span.start"
  runId: string
  fileId: string
  spanId: string
  spanLabel: string
}

export interface ContextualPhaseFrame {
  type: "contextual.phase"
  runId: string
  spanId: string
  spanLabel: string
  phase: ContextualSpanPhase
}

export type ContextualSpanPhase = "reading" | "drafting" | "checking" | "staging"

export type ContextualFrame =
  | ContextualRunStateFrame
  | ContextualSceneFrame
  | ContextualSpanFrame
  | ContextualSpanStartFrame
  | ContextualPhaseFrame

/** One passage in flight. A wave runs several at once, so the pill reports
 *  lanes rather than pretending there is a single current passage. */
export interface ContextualLane {
  spanId: string
  spanLabel: string
  phase: ContextualSpanPhase
}

// ── Transport ───────────────────────────────────────────────────────────────

export interface ContextualTransportSnapshot {
  /** False when the backend isn't deployed/configured — UI renders setup state. */
  available: boolean
  /** The live (or last) run for this file, when one exists. */
  run?: ContextualRunSnapshot | null
}

export interface ContextualTransport {
  fetchSnapshot(projectId: string, fileId: string): Promise<ContextualTransportSnapshot>
  /** `anchorCellId` is where the user is looking — the first wave starts there. */
  start(projectId: string, fileId: string, anchorCellId?: string): Promise<{ runId: string }>
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
  projectId: string | null
  runId: string | null
  fileId: string | null
  status: ContextualRunStatus
  phase: string | null
  spanLabel: string | null
  activeDirections: string[]
  /** Passages currently in flight, oldest first. Empty when nothing is running. */
  lanes: ContextualLane[]
}

export interface ContextualRunProgress {
  done: number
  total: number
  failed: number
}

const IDLE_STATE: ContextualRunState = {
  available: false,
  projectId: null,
  runId: null,
  fileId: null,
  status: "idle",
  phase: null,
  spanLabel: null,
  activeDirections: [],
  lanes: [],
}

const IDLE_PROGRESS: ContextualRunProgress = { done: 0, total: 0, failed: 0 }

let _state: ContextualRunState = IDLE_STATE
let _progress: ContextualRunProgress = IDLE_PROGRESS
/** The file mounted by ContextualRunPillMount. Kept separately because a
 * snapshot request is asynchronous, while WebSocket fan-out starts at once. */
let _attachedFileId: string | null = null
let _attachedProjectId: string | null = null

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
const PHASE_CHECKING = "Checking…"
const PHASE_STAGING = "Saving drafts…"

/** Spec phase → the words a translator sees. Never surface the raw phase. */
const PHASE_WORDS: Record<ContextualSpanPhase, string> = {
  reading: PHASE_READING,
  drafting: PHASE_DRAFTING,
  checking: PHASE_CHECKING,
  staging: PHASE_STAGING,
}

/** Cap on lanes retained for display. A run's width is bounded server-side
 *  well under this; the guard exists so a frame storm can't grow the array
 *  without bound if a close frame is ever dropped. */
const MAX_TRACKED_LANES = 12

/** The phase to show for the run as a whole: the FURTHEST any lane has got.
 *  Showing the least-advanced lane would make a wide wave look stuck on its
 *  slowest passage. */
const PHASE_RANK: ContextualSpanPhase[] = ["reading", "drafting", "checking", "staging"]

function leadPhase(lanes: ContextualLane[]): string | null {
  if (lanes.length === 0) return null
  let best = 0
  for (const lane of lanes) {
    const rank = PHASE_RANK.indexOf(lane.phase)
    if (rank > best) best = rank
  }
  return PHASE_WORDS[PHASE_RANK[best]]
}

// ---------------------------------------------------------------------------
// Remote frames (project DO → WebSocket → here)
// ---------------------------------------------------------------------------

export function applyRemoteFrame(projectId: string, frame: ContextualFrame): void {
  if (projectId !== _attachedProjectId) return
  if (frame.type === "contextual.run.state" || frame.type === "contextual.span.start") {
    if (frame.fileId !== _attachedFileId || isStaleRunId(frame.runId)) return
    if (
      frame.type === "contextual.run.state" &&
      (typeof frame.targetLang !== "string" || frame.targetLang !== "")
    ) return
  } else if (!_state.runId || frame.runId !== _state.runId) {
    // Scene/phase/span frames intentionally omit fileId on the wire. They are
    // safe only after a project/file-scoped frame or snapshot established this run.
    return
  }

  // ── Lane frames (a wave runs several passages at once) ──
  if (frame.type === "contextual.span.start") {
    const sameRun = frame.runId === _state.runId
    if (sameRun && _state.lanes.some((l) => l.spanId === frame.spanId)) return
    const lanes = [
      ...(sameRun ? _state.lanes.slice(-(MAX_TRACKED_LANES - 1)) : []),
      { spanId: frame.spanId, spanLabel: frame.spanLabel, phase: "reading" as const },
    ]
    setState({
      ..._state,
      available: true,
      projectId: _attachedProjectId,
      runId: frame.runId,
      fileId: frame.fileId,
      status: sameRun ? _state.status : "running",
      activeDirections: sameRun ? _state.activeDirections : [],
      lanes,
      spanLabel: frame.spanLabel,
      phase: leadPhase(lanes),
    })
    if (!sameRun) setProgress(IDLE_PROGRESS)
    return
  }

  if (frame.type === "contextual.phase") {
    // A phase for an unknown lane opens it: frames are lossy, and a dropped
    // span.start must not leave live work invisible.
    const known = _state.lanes.some((l) => l.spanId === frame.spanId)
    const lanes = known
      ? _state.lanes.map((l) => (l.spanId === frame.spanId ? { ...l, phase: frame.phase } : l))
      : [
          ..._state.lanes.slice(-(MAX_TRACKED_LANES - 1)),
          { spanId: frame.spanId, spanLabel: frame.spanLabel, phase: frame.phase },
        ]
    setState({ ..._state, lanes, phase: leadPhase(lanes) })
    return
  }

  if (frame.type === "contextual.run.state") {
    const sameRun = frame.runId === _state.runId
    // A locally-requested pause ("pausing") sticks over a still-"running"
    // frame from the same run — the workflow hasn't parked yet; flipping the
    // pill back to "running" would make the pause look ignored.
    const status: ContextualRunStatus =
      sameRun && _state.status === "pausing" && frame.status === "running"
        ? "pausing"
        : frame.status
    // A run that is no longer running has nothing in flight — clear the lanes
    // so a terminal frame can never leave stale passages on screen.
    const lanes = status === "running" || status === "pausing" ? (sameRun ? _state.lanes : []) : []
    setState({
      ..._state,
      available: true,
      projectId: _attachedProjectId,
      runId: frame.runId,
      fileId: frame.fileId,
      status,
      // First running frame of a span/run with no phase yet: the analyzer is
      // reading. Terminal/idle-ish states drop the phase readout.
      phase:
        status === "running"
          ? leadPhase(lanes) ?? (sameRun ? _state.phase : null) ?? PHASE_READING
          : status === "pausing"
            ? _state.phase
            : null,
      spanLabel: sameRun ? _state.spanLabel : null,
      activeDirections: sameRun ? _state.activeDirections : [],
      lanes,
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
    const lanes = frame.spanId
      ? _state.lanes.map((l) =>
          l.spanId === frame.spanId ? { ...l, phase: "drafting" as const } : l,
        )
      : _state.lanes
    setState({
      ..._state,
      spanLabel: frame.spanLabel,
      lanes,
      phase: leadPhase(lanes) ?? PHASE_DRAFTING,
    })
    return
  }

  // contextual.span — this passage finished (staged/skipped); its lane closes.
  const lanes = frame.spanId
    ? _state.lanes.filter((l) => l.spanId !== frame.spanId)
    : _state.lanes.slice(1)
  setState({
    ..._state,
    spanLabel: frame.spanLabel,
    lanes,
    phase: leadPhase(lanes) ?? PHASE_READING,
  })
}

// ---------------------------------------------------------------------------
// Attach (snapshot hydration)
// ---------------------------------------------------------------------------

let _fetchSeq = 0

/**
 * Hydrate the mirror for a file. Race-guarded: only the latest attach call
 * may write (a stale fetch resolving after a project/file switch is discarded), and a
 * snapshot never rolls the store back to an older runId than a frame already
 * delivered.
 */
export async function attachContextualRun(projectId: string, fileId: string): Promise<void> {
  const seq = ++_fetchSeq
  if (_attachedProjectId !== projectId || _attachedFileId !== fileId) {
    _attachedProjectId = projectId
    _attachedFileId = fileId
    // Scope changes synchronously, before the fetch, so a project-wide frame
    // cannot flash another file's run or expose commands for it meanwhile.
    setState({ ...IDLE_STATE, available: _state.available, projectId, fileId })
    setProgress(IDLE_PROGRESS)
  }
  let snap: ContextualTransportSnapshot
  try {
    snap = await _transport.fetchSnapshot(projectId, fileId)
  } catch {
    snap = { available: false }
  }
  if (seq !== _fetchSeq || _attachedProjectId !== projectId || _attachedFileId !== fileId) return
  if (!snap.available) {
    setState({ ...IDLE_STATE, projectId, fileId })
    setProgress(IDLE_PROGRESS)
    return
  }
  const run = snap.run
  if (!run) {
    // A live frame may have raced ahead of an older empty snapshot. It is
    // already scoped to this project/file, so retain it instead of rolling back.
    if (_state.fileId === fileId && _state.runId) return
    setState({ ...IDLE_STATE, available: true, projectId, fileId })
    setProgress(IDLE_PROGRESS)
    return
  }
  if (run.fileId !== fileId) return
  // Same-file frames can race ahead of the snapshot; an older snapshot is
  // stale, but a valid older run on a newly attached project/file is not (the scope
  // reset above cleared the prior file's monotonic guard).
  if (isStaleRunId(run.runId)) return
  setState({
    available: true,
    projectId,
    runId: run.runId,
    fileId: run.fileId,
    status: run.status,
    phase: run.phase,
    spanLabel: run.spanLabel,
    activeDirections: run.activeDirections,
    // Lanes are live-only: the snapshot carries durable state, and passages in
    // flight are not durable. They repopulate from the next frame.
    lanes: run.runId === _state.runId ? _state.lanes : [],
  })
  setProgress({ done: run.done, total: run.total, failed: run.failed })
}

// ---------------------------------------------------------------------------
// Transport commands (optimistic; frames/acks correct the mirror)
// ---------------------------------------------------------------------------

/**
 * Start a run. `anchorCellId` is where the user is looking: the server rotates
 * the first wave to begin there, so the first drafts land on screen rather
 * than at the top of a file the user may be nowhere near.
 */
export async function startContextualRun(
  projectId: string,
  fileId: string,
  anchorCellId?: string,
): Promise<boolean> {
  if (_attachedProjectId !== projectId || _attachedFileId !== fileId) {
    _attachedProjectId = projectId
    _attachedFileId = fileId
    ++_fetchSeq
    setState({ ...IDLE_STATE, available: _state.available, projectId, fileId })
  }
  setState({ ..._state, fileId, status: "starting", lanes: [] })
  setProgress(IDLE_PROGRESS)
  try {
    const { runId } = await _transport.start(projectId, fileId, anchorCellId)
    if (_attachedProjectId === projectId && _attachedFileId === fileId && !isStaleRunId(runId)) {
      setState({ ..._state, projectId, runId, fileId, status: "running", phase: _state.phase ?? PHASE_READING })
    }
    return true
  } catch {
    if (_attachedProjectId === projectId && _attachedFileId === fileId) setState({ ..._state, status: "idle" })
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
    if (_state.runId === runId) setState({ ..._state, status: "running" })
  }
}

export async function resumeContextualRun(): Promise<void> {
  const runId = _state.runId
  if (!runId || _state.status !== "paused") return
  setState({ ..._state, status: "running", phase: _state.phase ?? PHASE_READING })
  try {
    await _transport.resume(runId)
  } catch {
    if (_state.runId === runId) setState({ ..._state, status: "paused" })
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
    if (_state.runId === runId) setState({ ..._state, status: prior })
  }
}

/**
 * Optimistic chip for a just-accepted steering direction: the server confirmed
 * (201) it is queued for the next passage, so it shows immediately; the next
 * snapshot refresh replaces the whole list (and drops it once consumed).
 */
export function noteContextualDirectionQueued(text: string): void {
  if (_state.activeDirections.includes(text)) return
  setState({ ..._state, activeDirections: [..._state.activeDirections, text] })
}

/** Dismiss a retained failed/terminated summary back to idle (keeps availability). */
export function dismissContextualRunSummary(): void {
  setState({
    ...IDLE_STATE,
    available: _state.available,
    projectId: _state.projectId,
    fileId: _state.fileId,
  })
  setProgress(IDLE_PROGRESS)
}

/** Test-only: full reset, including the transport. */
export function resetContextualRunStore(): void {
  _transport = stubTransport
  _fetchSeq = 0
  _attachedFileId = null
  _attachedProjectId = null
  _state = IDLE_STATE
  _progress = IDLE_PROGRESS
}
