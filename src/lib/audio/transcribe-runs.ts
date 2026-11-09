// AQU-2375: a transcription run outlives the page that started it.
//
// AQU-1917's rule is that a transcription job survives a page reload without
// anyone doing anything. The batch itself is a page-local async loop
// (`runTranscribeAll`), so a reload ends it. What survives is this record: the
// run's rows, which of them have landed and which failed, and what it was
// started with. The workspace that opens the run's file next carries it on
// from there (`useCarryOnTranscribeRuns`), and says so.
//
// LIVE OR INTERRUPTED. A record exists while its run is going, so a second tab
// must not mistake a run still going in the first tab for one a reload
// stopped. The running page holds a Web Lock named after the run for as long
// as it runs; the browser drops it when that page goes away, so "no one holds
// the lock" is exactly "interrupted". Where Web Locks are missing, a heartbeat
// stands in: the running page stamps the record every few seconds, and a
// record nobody has stamped for a while is interrupted. Carrying a run on
// claims it the same way, so two tabs never both pick it up.
//
// A LINE'S WORDS (AQU-2426's Import and transcribe…, and Split into lines… ›
// At sentences, with words) are kept here too, as a run of kind "lineWords":
// one recording line's stretch cut into windows of at most a minute (one
// hosted request each), with each window's words kept as they land, so words
// already paid for are never lost to a reload or a failed window. A line run
// that ended with some windows still to do is PARKED: nobody carries it on by
// itself, and the next words run on the same stretch of the same line takes
// it over and sends only the windows still missing. A run whose words were
// split by stays parked too (AQU-2426 review, Nov 9): Undo gives the line its
// whole stretch back, and splitting it by its words again then costs nothing.
// Like any run it is forgotten after a week.
//
// Per browser profile, in localStorage, like the model consent it sits beside:
// a run is one person's, on one device, and a page reload is all it has to
// survive. Never shared through sync.

const STORAGE_KEY = "aquilla.transcribeRuns.v1"
const LOCK_PREFIX = "aquilla-transcribe-run:"
/** How often a running page stamps its record when there are no Web Locks. */
export const HEARTBEAT_MS = 5_000
/** A record unstamped for this long belongs to a page that is gone. */
export const STALE_MS = 20_000
/** A run nobody carried on in a week is forgotten. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Row bookkeeping is written at most this often while rows land. */
const WRITE_THROTTLE_MS = 1_000

/** Which button started the run: the post-import run, Transcribe all, the
 *  sections someone selected on the timeline, or one line's words (AQU-2426:
 *  Import and transcribe…, Split into lines… › At sentences, with words). */
export type TranscribeRunKind = "import" | "all" | "sections" | "lineWords"

/** A word, seconds from the start of its line's stretch. */
export interface StoredWord {
  text: string
  start: number
  end: number
}

/**
 * AQU-2426: what a "lineWords" run is about. Its rows (`cellIds`) are the
 * windows' keys, `w0`, `w1`…, so the row bookkeeping above counts windows.
 */
export interface StoredLineWords {
  /** The line, and the recording its stretch is cut from. */
  cellId: string
  audioId: string
  url: string
  /** The stretch, ms on the recording's clock. */
  lo: number
  hi: number
  /** Each window's stretch, ms on the recording's clock, in order. */
  windows: Array<{ lo: number; hi: number }>
  /** Each finished window's words, by its key. */
  words: Record<string, { words: StoredWord[]; text: string }>
  languageTag?: string
  /** "import": split once every window has words (Import and transcribe…).
   *  "dialog": the person previews the lines in Split into lines…. */
  purpose: "import" | "dialog"
}

/** A window's key in a line run. */
export function lineWindowKey(index: number): string {
  return `w${index}`
}

export interface StoredTranscribeRun {
  id: string
  projectId: string
  /** The file whose page carries the run on (the one it was started from). */
  fileId: string
  /** Shown in the toast that says the run was carried on. */
  fileName: string
  kind: TranscribeRunKind
  /** Every row the run set out to transcribe. */
  cellIds: string[]
  /** Rows whose transcript landed. */
  doneIds: string[]
  /** Rows that failed, with why. */
  failed: Array<{ cellId: string; message: string }>
  /** How the run was started, so carrying it on does the same thing. */
  force: boolean
  forceAutoModel?: boolean
  sourceLanguage?: string
  targetLanguage?: string
  targetLang?: string
  startedAt: number
  /** Last heartbeat from the page running it. */
  beatAt: number
  /** That page's id. */
  tab: string
  /**
   * AQU-2375 (review, Nov 9): who started it (their sign-in name), and the
   * language lane it was started in ("" = the default lane). A run is carried
   * on only by that person, and a run over takes only with that language
   * open: carried on by whoever opened the file next, it ran under their
   * account and limit, and in another language it transcribed that
   * language's takes as this one's. Absent on a run kept before this, or
   * started signed out: carried on as before.
   */
  username?: string
  lane?: string
  /** AQU-2426: a line's words (kind "lineWords"). */
  line?: StoredLineWords
  /** AQU-2426: a line run that ended with windows still to do, kept for the
   *  next words run on that line. Never carried on by itself. */
  parked?: boolean
}

export interface TranscribeRunHandle {
  readonly id: string
  /** Record how one row ended. A line run's window keeps its words. */
  row(
    cellId: string,
    outcome: { kind: "done"; lineWords?: { words: StoredWord[]; text: string } } | { kind: "failed"; message: string } | { kind: "skipped" },
  ): void
  /** The run finished, failed or was cancelled: forget it. */
  end(): void
  /** AQU-2426: stop running it but keep what it has, for the next words run on
   *  the same line (see `findLineWordsRun`). Nobody carries it on by itself. */
  park(): void
}

// ─── storage ──────────────────────────────────────────────────────────────

function readAll(): StoredTranscribeRun[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed.filter(isStoredRun) as StoredTranscribeRun[]) : []
  } catch {
    return []
  }
}

function writeAll(runs: StoredTranscribeRun[]): void {
  let keep = runs
  for (;;) {
    try {
      if (keep.length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY)
      else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(keep))
      return
    } catch {
      // AQU-2426 (review, Nov 9): a full quota. Parked words are the bulk of
      // what is kept (a long recording's are a few hundred KB, and they now
      // outlive the split that used them, for Undo), and they are a saving,
      // not a run in progress: the oldest go first, so a run that is going
      // can still be kept.
      const oldest = keep.filter((r) => r.parked).sort((a, b) => a.startedAt - b.startedAt)[0]
      // Private mode, or nothing left to give up: the run still runs, it just
      // won't outlive the page — exactly as before this record existed.
      if (!oldest) return
      keep = keep.filter((r) => r !== oldest)
    }
  }
}

function isStoredRun(v: unknown): boolean {
  if (!v || typeof v !== "object") return false
  const r = v as Partial<StoredTranscribeRun>
  return typeof r.id === "string" && typeof r.projectId === "string" && typeof r.fileId === "string"
    && Array.isArray(r.cellIds) && Array.isArray(r.doneIds) && Array.isArray(r.failed)
    && typeof r.startedAt === "number" && typeof r.beatAt === "number" && typeof r.tab === "string"
}

function update(id: string, fn: (run: StoredTranscribeRun) => StoredTranscribeRun | null): void {
  const runs = readAll()
  const i = runs.findIndex((r) => r.id === id)
  if (i < 0) return
  const next = fn(runs[i]!)
  if (next) runs[i] = next
  else runs.splice(i, 1)
  writeAll(runs)
}

/** Forget a run (it finished elsewhere, or nobody wants it carried on). */
export function dropStoredTranscribeRun(id: string): void {
  update(id, () => null)
}

/** @internal — tests read the stored list. */
export function __storedTranscribeRuns(): StoredTranscribeRun[] {
  return readAll()
}

// ─── this page, and the clock ─────────────────────────────────────────────

// A reload tears the page down mid-request: the request in flight is cut off
// and rejects. That is the page leaving, not the service failing — a run cut
// off this way is left as it is, so the next page carries it on. `pagehide`
// is the page really going; `beforeunload` can still be called off (a "leave
// this page?" prompt), so its mark clears itself if the page is still here.
let leaving = false
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { leaving = true })
  window.addEventListener("pageshow", () => { leaving = false })
  window.addEventListener("beforeunload", () => {
    leaving = true
    setTimeout(() => { leaving = false }, 2000)
  })
}

/** True while the page is going away (a reload, closing the tab). */
export function pageIsLeaving(): boolean {
  return leaving
}

/** @internal — tests pretend the page is going away. */
export function __setPageLeavingForTests(value: boolean): void {
  leaving = value
}

let tabId = `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
let now = () => Date.now()
let locksOverride: LockManagerLike | null | undefined

/** @internal — tests pretend to be another page, or move the clock. */
export function __setTranscribeRunEnvForTests(env: {
  tab?: string
  now?: () => number
  locks?: LockManagerLike | null
}): void {
  if (env.tab !== undefined) tabId = env.tab
  if (env.now !== undefined) now = env.now
  if ("locks" in env) locksOverride = env.locks
}

/** The slice of the Web Locks API used here. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>
  query(): Promise<{ held?: Array<{ name?: string }> }>
}

function locks(): LockManagerLike | null {
  if (locksOverride !== undefined) return locksOverride
  const nav = globalThis.navigator as (Navigator & { locks?: LockManagerLike }) | undefined
  return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null
}

/**
 * Hold the run's lock until `release` is called. Resolves true once held,
 * false when another page holds it (only asked with `ifAvailable`).
 */
function holdLock(id: string, ifAvailable: boolean): { held: Promise<boolean>; release: () => void } {
  const manager = locks()
  let release = () => {}
  if (!manager) return { held: Promise.resolve(true), release }
  const held = new Promise<boolean>((resolve) => {
    void manager
      .request(LOCK_PREFIX + id, ifAvailable ? { ifAvailable: true } : {}, (lock) => {
        if (!lock) {
          resolve(false)
          return undefined
        }
        resolve(true)
        return new Promise<void>((done) => { release = done })
      })
      .catch(() => resolve(!ifAvailable))
  })
  return { held, release: () => release() }
}

function makeHandle(id: string, lock: { release: () => void }): TranscribeRunHandle {
  let ended = false
  let pending: Array<(run: StoredTranscribeRun) => void> = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    flushTimer = null
    if (pending.length === 0) return
    const apply = pending
    pending = []
    update(id, (run) => {
      for (const fn of apply) fn(run)
      return { ...run, beatAt: now(), tab: tabId }
    })
  }
  const beat = setInterval(() => {
    if (!ended) update(id, (run) => ({ ...run, beatAt: now(), tab: tabId }))
  }, HEARTBEAT_MS)
  // AQU-2375 (review, Nov 9): the page is going, and with it the throttle's
  // timer. What landed in the last second is written now, or the run carried
  // on counts rows as never reached that were transcribed.
  const onPageHide = () => {
    if (ended) return
    if (flushTimer !== null) clearTimeout(flushTimer)
    flush()
  }
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide)
  const unhook = () => {
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide)
  }
  return {
    id,
    row(cellId, outcome) {
      if (ended) return
      pending.push((run) => {
        if (outcome.kind === "done") {
          if (!run.doneIds.includes(cellId)) run.doneIds.push(cellId)
          run.failed = run.failed.filter((f) => f.cellId !== cellId)
          if (outcome.lineWords && run.line) run.line = { ...run.line, words: { ...run.line.words, [cellId]: outcome.lineWords } }
        } else if (outcome.kind === "failed") {
          run.failed = [...run.failed.filter((f) => f.cellId !== cellId), { cellId, message: outcome.message }]
        }
        // skipped: nothing to keep — a row that was never transcribed is still
        // to do, and carrying the run on finds it again.
      })
      // A line's words were paid for and land a minute's worth at a time:
      // written at once, so a reload right after never loses them.
      if (outcome.kind === "done" && outcome.lineWords) {
        if (flushTimer !== null) clearTimeout(flushTimer)
        flush()
        return
      }
      if (flushTimer === null) flushTimer = setTimeout(flush, WRITE_THROTTLE_MS)
    },
    end() {
      if (ended) return
      ended = true
      clearInterval(beat)
      unhook()
      if (flushTimer !== null) clearTimeout(flushTimer)
      pending = []
      dropStoredTranscribeRun(id)
      lock.release()
    },
    park() {
      if (ended) return
      ended = true
      clearInterval(beat)
      unhook()
      if (flushTimer !== null) clearTimeout(flushTimer)
      // What landed is written now, not on the throttle: the page may go next.
      const apply = pending
      pending = []
      update(id, (run) => {
        for (const fn of apply) fn(run)
        return { ...run, parked: true, beatAt: now(), tab: tabId }
      })
      lock.release()
    },
  }
}

/** Start keeping a new run. The caller ends the handle whatever happens. */
export function startStoredTranscribeRun(
  init: Omit<StoredTranscribeRun, "doneIds" | "failed" | "startedAt" | "beatAt" | "tab"> & {
    doneIds?: string[]
    failed?: StoredTranscribeRun["failed"]
  },
): TranscribeRunHandle {
  const at = now()
  const run: StoredTranscribeRun = {
    ...init,
    doneIds: init.doneIds ?? [],
    failed: init.failed ?? [],
    startedAt: at,
    beatAt: at,
    tab: tabId,
  }
  writeAll([...readAll().filter((r) => r.id !== run.id), run])
  return makeHandle(run.id, holdLock(run.id, false))
}

/**
 * AQU-2375 (review, Nov 9): may the page of this person, with this language
 * open, carry the run on? "person": someone else started it. "lane": it was
 * started in another language. A field not given is not checked. A line's
 * words run and the run after an import are about the source recording, so
 * their language never matters.
 */
export function transcribeRunFits(
  run: Pick<StoredTranscribeRun, "kind" | "username" | "lane">,
  here: { username?: string | null; lane?: string },
): "ok" | "person" | "lane" {
  if (run.username !== undefined && here.username !== undefined && run.username !== here.username) return "person"
  const overTakes = run.kind === "all" || run.kind === "sections"
  if (overTakes && run.lane !== undefined && here.lane !== undefined && run.lane !== here.lane) return "lane"
  return "ok"
}

/**
 * Runs in this project that a page reload (or a closed tab) stopped: no page
 * is running them now. Week-old ones are forgotten on the way.
 */
export async function interruptedTranscribeRuns(projectId: string): Promise<StoredTranscribeRun[]> {
  const all = readAll()
  const fresh = all.filter((r) => now() - r.startedAt < MAX_AGE_MS)
  if (fresh.length !== all.length) writeAll(fresh)
  const mine = fresh.filter((r) => r.projectId === projectId && r.tab !== tabId && !r.parked)
  if (mine.length === 0) return []
  const manager = locks()
  if (manager) {
    const held = new Set(
      ((await manager.query().catch(() => ({ held: [] }))).held ?? []).map((l) => l.name ?? ""),
    )
    return mine.filter((r) => !held.has(LOCK_PREFIX + r.id))
  }
  return mine.filter((r) => now() - r.beatAt >= STALE_MS)
}

/**
 * Take an interrupted run over, so this page carries it on. Null when another
 * page got there first. The handle then works exactly as a started one.
 */
export async function claimStoredTranscribeRun(id: string): Promise<TranscribeRunHandle | null> {
  const lock = holdLock(id, true)
  if (!(await lock.held)) return null
  const stamped = now()
  let claimed = false
  update(id, (run) => {
    claimed = true
    // A parked run taken over runs again (undefined is not written).
    return { ...run, parked: undefined, beatAt: stamped, tab: tabId }
  })
  if (!claimed) {
    lock.release()
    return null
  }
  if (!locks()) {
    // No Web Locks: last writer wins, so look again after another page had
    // its chance to write the same claim.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const run = readAll().find((r) => r.id === id)
    if (!run || run.tab !== tabId) return null
  }
  return makeHandle(id, lock)
}

/**
 * AQU-2426: the kept words run on this stretch of this line, if any, whether
 * parked or stopped by a reload. The next words run on it takes it over, so
 * only the windows still without words are sent.
 */
export function findLineWordsRun(match: {
  projectId: string
  fileId: string
  cellId: string
  audioId: string
  lo: number
  hi: number
}): StoredTranscribeRun | null {
  const fresh = readAll().filter((r) => now() - r.startedAt < MAX_AGE_MS)
  return fresh.find((r) => r.kind === "lineWords" && r.line
    && r.projectId === match.projectId && r.fileId === match.fileId
    && r.line.cellId === match.cellId && r.line.audioId === match.audioId
    && r.line.lo === match.lo && r.line.hi === match.hi) ?? null
}
