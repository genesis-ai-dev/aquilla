import { describe, expect, it, vi } from "vitest"
import { loadUpstreamStaleFiles } from "./useUpstreamChangesReview"
import type { StaleSourceResponse } from "@/lib/sync/stale-source-read-types"

function staleResponse(fileId: string, staleCellIds: string[]): StaleSourceResponse {
  return {
    projectId: "p1",
    fileId,
    staleCellIds,
    tombstonedCellIds: [],
    upstreamStaleCellIds: [],
    upstreamProjectId: null,
    behindSeq: null,
    ancestorBehind: false,
  }
}

describe("loadUpstreamStaleFiles", () => {
  it("scans more than 100 files completely with bounded concurrency", async () => {
    const files = Array.from({ length: 137 }, (_, index) => ({
      id: `f${index}`,
      name: `File ${index}`,
    }))
    let active = 0
    let maxActive = 0
    const fetchStale = vi.fn(async (_projectId: string, fileId: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return staleResponse(fileId, [`${fileId}-stale`])
    })

    const result = await loadUpstreamStaleFiles(
      "p1",
      files,
      async (fileId) => `token-${fileId}`,
      fetchStale,
    )

    expect(fetchStale).toHaveBeenCalledTimes(137)
    expect(maxActive).toBeLessThanOrEqual(6)
    expect(result.staleByFile).toHaveLength(137)
    expect(result.staleByFile.get("f136")?.stale).toEqual(new Set(["f136-stale"]))
    expect(result.projectToken).toBe("token-f0")
  })

  it("rejects the complete scan when any file cannot be read", async () => {
    const files = [
      { id: "ok", name: "Okay" },
      { id: "missing", name: "Missing token" },
    ]

    await expect(loadUpstreamStaleFiles(
      "p1",
      files,
      async (fileId) => fileId === "missing" ? null : "token",
      vi.fn(async (_projectId: string, fileId: string) => staleResponse(fileId, [])),
    )).rejects.toThrow("Missing token")
  })
})
