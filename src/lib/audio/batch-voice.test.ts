// AQU-1722: selection-driven batch voice generation.
//
// The plan is what the dialog shows the reader before any credits are spent,
// so the tests pin the two halves separately: what the plan PROMISES, and
// that the run does exactly that and reports everything it did not do.

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  planBatchVoice,
  runBatchVoice,
  hasGeneratedVoice,
  type BatchVoiceSkipReason,
} from "./batch-voice"
import { getBatchProgress, cancelBatchSynth } from "./batch-audio"
import { generateCellVoice } from "./voice-generate-helpers"
import { getTtsStatus } from "./tts"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

vi.mock("./voice-generate-helpers", () => ({
  generateCellVoice: vi.fn(async () => true),
}))

vi.mock("./tts", () => ({
  ttsStatusKey: (id: string) => `synth:${id}`,
  getTtsStatus: vi.fn(() => ({ kind: "idle" as const })),
  setTtsStatus: vi.fn(),
}))

const mockGenerate = vi.mocked(generateCellVoice)
const mockStatus = vi.mocked(getTtsStatus)

const cell = (id: string, overrides: Partial<CellData> = {}): CellData =>
  ({
    id,
    fileId: "f1",
    original: "Hello",
    translated: "one two three",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    context: "",
    group: "",
    type: "text",
    ...overrides,
  }) as CellData

const session = { jwt: "tok", username: "u" } as unknown as FrontierSession
const project = { id: "p1", sourceLanguage: "en" } as unknown as ProjectRecord

const reasonsFor = (
  skipped: readonly { cellId: string; reason: BatchVoiceSkipReason }[],
): Record<string, BatchVoiceSkipReason> =>
  Object.fromEntries(skipped.map((s) => [s.cellId, s.reason]))

beforeEach(() => {
  vi.clearAllMocks()
  mockGenerate.mockImplementation(async () => true)
  mockStatus.mockImplementation(() => ({ kind: "idle" }))
})

describe("planBatchVoice", () => {
  it("targets every translated line and counts its words", () => {
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b", { translated: "four more words here now" })],
      existing: "skip",
      isInFlight: () => false,
    })
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["a", "b"])
    expect(plan.words).toBe(8)
    expect(plan.skipped).toEqual([])
  })

  it("skips and REPORTS a line with no committed target text", () => {
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b", { translated: "   " })],
      existing: "skip",
      isInFlight: () => false,
    })
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["a"])
    expect(reasonsFor(plan.skipped)).toEqual({ b: "no-text" })
  })

  it("skips paratext — there is nothing to say on a heading", () => {
    const plan = planBatchVoice({
      cells: [cell("a", { type: "paratext" })],
      existing: "overwrite",
      isInFlight: () => false,
    })
    expect(plan.targets).toEqual([])
    expect(reasonsFor(plan.skipped)).toEqual({ a: "paratext" })
  })

  it("on `skip`, leaves a line that already has a generated take alone", () => {
    const withAudio = cell("b", { selectedGeneratedVoiceAudioId: "aud1" })
    expect(hasGeneratedVoice(withAudio)).toBe(true)
    const plan = planBatchVoice({
      cells: [cell("a"), withAudio],
      existing: "skip",
      isInFlight: () => false,
    })
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["a"])
    expect(reasonsFor(plan.skipped)).toEqual({ b: "has-audio" })
  })

  it("on `overwrite`, regenerates a line that already has a take — never silently", () => {
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b", { selectedGeneratedVoiceAudioId: "aud1" })],
      existing: "overwrite",
      isInFlight: () => false,
    })
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["a", "b"])
    expect(plan.skipped).toEqual([])
  })

  it("never queues a line whose generation is already running", () => {
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b")],
      existing: "skip",
      isInFlight: (id) => id === "b",
    })
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["a"])
    expect(reasonsFor(plan.skipped)).toEqual({ b: "in-flight" })
  })

  it("reads in-flight state from the per-cell tts badge by default", () => {
    mockStatus.mockImplementation((key: string) =>
      key === "synth:b" ? { kind: "synthesizing" } : { kind: "idle" },
    )
    const plan = planBatchVoice({ cells: [cell("a"), cell("b")], existing: "skip" })
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["a"])
    expect(reasonsFor(plan.skipped)).toEqual({ b: "in-flight" })
  })

  it("prices the batch up front in words and credits", () => {
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b")],
      existing: "skip",
      allowance: { remainingWords: null, wordsPerCredit: 3 },
      isInFlight: () => false,
    })
    expect(plan.words).toBe(6)
    expect(plan.credits).toBe(2)
    expect(plan.remainingWords).toBeNull()
  })

  it("stops at the allowance as a clean prefix, reporting every line past it", () => {
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b"), cell("c", { translated: "x" })],
      existing: "skip",
      // Room for the first line's three words only.
      allowance: { remainingWords: 4 },
      isInFlight: () => false,
    })
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["a"])
    // `c` is one word and would fit the leftover, but the stop is a prefix on
    // purpose: "it stopped at line 2" is explicable, "it did 1 and 3" is not.
    expect(reasonsFor(plan.skipped)).toEqual({ b: "over-allowance", c: "over-allowance" })
    expect(plan.overAllowance).toBe(2)
    expect(plan.exhausted).toBe(false)
  })

  it("flags an allowance with nothing left as exhausted rather than empty", () => {
    const plan = planBatchVoice({
      cells: [cell("a")],
      existing: "skip",
      allowance: { remainingWords: 0 },
      isInFlight: () => false,
    })
    expect(plan.targets).toEqual([])
    expect(plan.exhausted).toBe(true)
    expect(reasonsFor(plan.skipped)).toEqual({ a: "over-allowance" })
  })

  it("does not call a selection with no eligible lines exhausted", () => {
    const plan = planBatchVoice({
      cells: [cell("a", { translated: "" })],
      existing: "skip",
      allowance: { remainingWords: 500 },
      isInFlight: () => false,
    })
    expect(plan.targets).toEqual([])
    expect(plan.exhausted).toBe(false)
  })
})

describe("runBatchVoice", () => {
  it("speaks every planned line in the ONE chosen voice", async () => {
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b")],
      existing: "skip",
      isInFlight: () => false,
    })
    const result = await runBatchVoice({
      plan,
      project,
      session,
      username: "u",
      voiceId: "clone-7",
    })
    expect(result.generated).toBe(2)
    expect(result.failures).toEqual([])
    expect(mockGenerate).toHaveBeenCalledTimes(2)
    for (const call of mockGenerate.mock.calls) {
      expect(call[0].voiceId).toBe("clone-7")
      expect(call[0].surface).toBe("selection")
    }
  })

  it("passes the active lane through so takes land on that lane", async () => {
    const plan = planBatchVoice({ cells: [cell("a")], existing: "skip", isInFlight: () => false })
    await runBatchVoice({
      plan,
      project,
      session,
      username: "u",
      voiceId: "v1",
      targetLang: "swh",
    })
    expect(mockGenerate.mock.calls[0][0].targetLang).toBe("swh")
  })

  it("omits the lane entirely for the default lane", async () => {
    const plan = planBatchVoice({ cells: [cell("a")], existing: "skip", isInFlight: () => false })
    await runBatchVoice({ plan, project, session, username: "u", voiceId: "v1" })
    expect(mockGenerate.mock.calls[0][0]).not.toHaveProperty("targetLang")
  })

  it("reports progress on the shared queue, then clears it", async () => {
    const seen: string[] = []
    mockGenerate.mockImplementation(async () => {
      const p = getBatchProgress()
      seen.push(`${p?.kind}:${p?.done}/${p?.total}`)
      return true
    })
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b"), cell("c")],
      existing: "skip",
      isInFlight: () => false,
    })
    await runBatchVoice({ plan, project, session, username: "u", voiceId: "v1" })
    expect(seen[0]).toBe("synth:0/3")
    expect(getBatchProgress()).toBeNull()
  })

  it("keeps going past a failing line and names it with an actionable reason", async () => {
    mockGenerate.mockImplementation(async (a) => a.cell.id !== "b")
    mockStatus.mockImplementation((key: string) =>
      key === "synth:b"
        ? { kind: "error", message: "voice/tts failed (503): upstream unavailable" }
        : { kind: "idle" },
    )
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b"), cell("c")],
      existing: "skip",
      isInFlight: () => false,
    })
    const result = await runBatchVoice({ plan, project, session, username: "u", voiceId: "v1" })
    expect(result.generated).toBe(2)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].cellId).toBe("b")
    // AQU-344: never a bare "audio failed".
    expect(result.failures[0].title.length).toBeGreaterThan(0)
    expect(result.failures[0].title.toLowerCase()).not.toBe("audio failed")
    expect(result.failures[0].message.length).toBeGreaterThan(0)
    expect(result.notAttempted).toEqual([])
  })

  it("records a declined model download as a skip, not a failure", async () => {
    mockGenerate.mockImplementation(async (a) => a.cell.id !== "b")
    // The consent-denied path leaves the badge IDLE on purpose.
    mockStatus.mockImplementation(() => ({ kind: "idle" }))
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b")],
      existing: "skip",
      isInFlight: () => false,
    })
    const result = await runBatchVoice({ plan, project, session, username: "u", voiceId: "v1" })
    expect(result.failures).toEqual([])
    expect(reasonsFor(result.skipped)).toEqual({ b: "declined" })
  })

  it("stops cleanly when the provider's daily cap is hit, naming what it never reached", async () => {
    mockGenerate.mockImplementation(async (a) => a.cell.id !== "a")
    mockStatus.mockImplementation((key: string) =>
      key === "synth:a"
        ? { kind: "error", message: 'voice/tts failed (429): {"error":"tts_daily_limit_exceeded"}' }
        : { kind: "idle" },
    )
    const cells = Array.from({ length: 6 }, (_, i) => cell(i === 0 ? "a" : `c${i}`))
    const plan = planBatchVoice({ cells, existing: "skip", isInFlight: () => false })
    const result = await runBatchVoice({ plan, project, session, username: "u", voiceId: "v1" })
    expect(result.stoppedAtCap).toBe(true)
    expect(result.failures[0].category).toBe("daily-quota-exceeded")
    // The point of stopping: the remaining lines are REPORTED, not retried
    // into five more copies of the same budget message.
    expect(result.notAttempted.length).toBeGreaterThan(0)
    expect(mockGenerate.mock.calls.length).toBeLessThan(cells.length)
  })

  it("carries the plan's skips into the result so one summary covers the run", async () => {
    const plan = planBatchVoice({
      cells: [cell("a"), cell("b", { translated: "" })],
      existing: "skip",
      isInFlight: () => false,
    })
    const result = await runBatchVoice({ plan, project, session, username: "u", voiceId: "v1" })
    expect(result.generated).toBe(1)
    expect(reasonsFor(result.skipped)).toEqual({ b: "no-text" })
  })

  it("does nothing, and touches no queue, when the plan has no targets", async () => {
    const plan = planBatchVoice({
      cells: [cell("a", { translated: "" })],
      existing: "skip",
      isInFlight: () => false,
    })
    const result = await runBatchVoice({ plan, project, session, username: "u", voiceId: "v1" })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(result.generated).toBe(0)
    expect(getBatchProgress()).toBeNull()
  })

  it("honours the shared Cancel — the banner stops this batch too", async () => {
    mockGenerate.mockImplementation(async () => {
      cancelBatchSynth()
      return true
    })
    const cells = Array.from({ length: 8 }, (_, i) => cell(`c${i}`))
    const plan = planBatchVoice({ cells, existing: "skip", isInFlight: () => false })
    const result = await runBatchVoice({ plan, project, session, username: "u", voiceId: "v1" })
    expect(result.cancelled).toBe(true)
    expect(mockGenerate.mock.calls.length).toBeLessThan(cells.length)
    expect(result.notAttempted.length).toBeGreaterThan(0)
  })
})
