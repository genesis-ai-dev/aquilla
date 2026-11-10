/**
 * AQU-2426 (review, Nov 9, finding 1): a take kept over the hourly limit, the
 * page reloaded on a bad connection, and the read of the file's recordings
 * fails (with its retries).
 *
 * `hasLoaded` turns true on a failed read too, so nothing waits forever. The
 * page carrying the run on took that for an answer: it built the row without
 * its take, the batch found nothing to do, ended the kept run and said "0 of
 * 1 transcribed", with no Retry. The take was never transcribed.
 *
 * Here the real read (`useFileAudioAttachments`, only the request stood in)
 * feeds the real carry-on hook the way ProjectWorkspace does: a failed read
 * is not an answer, so the run stays kept and the person is offered a Retry;
 * once a read answers, the run is carried on and the take is sent.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "dev" }, loading: false }),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  makeAudioSyncTokenFetcher: () => async () => "sync-tok",
}))
const fetchMock = vi.fn()
vi.mock("@/lib/sync/cell-audio-read", () => ({
  fetchFileAudioAttachments: (...args: unknown[]) => fetchMock(...args),
}))
vi.mock("@/lib/sync/outbox", () => ({
  getOutboxRecords: async () => [],
  subscribeToOutbox: () => () => {},
}))
const sent: string[] = []
vi.mock("@/lib/audio/transcribe", () => ({
  transcribeCellOutcome: vi.fn(async ({ cell }: { cell: { id: string } }) => {
    sent.push(cell.id)
    return { kind: "done" as const, words: 7 }
  }),
}))

import type { CellData } from "@/hooks/useCells"
import { runTranscribeAll } from "@/lib/audio/batch-audio"
import {
  __setPageLeavingForTests,
  __setTranscribeRunEnvForTests,
  __storedTranscribeRuns,
  STALE_MS,
  type StoredTranscribeRun,
  type TranscribeRunHandle,
} from "@/lib/audio/transcribe-runs"
import { clearTranscribeStatus } from "@/lib/audio/transcribe-status"
import { waitingTake } from "@/lib/audio/waiting-take"
import { carryOnRunCells } from "@/components/project-workspace-helpers"
import { useFileAudioAttachments } from "./useFileAudioAttachments"
import { carryOnReady, useCarryOnTranscribeRuns } from "./useCarryOnTranscribeRuns"

const TAKE = "audio-c2-1794271992950-9pfycbtbt.wav"
const THE_TAKE = {
  cells: {
    c2: {
      attachments: { [TAKE]: { audioId: TAKE, url: `frontier-audio://p1/f1/${TAKE}`, slot: "recording", durationMs: 3_500 } },
      selectedBySlot: { recording: TAKE },
      selectedAudioId: TAKE,
      selectedGeneratedVoiceAudioId: null,
      audioTimings: {},
    },
  },
}
const storeLines = (): CellData[] =>
  ["c1", "c2", "c3"].map((id) => ({ id, fileId: "f1", original: `Line ${id}.`, translated: "", medium: "text" }) as unknown as CellData)

let clock = 1_000_000

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0
  fetchMock.mockReset()
  localStorage.clear()
  __setPageLeavingForTests(false)
  clock = 1_000_000
  __setTranscribeRunEnvForTests({ tab: "page-1", now: () => clock, locks: null })
  // The recorder: refused at the limit, the take waits; the page reloads.
  const take = waitingTake({
    audioId: TAKE,
    keep: { projectId: "p1", fileId: "f1", fileName: "Take over the limit.vtt", cellId: "c2", username: "dev", lane: "Spanish", targetLanguage: "Spanish" },
    sleep: () => new Promise<void>(() => {}),
  })
  void take.onRateLimited(600)
  __setPageLeavingForTests(true)
  take.settled()
  __setPageLeavingForTests(false)
  clock += STALE_MS
  __setTranscribeRunEnvForTests({ tab: "page-2" })
  clearTranscribeStatus(TAKE)
  // The old page is gone, and its heartbeat with it.
  vi.clearAllTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** ProjectWorkspace's composition: the lane's read, and the carry-on fed from it. */
function useWorkspaceCarryOn(carryOn: (run: StoredTranscribeRun, handle: TranscribeRunHandle) => void) {
  const recordings = useFileAudioAttachments("p1", "f1", "Spanish")
  const carry = useCarryOnTranscribeRuns({
    projectId: "p1",
    activeFileId: "f1",
    ready: carryOnReady({ firstPaint: true, rowsLoading: false, recordingsLoaded: recordings.hasLoaded && recordings.answered, heardLinesLoading: false }),
    version: recordings.byCellId,
    username: "dev",
    lane: "Spanish",
    recordingsFailed: recordings.failed,
    carryOn,
    announce: () => {},
  })
  return { recordings, carry }
}

/** Let time pass in short steps, so the effects each step schedules run (React
 *  runs a render's effects when its `act` ends). */
const elapse = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) await act(async () => { await vi.advanceTimersByTimeAsync(250) })
}

describe("a kept take, after a reload whose recordings read fails", () => {
  it("is not ended: it waits, the person is offered a Retry, and a read that answers carries it on", async () => {
    fetchMock.mockRejectedValue(new Error("offline"))
    let carried: Promise<unknown> | null = null
    const { result } = renderHook(() => useWorkspaceCarryOn((run, handle) => {
      const { cells, failedCells } = carryOnRunCells(run, {
        heardLines: null, lines: storeLines(), workspaceAudio: new Map(), laneAudio: result.current.recordings.byCellId,
      })
      carried = runTranscribeAll({ cells, projectId: "p1", session: null, carryOn: { stored: run, handle, failedCells } })
    }))

    // The read and its three retries (0.4 s, 1.2 s, 3 s) all fail.
    await elapse(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(result.current.recordings.hasLoaded).toBe(true)
    expect(result.current.recordings.answered).toBe(false)
    expect(result.current.recordings.failed).toBe(true)
    // Not carried on, not ended, nothing sent: the run is still kept.
    expect(carried).toBeNull()
    expect(sent).toEqual([])
    expect(__storedTranscribeRuns().map((r) => r.cellIds)).toEqual([["c2"]])
    expect(result.current.carry.waitingOnRecordings).toBe(true)

    // Retry: the read answers.
    fetchMock.mockResolvedValue(THE_TAKE)
    await act(async () => { result.current.recordings.revalidate() })
    await elapse(3_000)
    expect(result.current.recordings.failed).toBe(false)
    expect(carried).not.toBeNull()
    await act(async () => { await carried })
    expect(sent).toEqual(["c2"])
    expect(__storedTranscribeRuns()).toEqual([])
    expect(result.current.carry.waitingOnRecordings).toBe(false)
  })

  it("a read that fails once and then answers on its own retry carries it on, with no Retry offered", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(THE_TAKE)
    let carried: Promise<unknown> | null = null
    const { result } = renderHook(() => useWorkspaceCarryOn((run, handle) => {
      const { cells, failedCells } = carryOnRunCells(run, {
        heardLines: null, lines: storeLines(), workspaceAudio: new Map(), laneAudio: result.current.recordings.byCellId,
      })
      carried = runTranscribeAll({ cells, projectId: "p1", session: null, carryOn: { stored: run, handle, failedCells } })
    }))
    await elapse(5_000)
    expect(result.current.recordings.failed).toBe(false)
    expect(result.current.carry.waitingOnRecordings).toBe(false)
    await act(async () => { await carried })
    expect(sent).toEqual(["c2"])
  })
})

describe("pins the workspace", () => {
  const source = readFileSync(join(__dirname, "..", "components", "ProjectWorkspace.tsx"), "utf8")
  const block = source.slice(source.indexOf("useCarryOnTranscribeRuns({"), source.indexOf("announce: (run, why) =>"))

  it("a failed recordings read is not ready, as a failed load of the lines is not", () => {
    expect(block).toMatch(/recordingsLoaded: audioValidationLoaded && audioValidationAnswered/)
    expect(block).toMatch(/recordingsFailed: /)
  })

  it("a run waiting on recordings that could not be read gets the lines' own Retry", () => {
    expect(source).toMatch(/<CellRowsLoadStatus[^>]*error=\{cellsError \|\| carryOnWaitingOnRecordings\}[^>]*onRetryClick=\{retryCellsAndRecordings\}/)
  })
})
