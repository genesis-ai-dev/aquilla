// A zero-shot batch must show its cost BEFORE anything runs, and the person's
// answer decides what runs: zero-shot, the automatic model, or nothing.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { runTranscribeAll } from "./batch-audio"
import { setTranscriptionModel } from "./transcription-model"
import { transcribeCell } from "./transcribe"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

vi.mock("./transcribe", () => ({ transcribeCell: vi.fn(async () => 5) }))
vi.mock("./transcribe-status", () => ({
  getTranscribeStatus: vi.fn(() => ({ kind: "idle" })),
  setTranscribeStatus: vi.fn(),
}))
vi.mock("./zero-shot-batch", () => ({
  batchAudioSeconds: () => 42,
  zeroShotBatchCostLine: vi.fn(async () => "≈ 12% of this week's remaining credits"),
}))

const session = { jwt: "tok", username: "user1" } as unknown as FrontierSession
const cells = ["c1", "c2"].map((id) => ({
  id, fileId: "f1", original: "Hello", context: "", selectedAudioId: `${id}.webm`,
  attachments: { [`${id}.webm`]: { url: "x", type: "audio" } },
}) as unknown as CellData)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe("zero-shot batch confirm", () => {
  it("never asks when the account uses the automatic model", async () => {
    const confirmZeroShot = vi.fn(async () => "zs" as const)
    await runTranscribeAll({ cells, projectId: "p", session, confirmZeroShot })
    expect(confirmZeroShot).not.toHaveBeenCalled()
    expect(transcribeCell).toHaveBeenCalledTimes(2)
  })

  it("asks once with the count and cost line, then runs zero-shot", async () => {
    setTranscriptionModel("user1", "omni-zs")
    const confirmZeroShot = vi.fn(async () => "zs" as const)
    await runTranscribeAll({ cells, projectId: "p", session, orgId: 7, confirmZeroShot })
    expect(confirmZeroShot).toHaveBeenCalledWith({ count: 2, costLine: "≈ 12% of this week's remaining credits" })
    expect(transcribeCell).toHaveBeenCalledTimes(2)
    expect(vi.mocked(transcribeCell).mock.calls[0][0]).not.toHaveProperty("forceAutoModel")
  })

  it("closing the confirm transcribes nothing", async () => {
    setTranscriptionModel("user1", "omni-zs")
    await runTranscribeAll({ cells, projectId: "p", session, confirmZeroShot: async () => "cancel" })
    expect(transcribeCell).not.toHaveBeenCalled()
  })

  it("Use automatic runs the batch without zero-shot, leaving the choice stored", async () => {
    setTranscriptionModel("user1", "omni-zs")
    await runTranscribeAll({ cells, projectId: "p", session, confirmZeroShot: async () => "auto" })
    expect(vi.mocked(transcribeCell).mock.calls.map(([args]) => args.forceAutoModel)).toEqual([true, true])
  })
})
