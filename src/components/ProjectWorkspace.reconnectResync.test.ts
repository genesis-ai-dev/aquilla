/**
 * AQU-817 — a WebSocket reconnect must pull the COMMENTS projection back too.
 *
 * The per-project DO holds no durable state and never replays (AD-1), so an
 * `event.applied` frame that lands while a client's socket is down is lost to
 * that client permanently. AQU-845 made the reopen re-read cells, audit stats
 * and file progress — but not comments, which are fed by the same broadcast.
 * A peer's thread therefore stayed invisible until a full page reload, which
 * is the reported "contributor's comment never reached the other member".
 *
 * Extract-the-logic pattern, same as shouldApplyCheckResult: the fan-out is
 * pinned here rather than by rendering the 11.5k-line shell.
 */
import { describe, it, expect, vi } from "vitest"
import { runReconnectResync } from "./project-workspace-helpers"

function targets(over: Partial<Parameters<typeof runReconnectResync>[0]> = {}) {
  return {
    revalidateCells: vi.fn(),
    revalidateAuditStats: vi.fn(),
    invalidateProjectFileProgress: vi.fn(),
    refreshComments: vi.fn(),
    refreshAllFilesProgress: vi.fn(async () => {}),
    ...over,
  }
}

describe("runReconnectResync (AQU-845 + AQU-817)", () => {
  it("re-reads every broadcast-fed projection, comments included", () => {
    const t = targets()

    runReconnectResync(t)

    expect(t.revalidateCells).toHaveBeenCalledTimes(1)
    expect(t.revalidateAuditStats).toHaveBeenCalledTimes(1)
    expect(t.invalidateProjectFileProgress).toHaveBeenCalledTimes(1)
    expect(t.refreshComments).toHaveBeenCalledTimes(1)
    expect(t.refreshAllFilesProgress).toHaveBeenCalledTimes(1)
  })

  it("a rejected comments refresh does not stop the rest of the resync", async () => {
    const t = targets({
      refreshComments: vi.fn(async () => { throw new Error("comments read failed") }),
    })

    expect(() => runReconnectResync(t)).not.toThrow()
    await Promise.resolve()

    expect(t.revalidateCells).toHaveBeenCalledTimes(1)
    expect(t.refreshAllFilesProgress).toHaveBeenCalledTimes(1)
  })

  it("a rejected progress refresh is swallowed — the next sidebar refresh retries", async () => {
    const t = targets({
      refreshAllFilesProgress: vi.fn(async () => { throw new Error("progress read failed") }),
    })

    expect(() => runReconnectResync(t)).not.toThrow()
    await Promise.resolve()

    expect(t.refreshComments).toHaveBeenCalledTimes(1)
  })
})
