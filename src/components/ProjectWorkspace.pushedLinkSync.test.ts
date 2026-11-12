/**
 * AQU-1545 — what an open live-linked project re-reads after an upstream push
 * (`link.upstream-changed`) made it run a mirror sync.
 *
 * The sync writes this project's events server-side and broadcasts none of
 * them, so the workspace re-reads on its own. Before this it re-read the open
 * file's cells and nothing else: an upstream rename never reached the file
 * list, and the progress figures kept counting a cell the upstream had just
 * hidden, until a reload.
 *
 * Extract-the-logic pattern, same as runReconnectResync: pinned here rather
 * than by rendering the 11.5k-line shell's async connect effect.
 */
import { describe, it, expect, vi } from "vitest"
import { runAfterPushedLinkSync } from "./project-workspace-helpers"

function targets() {
  return {
    revalidateCells: vi.fn(),
    refreshProject: vi.fn(),
    invalidateProjectFileProgress: vi.fn(),
    refreshAllFilesProgress: vi.fn(async () => {}),
  }
}

describe("runAfterPushedLinkSync (AQU-1545)", () => {
  it("an upstream rename re-reads the project so the file list shows the new name", () => {
    const t = targets()

    runAfterPushedLinkSync({ synced: true, filesChanged: true }, t)

    expect(t.refreshProject).toHaveBeenCalledTimes(1)
    expect(t.revalidateCells).toHaveBeenCalledTimes(1)
  })

  it("an upstream hide or show refreshes the cells and the progress figures, not the project", () => {
    const t = targets()

    runAfterPushedLinkSync({ synced: true, filesChanged: false }, t)

    expect(t.revalidateCells).toHaveBeenCalledTimes(1)
    expect(t.invalidateProjectFileProgress).toHaveBeenCalledTimes(1)
    expect(t.refreshAllFilesProgress).toHaveBeenCalledTimes(1)
    // A cell-level change leaves the file list alone — no project re-read on
    // every upstream edit.
    expect(t.refreshProject).not.toHaveBeenCalled()
  })

  it("a sync that failed re-reads only the open file's cells", () => {
    const t = targets()

    runAfterPushedLinkSync({ synced: false, filesChanged: true }, t)

    expect(t.revalidateCells).toHaveBeenCalledTimes(1)
    expect(t.refreshProject).not.toHaveBeenCalled()
    expect(t.invalidateProjectFileProgress).not.toHaveBeenCalled()
    expect(t.refreshAllFilesProgress).not.toHaveBeenCalled()
  })

  it("a rejected progress re-read is swallowed", async () => {
    const t = { ...targets(), refreshAllFilesProgress: vi.fn(async () => { throw new Error("progress read failed") }) }

    expect(() => runAfterPushedLinkSync({ synced: true, filesChanged: false }, t)).not.toThrow()
    await Promise.resolve()

    expect(t.invalidateProjectFileProgress).toHaveBeenCalledTimes(1)
  })
})
