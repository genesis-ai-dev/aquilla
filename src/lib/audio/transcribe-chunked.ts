// AQU-1681: transcribe a recording that was split into many rows a minute at a
// time, not a row at a time.
//
// Hosted transcription allows each person 60 requests per 15 minutes
// (auth-worker/src/routes/transcription.ts). One request per row meant an
// episode cut into ~900 rows got 60 of them transcribed and the rest refused.
// Sam's ruling (2026-10-15): send about a minute of audio per request — the
// most one request carries — cut at row boundaries so no row is split across
// two requests, then hand each returned word back to the row it was spoken
// in. A row longer than a minute goes on its own (and is sent in one-minute
// windows, as before). An episode then takes ~55 requests instead of ~900.
//
// The hosted route returns per-word timings (`timestamp_granularities:
// ["word", "segment"]`) and says so (`granularity`). If a response only has
// segment timings — a sentence can span two rows — or has text with no
// timings at all, that minute's rows are transcribed one by one instead.
//
// Rows that already have their text are never sent: they are not targets, and
// a minute is never stretched across one, so none of their words can land on
// a neighbour.

import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import { audioIdSeededWith, parseFrontierAudioUrl } from "./upload"
import { setTranscribeStatus } from "./transcribe-status"
import { sharedClipWindow } from "./shared-clip-pcm"
import { transcribeHosted } from "./transcribe-hosted"
import { audioBytesToWhisperPcm, readClipBytes, type TranscriptionResult } from "./transcribe"

/** The most audio one hosted request carries (transcribe-hosted.ts windows
 *  at exactly this), so a minute is one request. */
export const CHUNK_MAX_MS = 60_000

/** Silence between two rows that a minute will bridge. A longer gap is audio
 *  nobody asked for (music, a scene with no lines), so the minute ends there
 *  rather than paying to transcribe it. */
export const CHUNK_MAX_GAP_MS = 10_000

export interface ChunkRow {
  cell: CellData
  /** The row's stretch of the shared recording (its trim window), ms. */
  startMs: number
  endMs: number
}

export interface TranscriptionChunk {
  /** The shared recording, as transcription names it: `<audioId>.<ext>`. */
  clipKey: string
  startMs: number
  endMs: number
  rows: ChunkRow[]
}

/** A row of a shared recording: its key and stretch, or null when the row is
 *  a take, has no stretch, or lives somewhere transcription cannot read. */
function sharedRecordingRow(cell: CellData): { clipKey: string; startMs: number; endMs: number } | null {
  const audioId = cell.selectedAudioId
  if (cell.medium !== "media" || !audioId || audioIdSeededWith(audioId, cell.id)) return null
  const attachment = cell.attachments?.[audioId]
  const frontier = attachment?.url ? parseFrontierAudioUrl(attachment.url) : null
  const startMs = attachment?.trimStartMs
  const endMs = attachment?.trimEndMs
  if (!frontier || typeof startMs !== "number" || typeof endMs !== "number" || !(endMs > startMs)) return null
  return { clipKey: `${frontier.audioId}.${frontier.ext}`, startMs, endMs }
}

/**
 * Group the target rows of each shared recording into minutes.
 *
 * `cells` is everything the caller knows about (so a row that is NOT a target
 * can end a minute); `isTarget` picks the rows to transcribe. Rows that cannot
 * be grouped — takes, rows with no stretch, a row over a minute long, a row
 * with no neighbour to share a request with — come back in `single`, for the
 * row-by-row path.
 */
export function planTranscriptionChunks(
  cells: readonly CellData[],
  isTarget: (cell: CellData) => boolean,
): { chunks: TranscriptionChunk[]; single: CellData[] } {
  const chunks: TranscriptionChunk[] = []
  const single: CellData[] = []
  const byClip = new Map<string, Array<ChunkRow & { target: boolean }>>()
  for (const cell of cells) {
    const target = isTarget(cell)
    const row = sharedRecordingRow(cell)
    if (!row) {
      if (target) single.push(cell)
      continue
    }
    const list = byClip.get(row.clipKey) ?? []
    list.push({ cell, startMs: row.startMs, endMs: row.endMs, target })
    byClip.set(row.clipKey, list)
  }

  for (const [clipKey, rows] of byClip) {
    rows.sort((a, b) => a.startMs - b.startMs)
    let current: TranscriptionChunk | null = null
    const close = () => {
      if (current && current.rows.length >= 2) chunks.push(current)
      else if (current) single.push(current.rows[0]!.cell)
      current = null
    }
    for (const { cell, startMs, endMs, target } of rows) {
      if (!target || endMs - startMs > CHUNK_MAX_MS) {
        close()
        if (target) single.push(cell)
        continue
      }
      if (current && endMs - current.startMs <= CHUNK_MAX_MS && startMs - current.endMs <= CHUNK_MAX_GAP_MS) {
        current.rows.push({ cell, startMs, endMs })
        current.endMs = Math.max(current.endMs, endMs)
      } else {
        close()
        current = { clipKey, startMs, endMs, rows: [{ cell, startMs, endMs }] }
      }
    }
    close()
  }
  return { chunks, single }
}

/**
 * Hand a minute's words back to its rows. `result` is timed from the start of
 * the minute; each row's share comes back timed from the start of the row,
 * exactly as if the row had been transcribed alone.
 *
 * A word belongs to the row whose stretch holds its middle, else (a word in
 * the silence between two rows) to the nearer row. Each row's text is cut out
 * of the full transcript between its first word and the next row's, so
 * punctuation and languages written without spaces survive; if a word cannot
 * be found in the transcript the row's words are joined with spaces instead.
 *
 * Null when the words cannot be placed: segment-level timings, or text with
 * no timings at all. The caller then transcribes those rows one by one.
 */
export function assignWordsToRows(
  result: TranscriptionResult,
  chunk: TranscriptionChunk,
): Map<string, TranscriptionResult> | null {
  const out = new Map<string, TranscriptionResult>()
  if (result.granularity === "segment") return null
  if (result.chunks.length === 0) {
    if (result.text.trim()) return null
    for (const row of chunk.rows) out.set(row.cell.id, { text: "", chunks: [] })
    return out
  }

  const rows = chunk.rows
  const words = result.chunks.map((w) => ({
    text: w.text,
    startMs: chunk.startMs + w.start * 1000,
    endMs: chunk.startMs + w.end * 1000,
  }))
  const rowOf = words.map((w) => {
    const mid = (w.startMs + w.endMs) / 2
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r]!
      const distance = mid < row.startMs ? row.startMs - mid : mid >= row.endMs ? mid - row.endMs : 0
      if (distance < bestDistance) {
        best = r
        bestDistance = distance
        if (distance === 0) break
      }
    }
    return best
  })

  // Where each word sits in the transcript, in order.
  const text = result.text
  const positions: number[] = []
  let cursor = 0
  for (const w of words) {
    const needle = w.text.trim()
    const at = needle ? text.indexOf(needle, cursor) : -1
    if (at < 0) break
    positions.push(at)
    cursor = at + needle.length
  }
  const located = positions.length === words.length

  const firstWordOfRow = new Map<number, number>()
  rowOf.forEach((r, i) => { if (!firstWordOfRow.has(r)) firstWordOfRow.set(r, i) })
  const rowsWithWords = [...firstWordOfRow.keys()].sort((a, b) => a - b)

  rows.forEach((row, r) => {
    const mine = words.map((w, i) => ({ w, i })).filter(({ i }) => rowOf[i] === r)
    if (mine.length === 0) {
      out.set(row.cell.id, { text: "", chunks: [] })
      return
    }
    let rowText: string
    if (located) {
      const k = rowsWithWords.indexOf(r)
      const from = k === 0 ? 0 : positions[firstWordOfRow.get(r)!]!
      const next = rowsWithWords[k + 1]
      const to = next === undefined ? text.length : positions[firstWordOfRow.get(next)!]!
      rowText = text.slice(from, to).trim()
    } else {
      rowText = mine.map(({ w }) => w.text.trim()).filter(Boolean).join(" ")
    }
    out.set(row.cell.id, {
      text: rowText,
      chunks: mine.map(({ w }) => ({
        text: w.text,
        start: Math.max(0, (w.startMs - row.startMs) / 1000),
        end: Math.max(0, (w.endMs - row.startMs) / 1000),
      })),
      ...(result.granularity ? { granularity: result.granularity } : {}),
    })
  })
  return out
}

export interface ChunkRunContext {
  session: FrontierSession
  projectId: string
  /** The rows' language tag as the project names it; the server routes by it. */
  language?: string
  onRateLimited?: (retryAfterSeconds: number) => Promise<void>
  /** Finish one row: with its words, or (no words given) transcribe it on its
   *  own. The batch passes `transcribeCell`. */
  transcribeRow: (cell: CellData, recognised?: TranscriptionResult) => Promise<unknown>
  /** Recognise a minute. Injected by tests; defaults to the shared-clip PCM
   *  and the hosted route. */
  recognise?: (chunk: TranscriptionChunk, ctx: ChunkRunContext) => Promise<TranscriptionResult>
  /** True once the batch was cancelled: the rows go back to idle. */
  isCancelled?: () => boolean
}

async function recogniseChunk(chunk: TranscriptionChunk, ctx: ChunkRunContext): Promise<TranscriptionResult> {
  const first = chunk.rows[0]!.cell
  const url = first.attachments?.[first.selectedAudioId!]?.url ?? ""
  const frontier = parseFrontierAudioUrl(url)!
  const pcm = await sharedClipWindow(
    chunk.clipKey,
    { trimStartMs: chunk.startMs, trimEndMs: chunk.endMs },
    () => readClipBytes({
      projectId: ctx.projectId, fileId: first.fileId, audioId: frontier.audioId, ext: frontier.ext, session: ctx.session,
    }),
    (bytes) => audioBytesToWhisperPcm(bytes),
  )
  // The account's model choice applies as for a row of the source clip
  // transcribed alone: never zero-shot (no lane's speech to learn from), and
  // the raw language tag, so the server can route by it.
  return transcribeHosted(pcm, {
    jwt: ctx.session.jwt,
    projectId: ctx.projectId,
    username: ctx.session.username,
    language: ctx.language,
    ...(ctx.onRateLimited ? { onRateLimited: ctx.onRateLimited } : {}),
  })
}

/** Transcribe one minute's rows with one request (more only for a refusal
 *  that is waited out), then store each row's share. */
export async function transcribeChunk(chunk: TranscriptionChunk, ctx: ChunkRunContext): Promise<void> {
  for (const { cell } of chunk.rows) setTranscribeStatus(cell.selectedAudioId!, { kind: "transcribing" })
  let result: TranscriptionResult
  try {
    result = await (ctx.recognise ?? recogniseChunk)(chunk, ctx)
  } catch (err) {
    for (const { cell } of chunk.rows) {
      setTranscribeStatus(cell.selectedAudioId!, ctx.isCancelled?.()
        ? { kind: "idle" }
        : { kind: "error", message: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  const perRow = assignWordsToRows(result, chunk)
  if (!perRow) {
    console.warn(
      `[transcribe] AQU-1681: the transcription of ${chunk.rows.length} rows came back without word timings ` +
      `(${result.granularity ?? "none"}); transcribing those rows one by one`,
    )
    for (const { cell } of chunk.rows) await ctx.transcribeRow(cell)
    return
  }
  for (const { cell } of chunk.rows) await ctx.transcribeRow(cell, perRow.get(cell.id))
}
