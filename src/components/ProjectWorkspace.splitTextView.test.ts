/**
 * AQU-2426 (browser pass, Nov 9): Split into lines…, run the way the
 * workspace runs it in the Text view.
 *
 * The Nov 9 fix was proved on the helper with the word times handed straight
 * in, and passed. In the app, in the Text view on a project with default
 * settings, Split at pauses on a recording with its text and 221 stored word
 * times left the whole transcript on the first line, and said there were no
 * word times to share it out by.
 *
 * The split read the line's recordings through the workspace's audio map,
 * which is not fetched in the Text view unless the person may restructure
 * lines (by default nobody may). The word times ride the recording, not the
 * line, so none were found.
 *
 * These tests build what the workspace has in the Text view (store cells
 * with no recordings, an empty workspace map, the lane's read of the file's
 * recordings) and run the workspace's own steps: `lineWithRecordings` (what
 * `cellWithAudio` merges) and `planLineSplit` (what `applyLineSplit` writes).
 * The events go to a stand-in for the server that projects them as the sync
 * worker does (event-projection.ts): an attach's `transcription` lands on the
 * line, its `timings` replace the recording's (absent: kept), its `asr`
 * likewise.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { WordTiming } from "@/lib/codex-editor/types"

type Line = {
  transcription: string
  timings?: WordTiming[]
  asr?: { text: string; model: string }
  startMs: number
  endMs: number
  trimStartMs: number | null
  trimEndMs: number | null
  sequenceIndex: number
}
const server = new Map<string, Line>()
const sent: Array<{ kind: string; input: Record<string, unknown> }> = []

vi.mock("@/lib/sync/events-emit", () => {
  const log = (kind: string, input: Record<string, unknown>) => { sent.push({ kind, input }) }
  return {
    emitCellRetime: async (i: { cellId: string; startMs: number; endMs: number }) => {
      log("retime", i)
      const l = server.get(i.cellId)
      if (l) Object.assign(l, { startMs: i.startMs, endMs: i.endMs })
    },
    emitCellAudioTrim: async (i: { cellId: string; trimStartMs: number | null; trimEndMs: number | null }) => {
      log("trim", i)
      const l = server.get(i.cellId)
      if (l) Object.assign(l, { trimStartMs: i.trimStartMs, trimEndMs: i.trimEndMs })
    },
    emitCellAudioAttach: async (i: { cellId: string; transcription?: string; timings?: WordTiming[]; asr?: { text: string; model: string }; trimStartMs?: number; trimEndMs?: number }) => {
      log("attach", i)
      const l = server.get(i.cellId)
      if (!l) return "ev"
      if (typeof i.transcription === "string") l.transcription = i.transcription
      if (i.timings !== undefined) l.timings = i.timings
      if (i.asr) l.asr = i.asr
      if (i.trimStartMs !== undefined) l.trimStartMs = i.trimStartMs
      if (i.trimEndMs !== undefined) l.trimEndMs = i.trimEndMs
      return "ev"
    },
    emitSourceCellCreate: async (i: { cellId: string; startMs: number; endMs: number; transcription?: string; sequenceIndex?: number }) => {
      log("create", i)
      server.set(i.cellId, {
        transcription: i.transcription ?? "", startMs: i.startMs, endMs: i.endMs,
        trimStartMs: null, trimEndMs: null, sequenceIndex: i.sequenceIndex ?? server.size,
      })
      return `ev-${i.cellId}`
    },
    emitSourceCellReorder: async (i: Record<string, unknown>) => { log("reorder", i) },
  }
})

import { lineWithRecordings } from "./project-workspace-helpers"
import { alignChunks } from "@/lib/audio/timings"
import {
  piecesFromCuts, planLineSplit, splitRecordingLine, writeLineWords, type LineHeard, type LinePiece, type RecordingLine,
} from "@/lib/timeline/split-recording-line"

// The reading, a sentence to a pause, each word at its time (seconds).
const S1 = "Ruth, chapter one."
const S2 = "This is the story of a family from Bethlehem."
const S3 = "Elimelech took his wife Naomi to Moab."
const TEXT = `${S1} ${S2} ${S3}`
const at = (text: string, from: number, step: number) =>
  text.split(" ").map((w, i) => ({ text: w, start: from + i * step, end: from + i * step + step * 0.8 }))
const WORDS = [...at(S1, 0.1, 0.5), ...at(S2, 2.2, 0.5), ...at(S3, 7.0, 0.55)]
const HEARD: LineHeard = { words: WORDS, model: "whisper-large-v3" }
const PAUSES = [2_000, 6_900]

const line: RecordingLine = {
  projectId: "p", fileId: "f", cellId: "c1", name: "Ruth reading.mp4",
  startMs: 0, endMs: 12_000, audioId: "f-clip.mp4", url: "frontier-audio://p/f/f-clip.mp4",
  durationMs: 12_000, sequenceIndex: 0, successor: null,
}
const author = "dev"

/** The page's cell store: lines without their recordings (raw store cells carry none). */
const storeCell = (cellId: string): CellData | null => {
  const l = server.get(cellId)
  return l ? ({ id: cellId, fileId: "f", medium: "media", original: line.name, transcription: l.transcription } as unknown as CellData) : null
}
/** The workspace's audio map in the Text view on a project with default settings: not fetched. */
const TEXT_VIEW_WORKSPACE_MAP = new Map<string, CellAudioEntry>()
/** The lane's read of the file's recordings (always fetched): the source clip, on every line. */
const laneMap = (): Map<string, CellAudioEntry> => new Map([...server].map(([cellId, l]) => [cellId, {
  attachments: {
    [line.audioId]: {
      audioId: line.audioId, url: line.url, slot: "recording", role: "source", durationMs: 12_000,
      trimStartMs: l.trimStartMs, trimEndMs: l.trimEndMs,
      asrText: l.asr?.text ?? null, asrModel: l.asr?.model ?? null,
    },
  },
  selectedBySlot: { recording: line.audioId },
  selectedAudioId: line.audioId,
  selectedGeneratedVoiceAudioId: null,
  audioTimings: l.timings ? { [line.audioId]: l.timings } : {},
} as unknown as CellAudioEntry]))
/** `cellWithAudio`, as the workspace has it in the Text view. */
const textViewCell = (cellId: string) => lineWithRecordings(storeCell(cellId), TEXT_VIEW_WORKSPACE_MAP, laneMap())

const lines = () => [...server.entries()].sort((a, b) => a[1].sequenceIndex - b[1].sequenceIndex)
const texts = () => lines().map(([, l]) => l.transcription)

let minted = 0
const mintId = () => `n${++minted}`

/** The workspace's applyLineSplit, without its toast: plan and write. */
async function split(pieces: LinePiece[], kept: { words: typeof WORDS; text: string; model?: string } | null = null, given?: LineHeard) {
  const plan = planLineSplit({ line, pieces, cell: textViewCell(line.cellId), kept, ...(given ? { given } : {}) })
  const result = await splitRecordingLine({ line, pieces: plan.pieces, author, mintId, ...(plan.heard ? { heard: plan.heard } : {}) })
  if (!result) throw new Error("nothing was split")
  return { plan, result }
}

beforeEach(() => {
  server.clear()
  sent.length = 0
  minted = 0
  server.set("c1", { transcription: "", startMs: 0, endMs: 12_000, trimStartMs: null, trimEndMs: null, sequenceIndex: 0 })
})

/** The recording's words found and kept on the whole line (At sentences, with words, then Cancel). */
async function wordsKeptOnTheLine() {
  await writeLineWords({ line, text: TEXT, author, heard: HEARD })
}
/** The text written by Transcribe sections: the transcript, its words timed against it. */
function transcribedBySections() {
  Object.assign(server.get("c1")!, { transcription: TEXT, timings: alignChunks(WORDS, TEXT), asr: { text: TEXT, model: "whisper-large-v3" } })
}

describe("Split at pauses in the Text view, on a recording that already has its text (import fix 09)", () => {
  for (const [how, give] of [["kept on the line by At sentences, with words", wordsKeptOnTheLine], ["from Transcribe sections", transcribedBySections]] as const) {
    it(`gives each new line its own part of the text (${how}), with no kept words in this browser`, async () => {
      await give()
      expect(server.get("c1")!.timings?.length).toBe(WORDS.length)
      const { plan } = await split(piecesFromCuts(line, PAUSES))
      expect(plan.stayed).toBe(false)
      expect(texts()).toEqual([S1, S2, S3])
      // Each line's words are timed from its own start.
      expect(lines()[1]![1].timings?.[0]).toMatchObject({ word: "This", t0: expect.closeTo(0.2, 3) })
    })
  }

  it("a line with typed text and no word times keeps it on the first line, and the toast is told why", async () => {
    server.get("c1")!.transcription = TEXT
    const { plan, result } = await split(piecesFromCuts(line, PAUSES))
    expect(plan.stayed).toBe("noTimes")
    expect(texts()).toEqual([TEXT, "", ""])
    // Nothing was rewritten on the line, so Undo has no text to put back.
    expect(result.first.text).toBeUndefined()
  })

  it("pins the workspace to these steps: cellWithAudio falls back to the lane's read, and the split plans with it", () => {
    const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
    expect(source).toMatch(/const cellWithAudio = useCallback\(\(cellId: string\): CellData \| null =>\s*lineWithRecordings\(getActiveCell\(cellId\), workspaceAudioByCellIdRef\.current, audioValidationByCellIdRef\.current\)/)
    const handler = source.slice(source.indexOf("const applyLineSplit = useCallback("), source.indexOf("const keepWordsOnLine = useCallback("))
    expect(handler).toMatch(/planLineSplit\(\{ line, pieces, cell: cellWithAudio\(line\.cellId\)/)
  })
})
