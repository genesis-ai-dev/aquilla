import { describe, it, expect } from "vitest"
import type { CodexCell } from "../codex-editor/types"
import type { DiscoveredPointer } from "./gitlab/lfs"
import { buildOidIndex, oidForAttachmentUrl, planCellAudio, buildCellAudioEvents } from "./audio-copy"
import { audioAttachEventId, audioSelectEventId } from "./ids"

function cell(metadata: Record<string, unknown>): CodexCell {
  return { kind: 2, languageId: "html", value: "", metadata: metadata as never }
}

function ptr(relativePath: string, oid: string): DiscoveredPointer {
  return {
    pointer: { oid, size: 1 },
    pointerAbsPath: `/abs/${relativePath}`,
    filesAbsPath: `/abs/${relativePath.replace("/pointers/", "/files/")}`,
    relativePath,
  }
}

const OID1 = "11".repeat(32)
const OID2 = "22".repeat(32)

describe("oid resolution from the pointers tree", () => {
  it("resolves an attachment url (a files-tree path) to its LFS oid", () => {
    // discoverPointers yields pointers/ paths; the cell metadata references the
    // parallel files/ path. The index must bridge the two.
    const index = buildOidIndex([
      ptr(".project/attachments/pointers/seg/a1.webm", OID1),
      ptr(".project/attachments/pointers/seg/a2.webm", OID2),
    ])
    expect(oidForAttachmentUrl(index, ".project/attachments/files/seg/a1.webm")).toBe(OID1)
    expect(oidForAttachmentUrl(index, ".project/attachments/files/seg/a2.webm")).toBe(OID2)
  })

  it("tolerates leading ./ and backslash variants in the attachment url", () => {
    const index = buildOidIndex([ptr(".project/attachments/pointers/seg/a1.webm", OID1)])
    expect(oidForAttachmentUrl(index, "./.project/attachments/files/seg/a1.webm")).toBe(OID1)
    expect(oidForAttachmentUrl(index, ".project\\attachments\\files\\seg\\a1.webm")).toBe(OID1)
  })

  it("returns undefined when no pointer matches", () => {
    const index = buildOidIndex([ptr(".project/attachments/pointers/seg/a1.webm", OID1)])
    expect(oidForAttachmentUrl(index, ".project/attachments/files/seg/missing.webm")).toBeUndefined()
  })
})

describe("planCellAudio", () => {
  const index = buildOidIndex([
    ptr(".project/attachments/pointers/seg/a1.webm", OID1),
    ptr(".project/attachments/pointers/seg/a2.webm", OID2),
  ])

  it("pairs every non-deleted take with its oid and flags the selected take", () => {
    const c = cell({
      id: "cue1",
      selectedAudioId: "a2",
      attachments: {
        a1: { url: ".project/attachments/files/seg/a1.webm", type: "audio", isDeleted: false },
        a2: { url: ".project/attachments/files/seg/a2.webm", type: "audio", isDeleted: false },
      },
    })
    const plan = planCellAudio(c, index)
    expect(plan.copies.map((c) => [c.take.aquillaAudioId, c.oid])).toEqual([
      ["a1.webm", OID1],
      ["a2.webm", OID2],
    ])
    expect(plan.missingOid).toHaveLength(0)
    expect(plan.selectedAquillaAudioId).toBe("a2.webm")
  })

  it("separates takes whose oid can't be resolved (so the driver can surface them)", () => {
    const c = cell({
      id: "cue1",
      attachments: {
        a1: { url: ".project/attachments/files/seg/a1.webm", type: "audio", isDeleted: false },
        gone: { url: ".project/attachments/files/seg/gone.webm", type: "audio", isDeleted: false },
      },
    })
    const plan = planCellAudio(c, index)
    expect(plan.copies.map((c) => c.take.aquillaAudioId)).toEqual(["a1.webm"])
    expect(plan.missingOid.map((t) => t.aquillaAudioId)).toEqual(["gone.webm"])
  })

  it("selectedAquillaAudioId is null when the legacy selection is absent/deleted", () => {
    const c = cell({
      id: "cue1",
      selectedAudioId: "a2",
      attachments: {
        a1: { url: ".project/attachments/files/seg/a1.webm", type: "audio", isDeleted: false },
        a2: { url: ".project/attachments/files/seg/a2.webm", type: "audio", isDeleted: true },
      },
    })
    const plan = planCellAudio(c, index)
    expect(plan.selectedAquillaAudioId).toBeNull()
  })
})

describe("buildCellAudioEvents", () => {
  const opts = { projectId: "p", fileId: "f", fallbackAuthor: "x", fallbackTs: 1 }

  it("emits one attach per copied take, then a select for the active take", () => {
    const copied = [
      { aquillaAudioId: "a1.webm", legacyAudioId: "a1", diskRelPath: "x/a1.webm", slot: "recording" as const, createdAt: 10 },
      { aquillaAudioId: "a2.webm", legacyAudioId: "a2", diskRelPath: "x/a2.webm", slot: "recording" as const, createdAt: 20 },
    ]
    const events = buildCellAudioEvents("cue1", copied, "a2.webm", opts)
    expect(events.map((e) => e.kind)).toEqual([
      "cell.audio.attach",
      "cell.audio.attach",
      "cell.audio.select",
    ])
    expect(events[0].id).toBe(audioAttachEventId("p", "f", "cue1", "a1.webm"))
    expect(events[2].id).toBe(audioSelectEventId("p", "f", "cue1", "a2.webm"))
    expect(events[2].payload).toMatchObject({ audioId: "a2.webm", slot: "recording" })
  })

  it("omits the select when the active take was not among the copied takes", () => {
    // e.g. the selected take was an lfs-miss — don't pin a take that isn't there.
    const copied = [
      { aquillaAudioId: "a1.webm", legacyAudioId: "a1", diskRelPath: "x/a1.webm", slot: "recording" as const, createdAt: 10 },
    ]
    const events = buildCellAudioEvents("cue1", copied, "a2.webm", opts)
    expect(events.map((e) => e.kind)).toEqual(["cell.audio.attach"])
  })

  it("omits the select when there is no active take", () => {
    const copied = [
      { aquillaAudioId: "a1.webm", legacyAudioId: "a1", diskRelPath: "x/a1.webm", slot: "recording" as const, createdAt: 10 },
    ]
    const events = buildCellAudioEvents("cue1", copied, null, opts)
    expect(events.map((e) => e.kind)).toEqual(["cell.audio.attach"])
  })
})
