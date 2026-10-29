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
 * open. Nothing is lost by switching files. A step made in another LANGUAGE
 * opens that language first and then runs (decision 11, gap 24), so the change
 * happens where the person can see it (`setLaneSwitcher`).
 *
 * GROUPS. One action that writes many things (bulk validation, applying a
 * voice to many lines) is ONE step: `withGroup` collects the steps recorded
 * inside it. Undoing a group undoes its parts newest first; parts someone
 * changed since are skipped and the rest still go.
 *
 * SCOPE AND PERSISTENCE. One stack per (project, user), whatever language is
 * open (decision 11; it replaces Sam's Oct 14 one-per-language ruling). Steps
 * are saved to this browser (IndexedDB, history-store.ts) and to the server
 * (history-remote.ts), so they come back after a reload and on another
 * computer. The copies are merged step by step (history-merge.ts). A step
 * recorded in one project is never undone from another, and one account never
 * reads another's.
 */
import { dropLaneHistories, loadHistory, loadLaneHistories, saveHistory } from "./history-store"
import { GONE_LIMIT, emptyHistoryDoc, mergeDevices, mergeHistories, sameHistory, type DeviceWrite, type HistoryDoc } from "./history-merge"
import type { HistoryRemote } from "./history-remote"
import { stepLane } from "./step-lane"
import { tabConnId } from "@/lib/sync/ws-reconciler"

/**
 * Why a step was left alone. `approved`: someone else approved what it made
 * since (`by` names them, gap 25). `notAllowed`: the person may no longer make
 * that change (gap 29).
 */
export type SkipReason = "changed" | "gone" | "unavailable" | "approved" | "notAllowed" | "linesChanged"

/** What an undo or redo did. `skipped` is not an error: it is the guard working. */
export type StepOutcome =
  | { kind: "done"; partial?: { skipped: number } }
  | { kind: "skipped"; reason: SkipReason; by?: string }
  // `elsewhere`: its file is not open. `language`: its language could not be opened.
  | { kind: "blocked"; reason: "elsewhere" | "language" }
  // Another device of the same person undid or redid it first (decision 11):
  // nothing was written here, and the history now shows where it stands.
  | { kind: "moved" }
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
  /** The language (lane tag) the step's change lives in; `''` is a lane like
   *  any other. Absent: it changes something every language shares. */
  lane?: string
  /** When it last moved between Undo and Redo (ms): how two copies of the
   *  history are merged (history-merge.ts). Absent = never moved. */
  movedAt?: number
}

/**
 * What `recordStep` takes; `id` and `at` are filled in. `lane` is filled in
 * too, from the open language and the step's kind (step-lane.ts); pass `null`
 * for a step that belongs to no language.
 */
export type StepInput<D = unknown> = Omit<StepRecord<D>, "id" | "at" | "lane" | "movedAt"> & {
  at?: number
  lane?: string | null
}

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
  reason: SkipReason | "failed"
  /** Who changed it, when the reason names someone. */
  by?: string
  /** When it was attempted. */
  at: number
}

interface Stacks extends HistoryDoc {
  devices: DeviceWrite[]
  /** The server revision this copy is known to include; null = never synced. */
  revision: number | null
  /** Changed here since the server last took a copy. */
  unpushed: boolean
}

/** Enough to back out of an afternoon's editing without holding it forever. */
export const HISTORY_LIMIT = 100
const LOG_LIMIT = 30
const GROUP_KIND = "group"

const LIMITS = { steps: HISTORY_LIMIT, log: LOG_LIMIT }

const stacks = new Map<string, Stacks>()
const handlers = new Map<string, StepHandler<never>>()
const listeners = new Set<() => void>()
let activeScope: string | null = null
let activeUser: string | null = null
/** The language open in the workspace right now. */
let activeLane = ""
let busy = false
let openFileProbe: ((fileId: string) => boolean) | null = null
let laneSwitcher: ((lane: string) => Promise<LaneSwitch>) | null = null
let remote: HistoryRemote | null = null
let idCounter = 0

/** Steps recorded while a `withGroup` runs, innermost last. */
const groupBuffers: StepRecord[][] = []

/**
 * One history per project and person, whatever language is open (decision 11,
 * 2026-10-20, replacing Sam's Oct 14 one-per-language ruling). A step still
 * knows its language (`StepRecord.lane`): the History panel names it, and
 * undoing it opens that language first.
 */
function scopeKey(projectId: string, username: string): string {
  return `${projectId}\u0000${username}`
}

function splitKey(key: string): [projectId: string, username: string] {
  const [projectId, username = ""] = key.split("\u0000")
  return [projectId, username]
}

/** The language each project was last open in, for a step recorded from outside it. */
const laneByProject = new Map<string, string>()

function stacksFor(key: string): Stacks {
  let s = stacks.get(key)
  if (!s) {
    s = { ...emptyHistoryDoc(), devices: [], revision: null, unpushed: false }
    stacks.set(key, s)
  }
  return s
}

const docOf = (s: Stacks): HistoryDoc => ({ undo: s.undo, redo: s.redo, log: s.log, gone: s.gone, devices: s.devices })

/** A step leaves both stacks for good: remember it, so no other copy brings it back. */
function bury(s: Stacks, id: string): void {
  s.gone.push({ id, at: Date.now() })
  if (s.gone.length > GONE_LIMIT) s.gone.splice(0, s.gone.length - GONE_LIMIT)
}

function newId(): string {
  idCounter += 1
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function emit(): void {
  snapshotCache = null
  for (const fn of listeners) fn()
}


// ── Persistence: this browser ───────────────────────────────────────────────

/** Each scope's saved history is read once; this is that read, in flight or done. */
const loaded = new Map<string, Promise<void>>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
const dirtyScopes = new Set<string>()

function writeLocal(key: string): Promise<void> {
  const s = stacks.get(key)
  if (!s) return Promise.resolve()
  const [projectId, username] = splitKey(key)
  return saveHistory(projectId, username, { ...docOf(s), revision: s.revision })
}

// Saved at the end of the current task, not after a delay: a reload a moment
// after an action (or an undo) must find the history as it was left, or the
// step is missing, or an undone step is offered again (slow-network pass,
// 2026-10-13). Changes made in the same task still share one write. The
// server copy follows right after (see `schedulePush`).
function scheduleSave(scope: string): void {
  const s = stacks.get(scope)
  if (s) s.unpushed = true
  dirtyScopes.add(scope)
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    for (const key of dirtyScopes) {
      void writeLocal(key)
      schedulePush(key)
    }
    dirtyScopes.clear()
  }, 0)
}

/** Read the saved history for a scope once, merge it with anything recorded
 *  this session, then catch up with the server's copy. */
function loadScope(key: string): Promise<void> {
  let pending = loaded.get(key)
  if (!pending) {
    pending = readScope(key)
    loaded.set(key, pending)
  }
  return pending
}

async function readScope(key: string): Promise<void> {
  const [projectId, username] = splitKey(key)
  const saved = await loadHistory(projectId, username)
  // Gap 27: the per-language histories of before decision 11 join this one
  // the first time the project opens on this device. Their steps are stamped
  // with the language they were saved under, where their kind belongs to one.
  const lanes = await loadLaneHistories(projectId, username)
  let incoming: HistoryDoc = saved ?? emptyHistoryDoc()
  for (const { lane, history } of lanes) {
    const stamp = (r: StepRecord): StepRecord => {
      const l = r.lane ?? stepLane(r.kind, r.kind === GROUP_KIND ? stampGroup(r.data, lane) : r.data, lane)
      return r.kind === GROUP_KIND
        ? { ...r, data: stampGroup(r.data, lane), ...(l !== undefined ? { lane: l } : {}) }
        : l !== undefined ? { ...r, lane: l } : r
    }
    incoming = mergeHistories(incoming, { ...history, undo: history.undo.map(stamp), redo: history.redo.map(stamp) }, LIMITS)
  }
  const s = stacksFor(key)
  if (saved && s.revision == null) s.revision = saved.revision
  const recordedMeanwhile = s.undo.length + s.redo.length > 0
  mergeIn(key, incoming)
  if (lanes.length > 0) {
    s.unpushed = true
    await writeLocal(key)
    await dropLaneHistories(projectId, username, lanes.map((l) => l.lane))
  } else if (recordedMeanwhile && saved) {
    // Steps recorded before the read finished sit on top of the saved ones.
    scheduleSave(key)
  }
  // Gap 28: another device's steps arrive when the project opens (and when
  // the History panel opens), not live.
  void pullRemote(key)
}

/** A pre-decision-11 group's parts, stamped with the language they were saved under. */
function stampGroup(data: unknown, lane: string): unknown {
  const steps = (data as { steps?: StepRecord[] } | null)?.steps
  if (!Array.isArray(steps)) return data
  return {
    ...(data as object),
    steps: steps.map((p) => {
      const l = p.lane ?? stepLane(p.kind, p.data, lane)
      return l !== undefined ? { ...p, lane: l } : p
    }),
  }
}

/**
 * Merge another copy into the live stacks, IN PLACE: a running undo holds the
 * arrays. Returns whether anything moved. Ties keep the local copy's record
 * objects, so a merge that changes nothing replaces nothing.
 */
function mergeIn(key: string, other: HistoryDoc): boolean {
  const s = stacksFor(key)
  const merged = mergeHistories(docOf(s), other, LIMITS)
  // When the other devices last wrote is not shown anywhere: kept whether or
  // not a step moved.
  s.devices = merged.devices ?? []
  if (sameHistory(merged, docOf(s)) && merged.gone.length === s.gone.length) return false
  s.undo.splice(0, s.undo.length, ...merged.undo)
  s.redo.splice(0, s.redo.length, ...merged.redo)
  s.log.splice(0, s.log.length, ...merged.log)
  s.gone.splice(0, s.gone.length, ...merged.gone)
  emit()
  return true
}

/** Resolves once the active scope's saved history has been read (tests, and
 *  anything that must not race the load). */
export function historyReady(): Promise<void> {
  return activeScope ? loadScope(activeScope) : Promise.resolve()
}

// ── Persistence: the server, so the history follows the person ─────────────

/** How long an Undo waits to hear whether another device got there first. */
const CLAIM_WAIT_MS = 1500

/**
 * An Undo waits for that answer only when another of the person's devices
 * wrote this project's history this recently (Sam, Oct 22). Otherwise it goes
 * at once: one person on one device never waits.
 */
export const OTHER_DEVICE_WINDOW_MS = 5 * 60_000

const DEVICE_KEY = "aquilla.history.device"
let device: string | null = null

/**
 * This browser tab's name in the history's list of writers. A tab, not a
 * computer: two tabs hold two copies of the history, just as two computers
 * do. Kept across a reload (sessionStorage), so a reload does not make the tab
 * look like another device. A duplicated tab starts with the original's name;
 * the two then undo without waiting for each other, and each step's own
 * "changed since?" guard still stands.
 */
function thisDevice(): string {
  device ??= tabConnId(DEVICE_KEY)
  return device
}

/** When another device last wrote this copy's history, as far as this copy
 *  knows (ms; 0 = never). Learned from the copies it receives, never asked for. */
function otherDeviceWroteAt(s: Stacks): number {
  const me = thisDevice()
  return s.devices.reduce((newest, d) => (d.id !== me && d.at > newest ? d.at : newest), 0)
}

/** Where the server copy lives. The workspace sets it once a session exists;
 *  null keeps the history on this device only (signed out, tests). */
export function setHistoryRemote(next: HistoryRemote | null): void {
  remote = next
  if (next && activeScope) {
    void loadScope(activeScope).then(() => {
      if (activeScope) void pullRemote(activeScope)
    })
  }
}

/**
 * Catch up with the server's copy now (the History panel calls this as it
 * opens, gap 28). Resolves once it has been merged, or straight away when the
 * server cannot be reached.
 */
export async function refreshHistory(): Promise<void> {
  if (!activeScope) return
  const scope = activeScope
  await loadScope(scope)
  await pullRemote(scope)
}

const pushes = new Map<string, { running: boolean; again: boolean }>()

/** Send this copy to the server; one write at a time per scope, the newest last. */
function schedulePush(key: string): void {
  if (!remote) return
  let p = pushes.get(key)
  if (!p) {
    p = { running: false, again: false }
    pushes.set(key, p)
  }
  if (p.running) {
    p.again = true
    return
  }
  p.running = true
  const state = p
  void (async () => {
    try {
      do {
        state.again = false
        await pushOnce(key)
      } while (state.again)
    } finally {
      state.running = false
    }
  })()
}

async function pushOnce(key: string): Promise<void> {
  const [projectId] = splitKey(key)
  // A conflict means another device wrote first: merge its copy and try again
  // on top of it. Three tries cover a burst of writes from two devices.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = remote
    const s = stacks.get(key)
    if (!r || !s) return
    // Signed with this device and the time, so the person's other devices know
    // it is in use (see `claim`).
    const wrote = { id: thisDevice(), at: Date.now() }
    const snapshot = JSON.parse(JSON.stringify({ ...docOf(s), devices: mergeDevices(s.devices, [wrote]) })) as HistoryDoc
    const res = await r.write(projectId, s.revision ?? 0, snapshot)
    if (!res) return // offline or refused: it stays unpushed, and goes with the next write
    if (res.kind === "saved") {
      s.devices = mergeDevices(s.devices, [wrote])
      s.revision = res.revision
      if (sameHistory(docOf(s), snapshot)) s.unpushed = false
      void writeLocal(key)
      return
    }
    if (res.history) mergeIn(key, res.history)
    s.revision = newer(s.revision, res.revision)
  }
}

/** Revisions only grow: a read that left before a write of ours landed must
 *  not take this copy back to an older one. */
const newer = (a: number | null, b: number) => (a != null && a > b ? a : b)

const pulls = new Map<string, Promise<"unchanged" | "merged" | null>>()

/** Read the server's copy (if it changed since this one last agreed with it)
 *  and merge it in. Null when the server could not be reached. */
function pullRemote(key: string): Promise<"unchanged" | "merged" | null> {
  const inFlight = pulls.get(key)
  if (inFlight) return inFlight
  const p = pullOnce(key).finally(() => pulls.delete(key))
  pulls.set(key, p)
  return p
}

async function pullOnce(key: string): Promise<"unchanged" | "merged" | null> {
  const r = remote
  if (!r) return null
  const [projectId] = splitKey(key)
  const s = stacksFor(key)
  const res = await r.read(projectId, s.revision)
  if (!res) return null
  if (res.kind === "unchanged") {
    // Steps made here while the server could not be reached go now.
    if (s.unpushed) schedulePush(key)
    return "unchanged"
  }
  const knewOf = otherDeviceWroteAt(s)
  const changed = res.history ? mergeIn(key, res.history) : false
  s.revision = newer(s.revision, res.revision)
  // This copy holds something the server's lacks: send the merged one back.
  // (Nothing at all is not worth a row: opening a project writes nothing.)
  const hasSteps = s.undo.length + s.redo.length + s.gone.length > 0
  if (res.history ? !sameHistory(docOf(s), res.history) : hasSteps) {
    s.unpushed = true
    schedulePush(key)
  }
  // Kept here too when only the writers' times moved: after a reload, an Undo
  // still knows another device is in use.
  if (changed || otherDeviceWroteAt(s) !== knewOf) void writeLocal(key)
  return "merged"
}

/**
 * Before an undo or redo writes anything, ask the server whether another
 * device of the same person already took the step (P13.7: two devices cannot
 * undo the same step twice). Only when another device wrote this history in
 * the last few minutes, as this copy knows from the copies it has received;
 * otherwise nothing is asked and the step runs at once. Offline, or with no
 * answer in time, the step runs too: its own "changed since?" guard still
 * stands between it and a second write.
 */
async function claim(key: string, id: string, which: "undo" | "redo"): Promise<"ok" | "moved"> {
  if (!remote) return "ok"
  // A time far ahead of this clock is not taken to mean "just now" either.
  const since = Date.now() - otherDeviceWroteAt(stacksFor(key))
  if (since >= OTHER_DEVICE_WINDOW_MS || since <= -OTHER_DEVICE_WINDOW_MS) return "ok"
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CLAIM_WAIT_MS)
  })
  const result = await Promise.race([pullRemote(key), timeout])
  if (timer) clearTimeout(timer)
  if (result !== "merged") return "ok"
  const s = stacksFor(key)
  const from = which === "undo" ? s.undo : s.redo
  return from[from.length - 1]?.id === id ? "ok" : "moved"
}

if (typeof window !== "undefined") {
  // Steps made offline reach the server as soon as the connection is back.
  window.addEventListener("online", () => {
    for (const [key, s] of stacks) if (s.unpushed) schedulePush(key)
  })
}

// ── Scope, handlers, open-file probe, language switch ────────────────────────

/**
 * Which project and person the shortcut and the buttons act for, and which
 * language is open. The workspace sets it when a project opens and whenever
 * the open language changes; `null` when none is open. Switching language no
 * longer switches history (decision 11).
 */
export function setHistoryScope(projectId: string | null, username: string | null, lane = ""): void {
  if (projectId) laneByProject.set(projectId, lane)
  const laneChanged = lane !== activeLane
  activeLane = lane
  const next = projectId && username ? scopeKey(projectId, username) : null
  if (next === activeScope) {
    if (laneChanged) emit()
    return
  }
  activeScope = next
  activeUser = username
  emit()
  if (next) void loadScope(next)
}

/**
 * How opening a step's language went: open and loaded; `denied`, the person
 * may no longer work in it (the step is dropped, gap 29); `blocked`, it could
 * not be opened from here or not in time (the step waits, like one made in
 * another file).
 */
export type LaneSwitch = "ready" | "denied" | "blocked"

/**
 * How to open another language before undoing a step made in it (gap 24). The
 * workspace registers it; it resolves once that language is on screen and its
 * lines and takes have loaded.
 */
export function setLaneSwitcher(fn: ((lane: string) => Promise<LaneSwitch>) | null): void {
  laneSwitcher = fn
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

/**
 * Names a step's file from its id, for the many steps recorded without one
 * (a take renamed or deleted from its Recording tab, a translation, a
 * validation): without it a step held for another file could only say "Open
 * the file it was made in", and the History panel showed no file under it
 * (slice 13 evidence, Oct 27). The workspace registers it.
 */
let fileNamer: ((fileId: string) => string | null | undefined) | null = null
export function setFileNamer(namer: ((fileId: string) => string | null | undefined) | null): void {
  fileNamer = namer
}

// ── Recording ───────────────────────────────────────────────────────────────

// Steps recorded when their action STARTED, with the action's own write still
// out: an undo waits for it before running, and a step whose write was refused
// is dropped. Never saved (a promise can't be); after a reload the write has
// long settled.
const pendingWrites = new Map<string, Promise<boolean>>()

/** The language a step recorded into `key` now belongs to. */
function laneFor(key: string, input: Pick<StepInput, "kind" | "data" | "lane">): string | undefined {
  if (input.lane === null) return undefined
  if (input.lane !== undefined) return input.lane
  const open = key === activeScope ? activeLane : (laneByProject.get(splitKey(key)[0]) ?? "")
  return stepLane(input.kind, input.data, open)
}

function toRecord<D>(input: StepInput<D>, key: string, now = Date.now()): StepRecord<D> {
  const { lane: _lane, ...rest } = input
  const lane = laneFor(key, input)
  const named = rest.fileName == null && rest.fileId && fileNamer ? fileNamer(rest.fileId) : null
  return { ...rest, ...(named ? { fileName: named } : {}), id: newId(), at: input.at ?? now, ...(lane !== undefined ? { lane } : {}) }
}

/**
 * Record a step the user just took, in the ACTIVE scope. A new step clears the
 * redo stack, as everywhere: redoing past a fresh edit would replay a branch
 * that no longer exists. Inside `withGroup`, the step joins the group instead.
 *
 * Pass `opts.pending` (resolving true when the action took effect, false when
 * it was refused) to record it the moment the action starts: an Undo pressed
 * while the action is still saving must undo THAT action, not the step before
 * it (slow-network pass, 2026-10-13).
 */
export function recordStep<D>(
  input: StepInput<D>,
  scope?: { projectId: string; username: string },
  opts?: { pending?: Promise<boolean> },
): void {
  const key = scope ? scopeKey(scope.projectId, scope.username) : activeScope
  if (!key) return
  const record = toRecord(input, key)
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
      bury(s, id)
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
  for (const r of s.redo) bury(s, r.id)
  s.redo.splice(0, s.redo.length)
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
    const { id: _id, lane, ...only } = buffer[0]
    recordStep({ ...only, at: buffer[0].at, lane: lane ?? null })
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
  if (parts.length === 0 || !activeScope) return
  const now = Date.now()
  const key = activeScope
  const steps: StepRecord[] = parts.map((p) => toRecord(p, key, now))
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
  step: Pick<StepRecord, "labelKey" | "labelParams" | "fileName" | "lane">
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

function takeOut(list: StepRecord[], id: string): StepRecord | null {
  const at = list.findIndex((r) => r.id === id)
  return at >= 0 ? (list.splice(at, 1)[0] ?? null) : null
}

async function runNow(which: "undo" | "redo", scope: string): Promise<HistoryResult | null> {
  if (activeScope !== scope) return null
  const s = stacksFor(scope)
  // Looked up afresh after every wait: a merge may have replaced the arrays' contents.
  const fromList = () => (which === "undo" ? s.undo : s.redo)
  const toList = () => (which === "undo" ? s.redo : s.undo)
  const top = fromList()[fromList().length - 1]
  if (!top) return null
  const label = { labelKey: top.labelKey, labelParams: top.labelParams, fileName: top.fileName ?? null, lane: top.lane }
  if (top.fileId && openFileProbe && !openFileProbe(top.fileId)) {
    return { step: label, outcome: { kind: "blocked", reason: "elsewhere" } }
  }
  busy = true
  emit()
  let record: StepRecord | null
  let movedBefore: number | undefined
  let outcome: StepOutcome
  try {
    // Another device of the same person may have taken this step already.
    if ((await claim(scope, top.id, which)) === "moved") return { step: label, outcome: { kind: "moved" } }
    if (activeScope !== scope) return null
    // A step lives in its language: open it there first, so the change happens
    // where the person can see it (gap 24).
    if (top.lane !== undefined && top.lane !== activeLane) {
      const opened = laneSwitcher ? await laneSwitcher(top.lane) : "blocked"
      if (activeScope !== scope) return null
      if (fromList()[fromList().length - 1]?.id !== top.id) return { step: label, outcome: { kind: "moved" } }
      if (opened === "denied") {
        // The person may no longer work in that language (gap 29).
        takeOut(fromList(), top.id)
        bury(s, top.id)
        outcome = { kind: "skipped", reason: "notAllowed" }
        logSkip(s, top, which, outcome)
        scheduleSave(scope)
        return { step: label, outcome }
      }
      if (opened !== "ready") return { step: label, outcome: { kind: "blocked", reason: "language" } }
    }
    // Saved as already moved before it runs: if the tab closes while its writes
    // are out, a reload offers it on the other side rather than offering to do
    // again what has (most likely) landed. Moved back if it doesn't go through.
    record = takeOut(fromList(), top.id)
    if (!record) return null
    movedBefore = record.movedAt
    record.movedAt = Date.now()
    toList().push(record)
    scheduleSave(scope)
    emit()
    outcome = await runRecord(record, which)
  } finally {
    busy = false
    emit()
  }
  if (outcome.kind !== "done") takeOut(toList(), record.id)
  if (outcome.kind === "done") {
    // Already where it belongs.
  } else if (outcome.kind === "blocked") {
    record.movedAt = movedBefore
    fromList().push(record)
  } else {
    bury(s, record.id)
    logSkip(s, record, which, outcome)
  }
  scheduleSave(scope)
  emit()
  return { step: label, outcome }
}

function logSkip(s: Stacks, record: StepRecord, which: "undo" | "redo", outcome: StepOutcome): void {
  s.log.push({
    id: record.id,
    labelKey: record.labelKey,
    labelParams: record.labelParams,
    which,
    reason: outcome.kind === "skipped" ? outcome.reason : "failed",
    ...(outcome.kind === "skipped" && outcome.by ? { by: outcome.by } : {}),
    at: Date.now(),
  })
  if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT)
}

/**
 * Undo back to (and including) the step `id`, one step at a time, newest
 * first — the History panel's "undo to here". Stops early at a blocked,
 * failed or moved step; skipped steps are logged and passed. Returns every
 * result.
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
    if (r.outcome.kind === "blocked" || r.outcome.kind === "failed" || r.outcome.kind === "moved") break
    if (top.id === id) break
  }
  return results
}

// ── Reading ─────────────────────────────────────────────────────────────────

export type StepSummary = Pick<StepRecord, "id" | "labelKey" | "labelParams" | "at" | "fileId" | "fileName" | "lane">

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
  return {
    id: r.id,
    labelKey: r.labelKey,
    labelParams: r.labelParams,
    at: r.at,
    fileId: r.fileId ?? null,
    fileName: r.fileName ?? null,
    ...(r.lane !== undefined ? { lane: r.lane } : {}),
  }
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
  fileNamer = null
  stacks.clear()
  handlers.clear()
  loaded.clear()
  dirtyScopes.clear()
  pushes.clear()
  pulls.clear()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  groupBuffers.length = 0
  activeScope = null
  activeUser = null
  activeLane = ""
  laneByProject.clear()
  busy = false
  queue = Promise.resolve()
  pendingWrites.clear()
  openFileProbe = null
  laneSwitcher = null
  remote = null
  // The next "device" is a new one.
  device = null
  try {
    globalThis.sessionStorage?.removeItem(DEVICE_KEY)
  } catch {
    // unavailable: the next name is minted fresh anyway
  }
  emit()
}

/** Tests only: write pending saves now (this browser's copy; pushes start too). */
export async function flushHistorySaveForTests(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const pending = [...dirtyScopes]
  dirtyScopes.clear()
  for (const key of pending) schedulePush(key)
  await Promise.all(pending.map((key) => writeLocal(key)))
}

/** Tests only: wait until every server write in flight has settled. */
export async function settleHistorySyncForTests(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
    if (saveTimer) continue
    if ([...pushes.values()].some((p) => p.running) || pulls.size > 0) continue
    return
  }
}
