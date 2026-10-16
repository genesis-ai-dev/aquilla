/**
 * The per-user edit history — Aquilla's app-wide undo. (AQU-1767; phase 1
 * built the stack for timeline takes, phase 2 makes it app-wide.)
 *
 * WHAT A STEP IS. One thing a person did, with a name they would recognise
 * ("Cut take in two", "Removed a row", "Validated 12 lines"). A step is plain
 * DATA — a `kind` and the values it needs — so it survives a reload. What a
 * kind's undo and redo actually do lives in a HANDLER, registered by whoever
 * owns those writes (the workspace registers most of them). Undo and redo
 * write COMPENSATING events — new events that put the old values back — and
 * never delete or rewrite history, the rule the agent undo follows
 * (src/lib/agent/undo.ts). That keeps undo working offline and in sync: it is
 * just more events in the outbox.
 *
 * WHEN SOMEONE ELSE GOT THERE FIRST. A step stores the state it left behind
 * when the user acted, and its handler checks that state is still there before
 * compensating. If a collaborator (or the user, some other way) changed the
 * same thing since, the step is SKIPPED, says why, and leaves the stack — it
 * would only clobber their work. Skips are kept in a short log the History
 * panel shows.
 *
 * WHEN IT CANNOT BE DONE FROM HERE. A step made in another file is BLOCKED
 * while that file is not open: it stays on the stack and says which file to
 * open. Nothing is lost by switching files. Each language has its own
 * history (see `scopeKey`), so switching language switches history.
 *
 * GROUPS. One action that writes many things (bulk validation, applying a
 * voice to many lines) is ONE step: `withGroup` collects the steps recorded
 * inside it. Undoing a group undoes its parts newest first; parts someone
 * changed since are skipped and the rest still go.
 *
 * SCOPE AND PERSISTENCE. One stack per (project, user). Steps are saved to
 * this browser (IndexedDB, history-store.ts) and come back after a reload; a
 * step recorded in one project is never undone from another, and one account
 * never reads another's.
 */
import { loadHistory, saveHistory, type StoredHistory } from "./history-store"

/** What an undo or redo did. `skipped` is not an error: it is the guard working. */
export type StepOutcome =
  | { kind: "done"; partial?: { skipped: number } }
  | { kind: "skipped"; reason: "changed" | "gone" | "unavailable" }
  | { kind: "blocked"; reason: "elsewhere" }
  | { kind: "failed"; error: unknown }

/** A step as recorded. Plain data: it is saved and read back. */
export interface StepRecord<D = unknown> {
  id: string
  /** Handler key, e.g. "take.trim", "row.remove". */
  kind: string
  data: D
  /** i18n key naming the step, e.g. "editor.history.stepCut". */
  labelKey: string
  /** Values for the label's placeholders. */
  labelParams?: Record<string, string | number>
  /** When the user acted (ms). Decides who owns the shortcut — see arbiter.ts. */
  at: number
  /** The file the step changed, when it changed one: it can only be undone
   *  while that file is open (see `setOpenFileProbe`). */
  fileId?: string | null
  /** That file's name when the step was made, for "open … to undo this". */
  fileName?: string | null
}

/** What `recordStep` takes; `id` and `at` are filled in. */
export type StepInput<D = unknown> = Omit<StepRecord<D>, "id" | "at"> & { at?: number }

export interface StepHandler<D = unknown> {
  undo(data: D): Promise<StepOutcome>
  redo(data: D): Promise<StepOutcome>
}

/** One undo or redo that did not happen, for the History panel. */
export interface SkipLogEntry {
  id: string
  labelKey: string
  labelParams?: Record<string, string | number>
  which: "undo" | "redo"
  reason: "changed" | "gone" | "unavailable" | "failed"
  /** When it was attempted. */
  at: number
}

interface Stacks {
  undo: StepRecord[]
  redo: StepRecord[]
  log: SkipLogEntry[]
}

/** Enough to back out of an afternoon's editing without holding it forever. */
export const HISTORY_LIMIT = 100
const LOG_LIMIT = 30
const GROUP_KIND = "group"

const stacks = new Map<string, Stacks>()
const handlers = new Map<string, StepHandler<never>>()
const listeners = new Set<() => void>()
let activeScope: string | null = null
let activeUser: string | null = null
let busy = false
let openFileProbe: ((fileId: string) => boolean) | null = null
let idCounter = 0

/** Steps recorded while a `withGroup` runs, innermost last. */
const groupBuffers: StepRecord[][] = []

/**
 * One history per project, person and LANGUAGE (Sam, 2026-10-14). Takes, text
 * and votes belong to a language lane, and the workspace reads and writes only
 * the open one, so each language keeps its own undo and redo: Cmd+Z in French
 * undoes French's last step, never a Spanish one, and never waits on one. A
 * step that touches every language (a row, a track, a setting) belongs to the
 * history of the language it was made in. `''` is a lane like any other.
 */
function scopeKey(projectId: string, username: string, lane: string): string {
  return `${projectId}\u0000${username}\u0000${lane}`
}

/** The language each project's history was last opened in, for a step recorded from outside it. */
const laneByProject = new Map<string, string>()

function stacksFor(key: string): Stacks {
  let s = stacks.get(key)
  if (!s) {
    s = { undo: [], redo: [], log: [] }
    stacks.set(key, s)
  }
  return s
}

function newId(): string {
  idCounter += 1
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function emit(): void {
  snapshotCache = null
  for (const fn of listeners) fn()
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Each scope's saved history is read once; this is that read, in flight or done. */
const loaded = new Map<string, Promise<void>>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
const dirtyScopes = new Set<string>()

// Saved at the end of the current task, not after a delay: a reload a moment
// after an action (or an undo) must find the history as it was left, or the
// step is missing, or an undone step is offered again (slow-network pass,
// 2026-10-13). Changes made in the same task still share one write.
function scheduleSave(scope: string): void {
  dirtyScopes.add(scope)
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    for (const key of dirtyScopes) {
      const s = stacks.get(key)
      if (!s) continue
      const [projectId, username, lane = ""] = key.split("\u0000")
      void saveHistory(projectId, username, lane, { undo: s.undo, redo: s.redo, log: s.log })
    }
    dirtyScopes.clear()
  }, 0)
}

/** Read the saved stacks for a scope once, and put them UNDER anything already
 *  recorded this session (the saved steps are older). */
function loadScope(key: string): Promise<void> {
  let pending = loaded.get(key)
  if (!pending) {
    pending = readScope(key)
    loaded.set(key, pending)
  }
  return pending
}

async function readScope(key: string): Promise<void> {
  const [projectId, username, lane = ""] = key.split("\u0000")
  const saved: StoredHistory | null = await loadHistory(projectId, username, lane)
  if (!saved) return
  const s = stacksFor(key)
  const known = new Set([...s.undo, ...s.redo].map((r) => r.id))
  s.undo = [...saved.undo.filter((r) => !known.has(r.id)), ...s.undo].slice(-HISTORY_LIMIT)
  if (s.redo.length === 0) s.redo = saved.redo.filter((r) => !known.has(r.id))
  s.log = [...saved.log, ...s.log].slice(-LOG_LIMIT)
  emit()
}

/** Resolves once the active scope's saved history has been read (tests, and
 *  anything that must not race the load). */
export function historyReady(): Promise<void> {
  return activeScope ? loadScope(activeScope) : Promise.resolve()
}

// ── Scope, handlers, open-file probe ─────────────────────────────────────────

/**
 * Which project, person and language the shortcut and the buttons act for.
 * The workspace sets it when a project opens and whenever the open language
 * changes; `null` when none is open.
 */
export function setHistoryScope(projectId: string | null, username: string | null, lane = ""): void {
  if (projectId) laneByProject.set(projectId, lane)
  const next = projectId && username ? scopeKey(projectId, username, lane) : null
  if (next === activeScope) return
  activeScope = next
  activeUser = username
  emit()
  if (next) void loadScope(next)
}

/**
 * Register what undo and redo mean for some step kinds. Returns the
 * unregister function; the newest registration of a kind wins, so a component
 * that re-registers with fresh closures replaces its earlier one.
 */
export function registerStepKinds(map: Record<string, StepHandler<never>>): () => void {
  const mine = Object.entries(map)
  for (const [kind, handler] of mine) handlers.set(kind, handler)
  return () => {
    for (const [kind, handler] of mine) if (handlers.get(kind) === handler) handlers.delete(kind)
  }
}

/** Whether a file is open (so a step that changed it can be undone now). */
export function setOpenFileProbe(probe: ((fileId: string) => boolean) | null): void {
  openFileProbe = probe
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * Record a step the user just took, in the ACTIVE scope. A new step clears the
 * redo stack, as everywhere: redoing past a fresh edit would replay a branch
 * that no longer exists. Inside `withGroup`, the step joins the group instead.
 */
// Steps recorded when their action STARTED, with the action's own write still
// out: an undo waits for it before running, and a step whose write was refused
// is dropped. Never saved (a promise can't be); after a reload the write has
// long settled.
const pendingWrites = new Map<string, Promise<boolean>>()

/**
 * Record a step. Pass `opts.pending` (resolving true when the action took
 * effect, false when it was refused) to record it the moment the action
 * starts: an Undo pressed while the action is still saving must undo THAT
 * action, not the step before it (slow-network pass, 2026-10-13).
 */
export function recordStep<D>(
  input: StepInput<D>,
  scope?: { projectId: string; username: string },
  opts?: { pending?: Promise<boolean> },
): void {
  // A step recorded from outside the workspace (a settings save) joins the
  // history of the language that project was last open in.
  const key = scope ? scopeKey(scope.projectId, scope.username, laneByProject.get(scope.projectId) ?? "") : activeScope
  if (!key) return
  const record: StepRecord<D> = { ...input, id: newId(), at: input.at ?? Date.now() }
  if (opts?.pending) {
    const pending = opts.pending.catch(() => false)
    pendingWrites.set(record.id, pending)
    void pending.then((ok) => {
      pendingWrites.delete(record.id)
      if (!ok) dropRecord(key, record.id)
    })
  }
  const buffer = groupBuffers[groupBuffers.length - 1]
  if (buffer && key === activeScope) {
    buffer.push(record as StepRecord)
    return
  }
  pushRecord(record as StepRecord, key)
}

/** A recorded step whose action was refused: take it off whichever stack holds it. */
function dropRecord(key: string, id: string): void {
  const s = stacks.get(key)
  if (!s) return
  for (const list of [s.undo, s.redo]) {
    const at = list.findIndex((r) => r.id === id)
    if (at >= 0) {
      list.splice(at, 1)
      scheduleSave(key)
      emit()
      return
    }
  }
}

function pushRecord(record: StepRecord, key: string): void {
  const s = stacksFor(key)
  s.undo.push(record)
  if (s.undo.length > HISTORY_LIMIT) s.undo.splice(0, s.undo.length - HISTORY_LIMIT)
  s.redo = []
  scheduleSave(key)
  if (key !== activeScope) void loadScope(key)
  emit()
}

/**
 * Run `fn` and record every step it records as ONE step named `labelKey`. A
 * group of one keeps its own name unless `alwaysGroup` is set (so "Validated
 * 1 line" never replaces the plainer "Validated a line"). Groups nest: an
 * inner group joins the outer one.
 */
export async function withGroup<T>(
  label: { labelKey: string; labelParams?: Record<string, string | number>; fileId?: string | null; fileName?: string | null },
  fn: () => Promise<T>,
  opts?: { alwaysGroup?: boolean },
): Promise<T> {
  const buffer: StepRecord[] = []
  groupBuffers.push(buffer)
  let result: T
  try {
    result = await fn()
  } finally {
    groupBuffers.pop()
  }
  if (buffer.length === 1 && !opts?.alwaysGroup) {
    recordStep({ ...buffer[0], at: buffer[0].at })
  } else if (buffer.length > 0) {
    recordStep({
      kind: GROUP_KIND,
      data: { steps: buffer },
      labelKey: label.labelKey,
      labelParams: label.labelParams,
      fileId: label.fileId ?? buffer[0].fileId ?? null,
      fileName: label.fileName ?? buffer[0].fileName ?? null,
      at: buffer[buffer.length - 1].at,
    })
  }
  return result
}

/**
 * Record several steps made by one action as ONE step, when the caller already
 * has them all (a synchronous loop). Async work uses {@link withGroup}.
 */
export function recordGroup(
  label: { labelKey: string; labelParams?: Record<string, string | number>; fileId?: string | null; fileName?: string | null },
  parts: ReadonlyArray<StepInput>,
): void {
  if (parts.length === 0) return
  const now = Date.now()
  const steps: StepRecord[] = parts.map((p) => ({ ...p, id: newId(), at: p.at ?? now }))
  recordStep({
    kind: GROUP_KIND,
    data: { steps },
    labelKey: label.labelKey,
    labelParams: label.labelParams,
    fileId: label.fileId ?? steps[0].fileId ?? null,
    fileName: label.fileName ?? steps[0].fileName ?? null,
  })
}

// ── Running ─────────────────────────────────────────────────────────────────

async function runRecord(record: StepRecord, which: "undo" | "redo"): Promise<StepOutcome> {
  // The action is still saving: let it land first, so the undo compensates
  // what really happened (and nothing, if it was refused).
  const pending = pendingWrites.get(record.id)
  if (pending && !(await pending)) return { kind: "skipped", reason: "gone" }
  if (record.kind === GROUP_KIND) return runGroup(record as StepRecord<{ steps: StepRecord[] }>, which)
  const handler = handlers.get(record.kind) as StepHandler<unknown> | undefined
  if (!handler) return { kind: "skipped", reason: "unavailable" }
  try {
    return await (which === "undo" ? handler.undo(record.data) : handler.redo(record.data))
  } catch (error) {
    return { kind: "failed", error }
  }
}

/** A group's parts run newest first on undo, oldest first on redo. Parts that
 *  were changed since are skipped; the group is done if any part was. */
async function runGroup(record: StepRecord<{ steps: StepRecord[] }>, which: "undo" | "redo"): Promise<StepOutcome> {
  const parts = which === "undo" ? [...record.data.steps].reverse() : record.data.steps
  let done = 0
  let skipped = 0
  let firstSkip: StepOutcome | null = null
  for (const part of parts) {
    const outcome = await runRecord(part, which)
    if (outcome.kind === "done") done += 1
    else {
      skipped += 1
      firstSkip ??= outcome
    }
  }
  if (done === 0) return firstSkip ?? { kind: "skipped", reason: "gone" }
  return skipped > 0 ? { kind: "done", partial: { skipped } } : { kind: "done" }
}

export interface HistoryResult {
  step: Pick<StepRecord, "labelKey" | "labelParams" | "fileName">
  outcome: StepOutcome
}

/**
 * Undo the newest step. Resolves null when there is nothing to undo. A press
 * made while another undo/redo is still writing waits for it, then runs.
 *
 * Done → the step moves to the redo stack. Blocked → it stays where it was.
 * Skipped or failed → it is DROPPED: its guard says the world moved on, so
 * redoing it later would be redoing something that no longer matches either.
 */
export async function undoLast(): Promise<HistoryResult | null> {
  return run("undo")
}

/** Redo the newest undone step. Same rules as {@link undoLast}, mirrored. */
export async function redoLast(): Promise<HistoryResult | null> {
  return run("redo")
}

// Presses made while a step is still running wait their turn instead of being
// dropped: five quick Cmd+Z presses undo five steps (slow-network pass,
// 2026-10-13, where one undo could take seconds and most presses vanished).
let queue: Promise<unknown> = Promise.resolve()

function run(which: "undo" | "redo"): Promise<HistoryResult | null> {
  if (!activeScope) return Promise.resolve(null)
  // A press belongs to the project it was made in; if the user has moved on
  // by the time its turn comes, it does nothing.
  const scope = activeScope
  const turn = queue.then(() => runNow(which, scope))
  queue = turn.catch(() => {})
  return turn
}

async function runNow(which: "undo" | "redo", scope: string): Promise<HistoryResult | null> {
  if (activeScope !== scope) return null
  const s = stacksFor(scope)
  const from = which === "undo" ? s.undo : s.redo
  const record = from[from.length - 1]
  if (!record) return null
  const label = { labelKey: record.labelKey, labelParams: record.labelParams, fileName: record.fileName ?? null }
  if (record.fileId && openFileProbe && !openFileProbe(record.fileId)) {
    return { step: label, outcome: { kind: "blocked", reason: "elsewhere" } }
  }
  // Saved as already moved before it runs: if the tab closes while its writes
  // are out, a reload offers it on the other side rather than offering to do
  // again what has (most likely) landed. Moved back if it doesn't go through.
  from.pop()
  const to = which === "undo" ? s.redo : s.undo
  to.push(record)
  scheduleSave(scope)
  busy = true
  emit()
  let outcome: StepOutcome
  try {
    outcome = await runRecord(record, which)
  } finally {
    busy = false
  }
  if (outcome.kind !== "done") {
    const at = to.lastIndexOf(record)
    if (at >= 0) to.splice(at, 1)
  }
  if (outcome.kind === "done") {
    // Already where it belongs.
  } else if (outcome.kind === "blocked") {
    from.push(record)
  } else {
    s.log.push({
      id: record.id,
      labelKey: record.labelKey,
      labelParams: record.labelParams,
      which,
      reason: outcome.kind === "failed" ? "failed" : outcome.reason,
      at: Date.now(),
    })
    if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT)
  }
  scheduleSave(scope)
  emit()
  return { step: label, outcome }
}

/**
 * Undo back to (and including) the step `id`, one step at a time, newest
 * first — the History panel's "undo to here". Stops early at a blocked or
 * failed step; skipped steps are logged and passed. Returns every result.
 */
export async function undoTo(
  id: string,
  /** Called as each step finishes, so a long walk can report as it goes. */
  onStep?: (result: HistoryResult) => void,
): Promise<HistoryResult[]> {
  const results: HistoryResult[] = []
  if (!activeScope) return results
  const s = stacksFor(activeScope)
  if (!s.undo.some((r) => r.id === id)) return results
  for (;;) {
    const top = s.undo[s.undo.length - 1]
    if (!top) break
    const r = await run("undo")
    if (!r) break
    results.push(r)
    onStep?.(r)
    if (r.outcome.kind === "blocked" || r.outcome.kind === "failed") break
    if (top.id === id) break
  }
  return results
}

// ── Reading ─────────────────────────────────────────────────────────────────

export type StepSummary = Pick<StepRecord, "id" | "labelKey" | "labelParams" | "at" | "fileId" | "fileName">

export interface HistoryView {
  canUndo: boolean
  canRedo: boolean
  /** The step Undo would take back, for the button's tooltip. */
  nextUndo: StepSummary | null
  nextRedo: StepSummary | null
  busy: boolean
  /** Every step Undo can reach, oldest first — the History panel's list. */
  undoSteps: readonly StepSummary[]
  /** Every step Redo can reach, the next one LAST. */
  redoSteps: readonly StepSummary[]
  /** Recent undos and redos that did not happen, and why. */
  skipped: readonly SkipLogEntry[]
}

let snapshotCache: HistoryView | null = null

function summary(r: StepRecord): StepSummary {
  return { id: r.id, labelKey: r.labelKey, labelParams: r.labelParams, at: r.at, fileId: r.fileId ?? null, fileName: r.fileName ?? null }
}

/** A stable snapshot for useSyncExternalStore: the same object until something changes. */
export function historyView(): HistoryView {
  if (snapshotCache) return snapshotCache
  const s = activeScope ? stacks.get(activeScope) : undefined
  const undoSteps = (s?.undo ?? []).map(summary)
  const redoSteps = (s?.redo ?? []).map(summary)
  snapshotCache = {
    canUndo: !busy && undoSteps.length > 0,
    canRedo: !busy && redoSteps.length > 0,
    nextUndo: undoSteps[undoSteps.length - 1] ?? null,
    nextRedo: redoSteps[redoSteps.length - 1] ?? null,
    busy,
    undoSteps,
    redoSteps,
    skipped: [...(s?.log ?? [])],
  }
  return snapshotCache
}

export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Newest step time in the active scope — the shortcut arbiter's input. */
export function newestStepAt(): number | null {
  const s = activeScope ? stacks.get(activeScope) : undefined
  return s?.undo[s.undo.length - 1]?.at ?? null
}

/** The signed-in person the active scope belongs to. */
export function historyUser(): string | null {
  return activeUser
}

/** Tests only: forget everything (saved history included is the store's job). */
export function resetHistoryForTests(): void {
  stacks.clear()
  handlers.clear()
  loaded.clear()
  dirtyScopes.clear()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  groupBuffers.length = 0
  activeScope = null
  activeUser = null
  busy = false
  queue = Promise.resolve()
  pendingWrites.clear()
  openFileProbe = null
  emit()
}

/** Tests only: write pending saves now. */
export async function flushHistorySaveForTests(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const pending = [...dirtyScopes]
  dirtyScopes.clear()
  await Promise.all(
    pending.map((key) => {
      const s = stacks.get(key)
      const [projectId, username, lane = ""] = key.split("\u0000")
      return s ? saveHistory(projectId, username, lane, { undo: s.undo, redo: s.redo, log: s.log }) : Promise.resolve()
    }),
  )
}
