/**
 * AQU-2426 (browser pass, Nov 9): a take recorded over the hourly limit, the
 * page reloaded, and the next page carries the kept run on in the Text view.
 *
 * The Nov 9 fix (0d898c1b1) kept the waiting take as a one-row run and was
 * proved up to "the next page finds it". In the app the next page found it and
 * then dropped it: the run stayed in the browser for 5 to 12 s, was removed
 * with nothing done and nothing failed, no request was sent, and the take was
 * never transcribed (three runs, Chromium, `logs-1109/results/2-import-15`).
 *
 * The page built the run's rows from the workspace's audio map, which is not
 * fetched in the Text view unless the person may restructure lines (by default
 * nobody may). So the row came without its take, the batch found nothing to
 * transcribe, and ended the run.
 *
 * These tests take the run the way the recorder keeps it (`waitingTake`), let
 * the next page find it (`interruptedTranscribeRuns`), build its rows the way
 * the workspace now does (`carryOnRunCells`, with the Text view's empty
 * workspace map and the lane's read of the file's recordings), and hand them
 * to the real batch, with only the transcription request itself stood in.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const sent: string[] = []
vi.mock("@/lib/audio/transcribe", () => ({
  transcribeCellOutcome: vi.fn(async ({ cell }: { cell: { id: string } }) => {
    sent.push(cell.id)
    return { kind: "done" as const, words: 7 }
  }),
}))

import type { CellData } from "@/hooks/useCells"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { runTranscribeAll } from "@/lib/audio/batch-audio"
import {
  __setPageLeavingForTests,
  __setTranscribeRunEnvForTests,
  __storedTranscribeRuns,
  claimStoredTranscribeRun,
  interruptedTranscribeRuns,
  STALE_MS,
  transcribeRunFits,
} from "@/lib/audio/transcribe-runs"
import { clearTranscribeStatus } from "@/lib/audio/transcribe-status"
import { waitingTake } from "@/lib/audio/waiting-take"
import { carryOnReady } from "@/hooks/useCarryOnTranscribeRuns"
import { carryOnRunCells } from "./project-workspace-helpers"

const TAKE = "audio-c2-1794271992950-9pfycbtbt.wav"

/** The file's three subtitle lines, as the store has them: no recordings. */
const storeLines = (): CellData[] =>
  ["c1", "c2", "c3"].map((id) => ({ id, fileId: "f1", original: `Line ${id}.`, translated: "", medium: "text" }) as unknown as CellData)

/** The workspace's audio map in the Text view on a project with default settings: not fetched. */
const TEXT_VIEW_WORKSPACE_MAP = new Map<string, CellAudioEntry>()

/** The lane's read of the file's recordings (fetched in every view): the
 *  Spanish take on line 2, chosen, with no word times yet. */
const laneRead = (): Map<string, CellAudioEntry> => new Map([["c2", {
  attachments: { [TAKE]: { audioId: TAKE, url: `frontier-audio://p1/f1/${TAKE}`, slot: "recording", role: "dub", durationMs: 3_500 } },
  selectedBySlot: { recording: TAKE },
  selectedAudioId: TAKE,
  selectedGeneratedVoiceAudioId: null,
  audioTimings: {},
} as unknown as CellAudioEntry]])

let clock = 1_000_000

beforeEach(() => {
  sent.length = 0
  __setPageLeavingForTests(false)
  localStorage.clear()
  clock = 1_000_000
  __setTranscribeRunEnvForTests({ tab: "page-1", now: () => clock, locks: null })
})

/** The recorder: the take is refused at the limit and waits; the page reloads. */
function recordOverTheLimitThenReload() {
  const take = waitingTake({
    audioId: TAKE,
    // What AudioRecordingModal keeps for a take in the recording slot.
    keep: { projectId: "p1", fileId: "f1", fileName: "Take over the limit.vtt", cellId: "c2", username: "dev", lane: "Spanish", targetLanguage: "Spanish" },
    sleep: () => new Promise<void>(() => {}),
  })
  void take.onRateLimited(600)
  __setPageLeavingForTests(true)
  take.settled()
  // The next page: another tab id, nothing in memory about the take.
  __setPageLeavingForTests(false)
  clock += STALE_MS
  __setTranscribeRunEnvForTests({ tab: "page-2" })
  clearTranscribeStatus(TAKE)
}

describe("a take kept over the hourly limit, carried on after a reload in the Text view (import fix 15)", () => {
  it("is transcribed: the take is sent once and the kept run is done with", async () => {
    recordOverTheLimitThenReload()
    const [run] = await interruptedTranscribeRuns("p1")
    expect(run).toBeDefined()
    expect(transcribeRunFits(run!, { username: "dev", lane: "Spanish" })).toBe("ok")
    // The page is ready once the lane's read is in (the workspace's says
    // "loaded" at once in the Text view: it has nothing to read).
    expect(carryOnReady({ firstPaint: true, rowsLoading: false, recordingsLoaded: true, heardLinesLoading: false })).toBe(true)

    const handle = await claimStoredTranscribeRun(run!.id)
    expect(handle).not.toBeNull()
    const { cells, failedCells } = carryOnRunCells(run!, {
      heardLines: null,
      lines: storeLines(),
      workspaceAudio: TEXT_VIEW_WORKSPACE_MAP,
      laneAudio: laneRead(),
    })
    expect(cells.map((c) => [c.id, c.selectedAudioId])).toEqual([["c2", TAKE]])

    const report = await runTranscribeAll({
      cells,
      projectId: "p1",
      session: null,
      ...(run!.targetLanguage ? { targetLanguage: run!.targetLanguage } : {}),
      carryOn: { stored: run!, handle: handle!, failedCells },
    })
    expect(sent).toEqual(["c2"])
    expect(report).toMatchObject({ total: 1, transcribed: 1, failed: [], notRun: 0 })
    expect(__storedTranscribeRuns()).toEqual([])
  })

  it("rows the workspace's own map has keep that map's copy (the Media view)", () => {
    const own = laneRead()
    const pinned = { ...own.get("c2")!, audioTimings: { [TAKE]: [{ text: "Uno", start: 0, end: 0.4 }] } } as unknown as CellAudioEntry
    const { cells } = carryOnRunCells({ cellIds: ["c2"], doneIds: [], failed: [] }, {
      heardLines: null,
      lines: storeLines(),
      workspaceAudio: new Map([["c2", pinned]]),
      laneAudio: own,
    })
    expect(cells[0]!.audioTimings?.[TAKE]).toHaveLength(1)
  })

  it("a file whose takes live on its heard lines carries them on from those", () => {
    const heard = [{ id: "h2", fileId: "f1-cues", original: "Heard two.", selectedAudioId: TAKE } as unknown as CellData]
    const { cells, failedCells } = carryOnRunCells({ cellIds: ["h2", "h9"], doneIds: [], failed: [{ cellId: "h2" }] }, {
      heardLines: heard,
      lines: storeLines(),
      workspaceAudio: TEXT_VIEW_WORKSPACE_MAP,
      laneAudio: laneRead(),
    })
    expect(cells).toEqual([])
    expect(failedCells.map((c) => c.id)).toEqual(["h2"])
  })

  it("pins the workspace: the run carried on reads the lane's recordings, in every view", () => {
    const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
    const block = source.slice(source.indexOf("useCarryOnTranscribeRuns({"), source.indexOf("announce: (run, why) =>"))
    expect(block).toMatch(/recordingsLoaded: audioValidationLoaded/)
    expect(block).toMatch(/carryOnRunCells\(run, \{[\s\S]*laneAudio: audioValidationByCellIdRef\.current/)
    expect(block).not.toMatch(/mergeCellsWithAudio\(getActiveCells\(\), workspaceAudioByCellIdRef\.current\)/)
  })
})
