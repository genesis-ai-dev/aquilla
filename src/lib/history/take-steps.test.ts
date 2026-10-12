// AQU-1767: undo and redo of trims, moves and cuts, and the "changed since" guard.
import { describe, it, expect, vi } from "vitest"
import { cutStep, takePlaceStep, takeWindowStep, type CutRecord } from "./take-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

describe("takeWindowStep / takePlaceStep", () => {
  it("puts the old window back only while the take still has the new one", async () => {
    let current = { trimStartMs: 100, trimEndMs: 900 }
    const apply = vi.fn(async (w: { trimStartMs?: number; trimEndMs?: number }) => {
      current = { trimStartMs: w.trimStartMs ?? 0, trimEndMs: w.trimEndMs ?? 0 }
    })
    const s = takeWindowStep({
      labelKey: "x", at: 1,
      before: { trimStartMs: 0, trimEndMs: 1000 },
      after: { trimStartMs: 100, trimEndMs: 900 },
      isAt: (w) => current.trimStartMs === w.trimStartMs && current.trimEndMs === w.trimEndMs,
      apply,
    })
    expect(await s.undo()).toEqual({ kind: "done" })
    expect(current).toEqual({ trimStartMs: 0, trimEndMs: 1000 })
    current = { trimStartMs: 50, trimEndMs: 1000 } // somebody trimmed it since
    expect(await s.redo()).toEqual({ kind: "skipped", reason: "changed" })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("a move whose take is gone is skipped as gone", async () => {
    const s = takePlaceStep({ at: 1, before: null, after: 250, isAt: () => null, apply: vi.fn() })
    expect(await s.undo()).toEqual({ kind: "skipped", reason: "gone" })
  })
})

describe("cutStep", () => {
  const record = (): CutRecord => ({
    cellId: "c1", audioId: "a", atMs: 1500, newAudioId: "b",
    before: { trimEndMs: null, label: "Take 1", targetOffsetMs: null },
    renamed: true,
  })

  it("undo joins the halves back while both are exactly as the cut left them", async () => {
    const takes: Record<string, Partial<CodexCellAttachment>> = {
      a: { trimEndMs: 1500 },
      b: { trimStartMs: 1500, pieceOf: "a" },
    }
    const uncut = vi.fn(async () => {})
    const s = cutStep({
      at: 1, cuts: [record()],
      readTake: (_c, id) => (takes[id] as CodexCellAttachment) ?? null,
      cut: vi.fn(), uncut, newPieceId: () => "c",
    })
    expect(await s.undo()).toEqual({ kind: "done" })
    expect(uncut).toHaveBeenCalledTimes(1)
  })

  it("is skipped once someone has moved or trimmed a piece, and nothing is joined", async () => {
    const takes: Record<string, Partial<CodexCellAttachment>> = {
      a: { trimEndMs: 1500 },
      b: { trimStartMs: 1500, targetOffsetMs: 400, pieceOf: "a" }, // moved since
    }
    const uncut = vi.fn(async () => {})
    const s = cutStep({
      at: 1, cuts: [record()],
      readTake: (_c, id) => (takes[id] as CodexCellAttachment) ?? null,
      cut: vi.fn(), uncut, newPieceId: () => "c",
    })
    expect(await s.undo()).toEqual({ kind: "skipped", reason: "changed" })
    expect(uncut).not.toHaveBeenCalled()
  })

  it("redo cuts again with a fresh id, only while the take is whole", async () => {
    const takes: Record<string, Partial<CodexCellAttachment>> = { a: {} }
    const cut = vi.fn(async () => true)
    const rec = record()
    const s = cutStep({
      at: 1, cuts: [rec],
      readTake: (_c, id) => (takes[id] as CodexCellAttachment) ?? null,
      cut, uncut: vi.fn(), newPieceId: () => "fresh",
    })
    expect(await s.redo()).toEqual({ kind: "done" })
    expect(cut).toHaveBeenCalledWith(rec, "fresh")
    expect(rec.newAudioId).toBe("fresh")
  })
})
