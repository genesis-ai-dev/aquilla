// segment_model — have a FAST-tier model find where passages begin.
//
// This is the 90/9/1 split applied to segmentation. The expensive part of the
// contextual pipeline is the closure loop, which exists because derived seeds
// are unreliable (see segment.ts's header): construe expands the window past a
// bad seed edge, at mid tier, up to six rounds, once per span, per lane, per
// run. Boundaries found ONCE per file by a cheap model amortize across all of
// that.
//
// The division of labour is the point:
//
//   MODEL   proposes break points and names each passage. That is the only
//           part needing judgment — where one scene stops being the same
//           scene.
//   CODE    turns break points into the segmentation. Segments are built as
//           the runs BETWEEN consecutive breaks, so contiguity and full
//           coverage are structural, not something a model can get wrong.
//
// That asymmetry is deliberate. Asking for start/end pairs and validating them
// means a model that emits a gap loses those cells from every future run
// silently. Asking only "where does a new passage begin" makes the failure
// mode a mediocre boundary rather than missing work.

import type { CellPair } from "../agent/tools/select-cells"
import type { SegmentBoundary } from "../../../../db/shared/file-segmentation"
import type { LlmCall } from "./types"

/** Cells shown to the model per call. Keeps one window inside a small model's
 *  useful attention span; a long book takes several sequential calls. */
export const WINDOW_CELLS = 120
/** Hard ceiling on calls for one file, so a pathological loop cannot spend
 *  without bound. A window always advances by at least one cell, so this also
 *  bounds the file size the pass will cover; beyond it the tail is left as one
 *  segment rather than silently dropped. */
export const MAX_WINDOWS = 40
/** Source text per cell in the prompt. Boundaries need the gist of a line, not
 *  all of it — a genealogy cell can be 400 characters of names. */
const CELL_CLIP = 240
/** A break that would leave a segment shorter than this is dropped: a
 *  one-cell "passage" gives the closure loop no discourse to construe. */
export const MIN_SEGMENT_CELLS = 2
/** Model output budget per window. */
const MAX_TOKENS = 2048

export interface SegmentModelDeps {
  pairs: CellPair[]
  llm: LlmCall
  /** The human's extra instruction from the Segmentation dialog, if any. */
  note?: string
  sourceLanguage?: string
}

export interface SegmentModelResult {
  boundaries: SegmentBoundary[]
  /** Model calls actually made — recorded so the cost is attributable. */
  calls: number
  /** Non-fatal notes: windows that returned nothing, a truncated tail, a
   *  dropped break. Surfaced, never silent. */
  notes: string[]
}

/** One proposed break: where a new passage starts, and what it is. */
interface Break {
  /** 0-based index into `pairs`. */
  index: number
  title?: string
  gist?: string
}

/**
 * Tolerant parse of the model's reply.
 *
 * Expected: {"passages":[{"line":1,"title":"…","gist":"…"}, …]} where `line` is
 * the 1-based line number WITHIN THE WINDOW at which a new passage begins.
 * Anything unparseable yields an empty list and the caller falls back — a
 * window that produced nothing is a missing opinion, not a broken file.
 */
export function parseSegmentReply(content: string, windowLength: number): Break[] {
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  if (start === -1 || end <= start) return []
  let raw: { passages?: unknown }
  try {
    raw = JSON.parse(content.slice(start, end + 1)) as { passages?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(raw.passages)) return []

  const seen = new Set<number>()
  const breaks: Break[] = []
  for (const entry of raw.passages as { line?: unknown; title?: unknown; gist?: unknown }[]) {
    if (typeof entry !== "object" || entry === null) continue
    if (typeof entry.line !== "number" || !Number.isFinite(entry.line)) continue
    const line = Math.floor(entry.line)
    if (line < 1 || line > windowLength) continue
    const index = line - 1
    if (seen.has(index)) continue
    seen.add(index)
    breaks.push({
      index,
      ...(typeof entry.title === "string" && entry.title.trim() ? { title: entry.title.trim() } : {}),
      ...(typeof entry.gist === "string" && entry.gist.trim() ? { gist: entry.gist.trim() } : {}),
    })
  }
  return breaks.sort((a, b) => a.index - b.index)
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > CELL_CLIP ? `${flat.slice(0, CELL_CLIP)}…` : flat
}

function systemPrompt(deps: SegmentModelDeps): string {
  const lang = deps.sourceLanguage ? ` The text is in ${deps.sourceLanguage}.` : ""
  const noteBlock = deps.note?.trim()
    ? `\n\nThe team working on this document added an instruction — follow it:\n${deps.note.trim().slice(0, 2000)}\n`
    : ""
  // [[ctx:segment]] routes the scripted e2e mock (scripts/mock-openrouter.ts).
  return `[[ctx:segment]] You divide a document into PASSAGES for translators.${lang}

You are given numbered lines. Each line is one segment of the document — a verse, a subtitle line, a sentence, a paragraph. Your job is to say where each new passage BEGINS.

A passage is a stretch of consecutive lines that belongs together and should be translated as one unit: one scene, one episode, one argument, one exchange. A new passage begins when the setting, the participants, the time, or the topic changes enough that a translator would think of it as a different thing.

Guidance:
- Aim for passages of roughly 5 to 15 lines. Prefer a natural break slightly early or late over forcing a target length.
- Line 1 always begins a passage.
- Do not break in the middle of a speech, a list, or a single argument.
- Ignore chapter and verse numbering if it disagrees with where the sense actually breaks. It often does.${noteBlock}

For each passage give a short title (a few words naming the passage) and a one-sentence gist of what happens in it.

Output STRICT JSON only, no prose, no code fences:
{"passages":[{"line":1,"title":"…","gist":"…"},{"line":9,"title":"…","gist":"…"}]}
"line" is the number of the line where that passage begins.`
}

function windowPrompt(window: CellPair[]): string {
  const lines = window
    .map((pair, i) => `${i + 1}. ${pair.canonicalRef ? `[${pair.canonicalRef}] ` : ""}${clip(pair.source)}`)
    .join("\n")
  return `Divide these ${window.length} lines into passages:\n${lines}`
}

/**
 * Run the pass over a whole file.
 *
 * Windows advance to the LAST break the model proposed rather than to the
 * window edge, so a passage that straddles a window boundary is decided by a
 * call that can see all of it. The final window keeps its trailing run, which
 * is why the last segment always reaches the end of the file.
 */
export async function segmentWithModel(deps: SegmentModelDeps): Promise<SegmentModelResult> {
  const { pairs } = deps
  const notes: string[] = []
  if (pairs.length === 0) return { boundaries: [], calls: 0, notes: ["file has no source cells"] }

  const system = systemPrompt(deps)
  /** Absolute 0-based indices where a passage begins, with their metadata. */
  const starts: Break[] = [{ index: 0 }]
  let cursor = 0
  let calls = 0

  while (cursor < pairs.length && calls < MAX_WINDOWS) {
    const window = pairs.slice(cursor, cursor + WINDOW_CELLS)
    const isFinalWindow = cursor + window.length >= pairs.length
    let reply: string
    try {
      reply = await deps.llm({
        system,
        user: windowPrompt(window),
        tier: "fast",
        maxTokens: MAX_TOKENS,
        temperature: 0,
        label: "segment",
      })
    } catch {
      notes.push(`segmentation call failed at line ${cursor + 1}; kept the surrounding passage whole`)
      break
    }
    calls += 1

    // Breaks at absolute positions, dropping the window's own first line: it
    // is either the file start (already recorded) or the previous window's
    // last break (likewise).
    const proposed = parseSegmentReply(reply, window.length)
      .filter((b) => b.index > 0)
      .map((b) => ({ ...b, index: cursor + b.index }))

    if (proposed.length === 0) {
      notes.push(`no passage breaks proposed for lines ${cursor + 1}–${cursor + window.length}`)
      if (isFinalWindow) break
      // Advance anyway, or the loop cannot terminate. The window edge becomes
      // a break, which is exactly the arbitrary cut this pass exists to avoid
      // — so it is reported rather than absorbed.
      cursor += window.length
      starts.push({ index: cursor })
      continue
    }

    // Carry the metadata onto the passage each break OPENS.
    starts.push(...proposed)

    if (isFinalWindow) break
    // Re-decide from the last break: the run after it is only half-seen.
    const lastBreak = proposed[proposed.length - 1].index
    cursor = lastBreak
    // A window whose only break is its own first usable line would not
    // advance; force progress rather than spin.
    if (cursor <= starts[starts.length - 2]!.index) cursor += window.length
  }

  if (cursor < pairs.length && calls >= MAX_WINDOWS) {
    notes.push(
      `stopped after ${MAX_WINDOWS} windows; lines ${cursor + 1}–${pairs.length} were left in one passage`,
    )
  }

  return { boundaries: buildBoundaries(pairs, starts), calls, notes }
}

/**
 * Turn break points into segments.
 *
 * Contiguity and coverage are structural here: segment k runs from break k to
 * one before break k+1, and the last runs to the end of the file. A model
 * cannot produce a gap or an overlap through this function, only a badly
 * placed edge.
 *
 * Breaks that would leave a sub-minimum segment are dropped, and their title
 * and gist go with them — a title describing two lines is not worth keeping a
 * two-line passage for.
 */
export function buildBoundaries(pairs: CellPair[], starts: Break[]): SegmentBoundary[] {
  const sorted = [...starts].sort((a, b) => a.index - b.index)
  const kept: Break[] = []
  for (const brk of sorted) {
    const index = Math.min(Math.max(0, brk.index), pairs.length - 1)
    if (kept.length === 0) {
      kept.push({ ...brk, index: 0 })
      continue
    }
    const previous = kept[kept.length - 1].index
    if (index - previous < MIN_SEGMENT_CELLS) continue
    if (pairs.length - index < MIN_SEGMENT_CELLS) continue
    kept.push({ ...brk, index })
  }

  return kept.map((brk, i) => {
    const startIndex = brk.index
    const endIndex = i + 1 < kept.length ? kept[i + 1].index - 1 : pairs.length - 1
    return {
      startCellId: pairs[startIndex].cellId,
      endCellId: pairs[endIndex].cellId,
      ...(brk.title ? { title: brk.title } : {}),
      ...(brk.gist ? { gist: brk.gist } : {}),
    }
  })
}
