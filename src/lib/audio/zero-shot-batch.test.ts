import { afterEach, describe, expect, it, vi } from "vitest"
import { estimateZeroShotCredits, shareOfRemainingCredits } from "./omni-cost-estimate"
import { batchAudioSeconds, zeroShotBatchCostLine } from "./zero-shot-batch"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/frontier/auth", () => ({ AUTH_BASE: "http://identity", FRONTIER_BASE: "http://identity" }))
afterEach(() => vi.restoreAllMocks())

// The only price a zero-shot user sees comes before a batch, so the numbers
// must follow the server's billing formula: audio s × GPU-s per audio s ×
// GPU ¢/s × amortization, then the org's credit markup.

function take(attachment: Record<string, unknown> | null): CellData {
  return {
    id: "c", fileId: "f", original: "", context: "",
    ...(attachment ? { selectedAudioId: "a", attachments: { a: { url: "x", type: "audio", ...attachment } } } : {}),
  } as unknown as CellData
}

describe("zero-shot batch estimate", () => {
  it("prices GPU time with the L40S rate, 1.5× amortization and the markup", () => {
    // 100 s × 0.25 × 0.0542 ¢ × 1.5 = 2.0325 ¢ raw, × 4 = 8.13 → 9 credits.
    expect(estimateZeroShotCredits(100, 0.25, 4)).toBe(9)
    // The server's own GPU-s figure and the org's markup both move the price.
    expect(estimateZeroShotCredits(100, 0.5, 4)).toBe(17)
    expect(estimateZeroShotCredits(100, 0.25, 2)).toBe(5)
  })

  it("states the share of what is left, never 0% for a real cost", () => {
    expect(shareOfRemainingCredits(9, 90)).toBe(10)
    expect(shareOfRemainingCredits(1, 100_000)).toBe(1)
    expect(shareOfRemainingCredits(9, 0)).toBeNull()
  })

  it("counts each take's kept part, and an unmeasured take as a full window", () => {
    expect(batchAudioSeconds([
      take({ durationMs: 12_000 }),
      take({ durationMs: 20_000, trimStartMs: 2_000, trimEndMs: 8_000 }),
      take({}),
    ])).toBe(12 + 6 + 30)
  })

  it("shows a share of this week's credits when the reader may see the balance", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).includes("/status")
      ? Response.json({ state: "ready", estGpuSecPerAudioSec: 0.25 })
      : Response.json({ config: { markup: 4 }, remaining: { weekly: 90, daily: 10 } }))
    await expect(zeroShotBatchCostLine({ jwt: "j", projectId: "p", orgId: 7, audioSec: 100 }))
      .resolves.toBe("≈ 10% of this week's remaining credits")
  })

  it("falls back to an absolute amount when the credits endpoint answers 403", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).includes("/status")
      ? Response.json({ state: "cold" })
      : new Response(null, { status: 403 }))
    // No server figure: the 0.25 fallback, the default ×4 markup → 9 credits.
    await expect(zeroShotBatchCostLine({ jwt: "j", projectId: "p", orgId: 7, audioSec: 100 }))
      .resolves.toBe("≈ 9 cr for this batch")
  })
})
