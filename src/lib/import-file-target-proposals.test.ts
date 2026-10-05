// AQU-1673 — "Import as proposals" staging pipeline.
//
// The feature's whole value is that nothing is written: an uploaded
// translation set becomes ONE changeset of proposals behind the approval gate.
// These tests pin the contract the UI depends on — what gets staged, what gets
// skipped, what provenance rides along, and that a non-staged answer is
// reported as a failure rather than as a success the reviewer can't find.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileTargetMatchedCell } from "@/lib/import-file-target"

const prepareSessionChangeset = vi.fn()
vi.mock("@/lib/agent/changeset-api", () => ({
  prepareSessionChangeset: (...args: unknown[]) => prepareSessionChangeset(...args),
}))

const { stageTargetImportAsProposals, isUnchangedProposal, IMPORT_ORIGIN_FILENAME_MAX } =
  await import("./import-file-target-proposals")

function cell(over: Partial<FileTargetMatchedCell> & { cellId: string }): FileTargetMatchedCell {
  return {
    cellId: over.cellId,
    fileId: over.fileId ?? "file-1",
    incomingText: over.incomingText ?? "nueva",
    currentText: over.currentText ?? "",
    hasConflict: over.hasConflict ?? false,
    parentId: over.parentId ?? "evt-1",
    ref: over.ref ?? "GEN 1:1",
  } as FileTargetMatchedCell
}

const CTX = {
  jwt: "jwt-1",
  projectId: "proj-1",
  sourceFileName: "samuel-revisions.csv",
}

function staged(id = "cs-1") {
  return { id, status: "staged" }
}

beforeEach(() => {
  prepareSessionChangeset.mockReset()
  prepareSessionChangeset.mockResolvedValue(staged())
})

describe("isUnchangedProposal", () => {
  it("treats a value equal to the current translation as a no-op", () => {
    expect(isUnchangedProposal({ incomingText: "hola", currentText: "hola" })).toBe(true)
  })

  it("ignores surrounding whitespace — not a change worth a reviewer's time", () => {
    expect(isUnchangedProposal({ incomingText: " hola ", currentText: "hola" })).toBe(true)
  })

  it("counts a real difference as a change", () => {
    expect(isUnchangedProposal({ incomingText: "hola amigo", currentText: "hola" })).toBe(false)
  })

  it("counts filling an empty cell as a change", () => {
    expect(isUnchangedProposal({ incomingText: "hola", currentText: "" })).toBe(false)
  })
})

describe("stageTargetImportAsProposals", () => {
  it("stages one changeset of SetTranslation commands for the selected cells", async () => {
    const matched = [cell({ cellId: "c1" }), cell({ cellId: "c2", incomingText: "otra" })]
    const result = await stageTargetImportAsProposals(matched, new Set(["c1", "c2"]), CTX)

    expect(prepareSessionChangeset).toHaveBeenCalledTimes(1)
    const [jwt, projectId, commands] = prepareSessionChangeset.mock.calls[0]
    expect(jwt).toBe("jwt-1")
    expect(projectId).toBe("proj-1")
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({
      kind: "SetTranslation",
      fileId: "file-1",
      cellId: "c1",
      value: "nueva",
    })
    expect(result).toMatchObject({ stagedCount: 2, skippedUnchangedCount: 0, changesetId: "cs-1" })
  })

  it("stages only the cells the user ticked", async () => {
    const matched = [cell({ cellId: "c1" }), cell({ cellId: "c2" })]
    await stageTargetImportAsProposals(matched, new Set(["c2"]), CTX)
    const commands = prepareSessionChangeset.mock.calls[0][2]
    expect(commands.map((c: { cellId: string }) => c.cellId)).toEqual(["c2"])
  })

  it("skips values that already match the current translation and reports the count", async () => {
    const matched = [
      cell({ cellId: "c1", incomingText: "hola", currentText: "hola" }),
      cell({ cellId: "c2", incomingText: "nueva", currentText: "vieja" }),
    ]
    const result = await stageTargetImportAsProposals(matched, new Set(["c1", "c2"]), CTX)

    const commands = prepareSessionChangeset.mock.calls[0][2]
    expect(commands.map((c: { cellId: string }) => c.cellId)).toEqual(["c2"])
    expect(result).toMatchObject({ stagedCount: 1, skippedUnchangedCount: 1 })
  })

  it("stages nothing — and calls no endpoint — when every row is a no-op", async () => {
    const matched = [cell({ cellId: "c1", incomingText: "hola", currentText: "hola" })]
    const result = await stageTargetImportAsProposals(matched, new Set(["c1"]), CTX)

    expect(prepareSessionChangeset).not.toHaveBeenCalled()
    expect(result).toEqual({ stagedCount: 0, skippedUnchangedCount: 1, changesetId: null })
  })

  it("stamps every proposal with the uploaded file's name as provenance", async () => {
    const matched = [cell({ cellId: "c1" }), cell({ cellId: "c2" })]
    await stageTargetImportAsProposals(matched, new Set(["c1", "c2"]), CTX)

    const commands = prepareSessionChangeset.mock.calls[0][2]
    for (const c of commands) {
      expect(c.importOrigin.fileName).toBe("samuel-revisions.csv")
      expect(typeof c.importOrigin.importedAt).toBe("number")
    }
    // One upload, one stamp — all proposals share the import's timestamp.
    expect(commands[0].importOrigin.importedAt).toBe(commands[1].importOrigin.importedAt)
  })

  it("trims an over-long file name rather than failing the whole staging", async () => {
    const matched = [cell({ cellId: "c1" })]
    await stageTargetImportAsProposals(matched, new Set(["c1"]), {
      ...CTX,
      sourceFileName: `${"x".repeat(IMPORT_ORIGIN_FILENAME_MAX + 50)}.csv`,
    })
    const commands = prepareSessionChangeset.mock.calls[0][2]
    expect(commands[0].importOrigin.fileName).toHaveLength(IMPORT_ORIGIN_FILENAME_MAX)
  })

  it("sends laneId for a non-default lane", async () => {
    const matched = [cell({ cellId: "c1" })]
    await stageTargetImportAsProposals(matched, new Set(["c1"]), { ...CTX, targetLang: "es" })
    expect(prepareSessionChangeset.mock.calls[0][2][0].laneId).toBe("es")
  })

  it("omits laneId for the default lane — the worker rejects '' as a lane id", async () => {
    const matched = [cell({ cellId: "c1" })]
    await stageTargetImportAsProposals(matched, new Set(["c1"]), { ...CTX, targetLang: "" })
    expect(prepareSessionChangeset.mock.calls[0][2][0]).not.toHaveProperty("laneId")
  })

  it("never sends AD-2 parent ids — prepare computes preconditions server-side", async () => {
    const matched = [cell({ cellId: "c1", parentId: "evt-head" })]
    await stageTargetImportAsProposals(matched, new Set(["c1"]), CTX)
    expect(prepareSessionChangeset.mock.calls[0][2][0]).not.toHaveProperty("parentId")
  })

  it("stages a cell the direct path could never commit (no resolvable parent)", async () => {
    // AQU-1669's unchainable class: the direct importer throws on these
    // because a commit must chain on a head. A proposal has no parent to
    // resolve, so this path stages it normally.
    const matched = [cell({ cellId: "c1", parentId: "" })]
    const result = await stageTargetImportAsProposals(matched, new Set(["c1"]), CTX)
    expect(result.stagedCount).toBe(1)
  })

  it("throws when prepare answers with something other than a staged plan", async () => {
    prepareSessionChangeset.mockResolvedValue({ id: "cs-9", status: "stale" })
    const matched = [cell({ cellId: "c1" })]
    await expect(
      stageTargetImportAsProposals(matched, new Set(["c1"]), CTX),
    ).rejects.toThrow(/stale/)
  })

  it("propagates a staging failure so the caller can report it", async () => {
    prepareSessionChangeset.mockRejectedValue(new Error("stage changeset failed"))
    const matched = [cell({ cellId: "c1" })]
    await expect(
      stageTargetImportAsProposals(matched, new Set(["c1"]), CTX),
    ).rejects.toThrow("stage changeset failed")
  })
})
