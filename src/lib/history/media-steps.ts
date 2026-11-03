/**
 * History steps for what a file's media hangs on: its film, which heard line
 * performs which subtitle, and who speaks each line. (Decision 11, slice 13.)
 *
 * All three belong to every language (step-lane.ts), and all three are plain
 * values that an existing event sets — `file.video.set`, `cell.link.set`,
 * `cast.assign` — so undo writes the old value back with the same event, and
 * only while what the step left is still there.
 *
 * CHARACTERS also live in the project's voice settings: which voice speaks a
 * line (`castAssignments`, and per language `laneCastAssignments`) and the
 * Check characters decisions (`characterResolutions`). A step remembers the
 * entries it changed in those maps and puts back each one nobody has changed
 * since. Voices an import added to the library stay there.
 */
import type { StepHandler, StepOutcome } from "./history"

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }

// ── Film ────────────────────────────────────────────────────────────────────

/** Linking, replacing or clearing a file's film. Null = no film. */
export interface FilmLinkData { fileId: string; before: string | null; after: string | null }

/** A film written from here that the project read has not answered yet. */
export interface PendingFilm {
  url: string | null
  /** What the read said when it was written. */
  readBefore: string | null
}

/**
 * The film a file has now, as far as this tab knows: the one written here,
 * until the project read answers. ANY new answer settles it, not only one
 * spelled exactly as written (the server may tidy the address): otherwise a
 * collaborator's later film stays hidden behind ours, and an Undo checked
 * against ours writes over theirs (review, Oct 29). `settled`: forget it.
 */
export function filmNow(read: string | null, pending: PendingFilm | undefined): { film: string | null; settled: boolean } {
  if (!pending) return { film: read, settled: true }
  if (pending.url === read || read !== pending.readBefore) return { film: read, settled: true }
  return { film: pending.url, settled: false }
}

// ── Cue links ───────────────────────────────────────────────────────────────

/** Pairing (or unpairing) a subtitle line with a heard line that performs it. */
export interface CueLinkData { textCellId: string; cueCellId: string; linked: boolean }

/** Who made a pairing: the matcher ("auto") or a person (a pinned "manual"). */
export type CueLinkOrigin = "auto" | "manual"

/**
 * Re-pairing the cues: every pairing it changed, as ONE step written in one
 * batch (review, Oct 29; a re-pair can change hundreds). `linked` is what the
 * re-pair left; `origin` and `confidence` are the pairing's when it is linked,
 * so a pairing it removed comes back as it was.
 */
export interface CueLinksData {
  links: Array<{ textCellId: string; cueCellId: string; linked: boolean; origin: CueLinkOrigin; confidence: number | null }>
}

/** One pairing to write. Without an origin it is a person's ("manual"). */
export interface CueLinkWrite {
  textCellId: string
  cueCellId: string
  linked: boolean
  origin?: CueLinkOrigin
  confidence?: number | null
}

// ── Characters ──────────────────────────────────────────────────────────────

/** What `cast.assign` writes on a line. A key left out was not touched. */
export interface CastValue {
  castName: string | null
  cameraState?: string | null
  lineNumber?: string | null
}

export interface CastCellChange { fileId: string; cellId: string; before: CastValue; after: CastValue }

/** One entry of a map in the project's voice settings, e.g. castAssignments[cellId]. */
export interface VoiceEntryChange {
  /** The settings key and the path inside it: ["castAssignments", cellId]. */
  path: string[]
  /** undefined = there was no entry. */
  before?: unknown
  after?: unknown
}

export interface CastAssignData { cells: CastCellChange[]; voices?: VoiceEntryChange[] }

export interface MediaStepContext {
  /** The film the file has now; undefined when the file can't be read. */
  readFilm(fileId: string): string | null | undefined
  /** Write it; false when the write was refused. */
  writeFilm(fileId: string, url: string | null): Promise<boolean>
  /** Whether the two are paired now; null when the pairings can't be read. */
  readCueLink(textCellId: string, cueCellId: string): boolean | null
  writeCueLinks(changes: ReadonlyArray<CueLinkWrite>): Promise<boolean>
  /** A line's character as it reads now; null when the line can't be read. */
  readCast(fileId: string, cellId: string): CastValue | null
  writeCast(changes: ReadonlyArray<{ fileId: string; cellId: string; value: CastValue }>): Promise<void>
  /** The project's voice settings now (the project-wide copy, never a language's view). */
  readVoiceSettings(): Record<string, unknown> | null
  writeVoiceSettings(patch: Record<string, unknown>): Promise<void>
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function castMatches(now: CastValue, expected: CastValue): boolean {
  if ((now.castName ?? null) !== (expected.castName ?? null)) return false
  if ("cameraState" in expected && (now.cameraState ?? null) !== (expected.cameraState ?? null)) return false
  if ("lineNumber" in expected && (now.lineNumber ?? null) !== (expected.lineNumber ?? null)) return false
  return true
}

function readPath(root: Record<string, unknown> | null, path: readonly string[]): unknown {
  let at: unknown = root
  for (const key of path) {
    if (!at || typeof at !== "object") return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

/**
 * The voice-settings patch that puts each entry from `from` back to `to`, for
 * the entries still holding `from`. Each top-level map is written whole, the
 * way the settings are saved everywhere else.
 */
export function voiceSettingsPatch(
  current: Record<string, unknown> | null,
  changes: readonly VoiceEntryChange[],
  which: "undo" | "redo",
): { patch: Record<string, unknown>; applied: number } {
  const patch: Record<string, unknown> = {}
  let applied = 0
  for (const c of changes) {
    const from = which === "undo" ? c.after : c.before
    const to = which === "undo" ? c.before : c.after
    if (!same(readPath(current, c.path), from)) continue
    const [top, ...rest] = c.path
    if (!(top in patch)) patch[top] = structuredClone((current?.[top] as Record<string, unknown> | undefined) ?? {})
    let at = patch[top] as Record<string, unknown>
    for (const key of rest.slice(0, -1)) {
      if (!at[key] || typeof at[key] !== "object") at[key] = {}
      at = at[key] as Record<string, unknown>
    }
    const last = rest[rest.length - 1]
    if (to === undefined) delete at[last]
    else at[last] = to
    applied += 1
  }
  return { patch, applied }
}

/**
 * The entries a voice-settings patch changes in the maps it names, for a
 * step to remember. `depth` is how deep the map's entries sit: 1 for
 * cellId → value, 2 for lane → cellId → value.
 */
export function voiceEntryChanges(
  before: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
  depths: Readonly<Record<string, 1 | 2>> = { castAssignments: 1, characterResolutions: 1, laneCastAssignments: 2 },
): VoiceEntryChange[] {
  const out: VoiceEntryChange[] = []
  const walk = (path: string[], was: unknown, now: unknown, depth: number) => {
    if (depth === 0) {
      if (!same(was, now)) out.push({ path, ...(was !== undefined ? { before: was } : {}), ...(now !== undefined ? { after: now } : {}) })
      return
    }
    const a = (was && typeof was === "object" ? was : {}) as Record<string, unknown>
    const b = (now && typeof now === "object" ? now : {}) as Record<string, unknown>
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk([...path, key], a[key], b[key], depth - 1)
  }
  for (const [key, depth] of Object.entries(depths)) {
    if (!(key in patch)) continue
    walk([key], before?.[key], patch[key], depth)
  }
  return out
}

export function mediaStepHandlers(ctx: MediaStepContext): Record<string, StepHandler<never>> {
  const filmFlip = async (d: FilmLinkData, from: string | null, to: string | null): Promise<StepOutcome> => {
    const now = ctx.readFilm(d.fileId)
    if (now === undefined) return GONE
    if ((now ?? null) !== from) return CHANGED
    return (await ctx.writeFilm(d.fileId, to)) ? DONE : { kind: "failed", error: new Error("film link refused") }
  }
  const cueFlip = async (d: CueLinkData, from: boolean): Promise<StepOutcome> => {
    const now = ctx.readCueLink(d.textCellId, d.cueCellId)
    if (now == null) return GONE
    if (now !== from) return CHANGED
    const ok = await ctx.writeCueLinks([{ textCellId: d.textCellId, cueCellId: d.cueCellId, linked: !from }])
    return ok ? DONE : { kind: "failed", error: new Error("pairing refused") }
  }
  const cueBatchFlip = async (d: CueLinksData, which: "undo" | "redo"): Promise<StepOutcome> => {
    const writes: CueLinkWrite[] = []
    let gone = 0
    for (const l of d.links) {
      const from = which === "undo" ? l.linked : !l.linked
      const now = ctx.readCueLink(l.textCellId, l.cueCellId)
      if (now == null) {
        gone += 1
        continue
      }
      if (now !== from) continue
      // A pairing goes back as it was. Removing one is the matcher's doing,
      // never a person's "not a pair", which would stop it being proposed.
      writes.push(
        from
          ? { textCellId: l.textCellId, cueCellId: l.cueCellId, linked: false, origin: "auto", confidence: null }
          : { textCellId: l.textCellId, cueCellId: l.cueCellId, linked: true, origin: l.origin, confidence: l.confidence },
      )
    }
    if (writes.length === 0) return gone === d.links.length && d.links.length > 0 ? GONE : CHANGED
    if (!(await ctx.writeCueLinks(writes))) return { kind: "failed", error: new Error("pairing refused") }
    return writes.length < d.links.length ? { kind: "done", partial: { skipped: d.links.length - writes.length } } : DONE
  }
  const castFlip = async (d: CastAssignData, which: "undo" | "redo"): Promise<StepOutcome> => {
    const writes: Array<{ fileId: string; cellId: string; value: CastValue }> = []
    let gone = 0
    for (const c of d.cells) {
      const now = ctx.readCast(c.fileId, c.cellId)
      if (!now) {
        gone += 1
        continue
      }
      if (castMatches(now, which === "undo" ? c.after : c.before)) {
        writes.push({ fileId: c.fileId, cellId: c.cellId, value: which === "undo" ? c.before : c.after })
      }
    }
    const voices = d.voices?.length ? voiceSettingsPatch(ctx.readVoiceSettings(), d.voices, which) : { patch: {}, applied: 0 }
    const total = d.cells.length + (d.voices?.length ?? 0)
    const done = writes.length + voices.applied
    if (done === 0) return gone === d.cells.length && d.cells.length > 0 ? GONE : CHANGED
    if (writes.length > 0) await ctx.writeCast(writes)
    if (voices.applied > 0) await ctx.writeVoiceSettings(voices.patch)
    return done < total ? { kind: "done", partial: { skipped: total - done } } : DONE
  }

  return {
    "film.link": {
      undo: (d: FilmLinkData) => filmFlip(d, d.after, d.before),
      redo: (d: FilmLinkData) => filmFlip(d, d.before, d.after),
    } as StepHandler<never>,
    "cue.link": {
      undo: (d: CueLinkData) => cueFlip(d, d.linked),
      redo: (d: CueLinkData) => cueFlip(d, !d.linked),
    } as StepHandler<never>,
    "cue.links": {
      undo: (d: CueLinksData) => cueBatchFlip(d, "undo"),
      redo: (d: CueLinksData) => cueBatchFlip(d, "redo"),
    } as StepHandler<never>,
    "cast.assign": {
      undo: (d: CastAssignData) => castFlip(d, "undo"),
      redo: (d: CastAssignData) => castFlip(d, "redo"),
    } as StepHandler<never>,
  }
}

/** A line's character as `cast.assign` would read it back, for the keys named. */
export function castValueOf(
  cell: { metadata?: Record<string, unknown> | null; cameraState?: unknown } | null | undefined,
  keys: { cameraState?: boolean; lineNumber?: boolean } = {},
): CastValue {
  const meta = cell?.metadata ?? null
  return {
    castName: typeof meta?.cast_name === "string" ? meta.cast_name : null,
    ...(keys.cameraState ? { cameraState: typeof cell?.cameraState === "string" ? cell.cameraState : null } : {}),
    ...(keys.lineNumber ? { lineNumber: typeof meta?.line_number === "string" ? meta.line_number : null } : {}),
  }
}

/**
 * Collects what one character action writes, line by line and in the voice
 * settings, so it can be recorded as ONE step once it has all landed.
 */
export class CastStepBuilder {
  readonly cells: CastCellChange[] = []
  voices: VoiceEntryChange[] = []

  /** A line about to be written: what it held (read now) and what it gets. */
  cell(
    fileId: string,
    cell: { id: string; metadata?: Record<string, unknown> | null; cameraState?: unknown },
    after: CastValue,
  ): void {
    const before = castValueOf(cell, { cameraState: "cameraState" in after, lineNumber: "lineNumber" in after })
    this.cells.push({ fileId, cellId: cell.id, before, after })
  }

  /** A voice-settings save: the entries it changes in the character maps. */
  settings(before: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): void {
    this.voices = [...this.voices, ...voiceEntryChanges(before, patch)]
  }

  data(): CastAssignData | null {
    const cells = this.cells.filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after))
    if (cells.length === 0 && this.voices.length === 0) return null
    return { cells, ...(this.voices.length > 0 ? { voices: this.voices } : {}) }
  }
}
