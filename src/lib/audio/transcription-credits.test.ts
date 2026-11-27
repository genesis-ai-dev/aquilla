// AQU-2426 (review, Nov 9): the cost step's Credits line was worked out as a
// zero-shot run (Omnilingual, by GPU time) whatever model the recording would
// really go to. A 52-minute English recording goes to Whisper, which is priced
// by the audio second at a rate only the server reads, and the line said about
// 500 credits for a charge of about 10. The line is now worked out for the
// model that will run, and left out when its price can't be known here.

import { beforeEach, describe, expect, it, vi } from "vitest"

const { getOrgCredits, fetchOmniStatus } = vi.hoisted(() => ({ getOrgCredits: vi.fn(), fetchOmniStatus: vi.fn() }))
vi.mock("@/lib/sync/credits", () => ({ getOrgCredits }))
vi.mock("./omni-warmup", () => ({
  fetchOmniStatus,
  fetchZsStatus: (jwt: string, projectId: string) => fetchOmniStatus(jwt, projectId, "zs"),
}))

import { transcriptionCredits } from "./transcription-credits"

const org = { config: { markup: 4 }, remaining: { weekly: 1000 } }
const args = { jwt: "jwt", projectId: "p1", orgId: 7, audioSec: 52 * 60 }

beforeEach(() => {
  vi.clearAllMocks()
  getOrgCredits.mockResolvedValue(org)
  fetchOmniStatus.mockResolvedValue({ state: "ready", estGpuSecPerAudioSec: 0.1 })
})

describe("transcriptionCredits", () => {
  it.each(["whisper", "qwen3-asr"] as const)("%s: no credits figure, since its price is the server's to read", async (model) => {
    const found = await transcriptionCredits({ ...args, model })
    expect(found.credits).toBeNull()
    expect(found.percent).toBeNull()
    // Nothing asked of Omnilingual for a recording that never goes there.
    expect(fetchOmniStatus).not.toHaveBeenCalled()
  })

  it("still hands back the organization's credits, which say whether it can pay at all", async () => {
    expect((await transcriptionCredits({ ...args, model: "whisper" })).orgCredits).toBe(org)
  })

  it("Omnilingual: worked out from that model's own GPU time and rate", async () => {
    const found = await transcriptionCredits({ ...args, model: "omni-ctc" })
    expect(fetchOmniStatus).toHaveBeenCalledWith("jwt", "p1", "ctc")
    // 3,120 s × 0.1 GPU-s per audio-s × 0.0222 ¢ (L4) × 1.5 × markup 4.
    expect(found.credits).toBe(Math.ceil(3120 * 0.1 * 0.0222 * 1.5 * 4))
    expect(found.percent).toBe(5)
  })

  it("Omnilingual with no status to read: the conservative figure for that model", async () => {
    fetchOmniStatus.mockRejectedValue(new Error("HTTP 403"))
    const found = await transcriptionCredits({ ...args, model: "omni-ctc" })
    expect(found.credits).toBe(42)
  })
})
