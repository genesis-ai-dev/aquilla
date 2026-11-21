import { describe, it, expect } from "vitest"
import type { CodexCell } from "../codex-editor/types"
import type { DiscoveredPointer } from "./gitlab/lfs"
import { buildOidIndex, oidForAttachmentUrl, planCellAudio, buildCellAudioEvents, currentTakeOf } from "./audio-copy"
import type { AudioImport } from "./audio"
import { audioAttachEventId, audioSelectEventId } from "./ids"
import type { IngestEvent } from "./types"

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

  it("lets only the take Codex has selected select itself", () => {
    const events = buildCellAudioEvents(
      "cue1",
      [take("old", 10), take("chosen", 20), take("newer", 30)],
      "chosen.webm",
      opts,
    )
    expect(attaches(events)).toEqual([
      ["old.webm", "history"],
      ["chosen.webm", "selects"],
      ["newer.webm", "history"],
    ])
  })

  // The regression this rule exists for. Mark 1–3 of a migrated project read
  // "unvalidated" because a 2025 recording, copyable only on a later run,
  // attached as an ordinary take and selected itself over the validated one.
  it("a take that only becomes copyable on a later run cannot take the verse over", () => {
    const first = buildCellAudioEvents("cue1", [take("early", 20), take("chosen", 30)], "chosen.webm", opts)
    const second = buildCellAudioEvents(
      "cue1",
      [take("late-arrival", 10), take("early", 20), take("chosen", 30)],
      "chosen.webm",
      opts,
    )
    // The ingest drops every id it has already seen, the pinning select
    // included, so what the late take's own attach does is all that happens.
    const seen = new Set(first.map((e) => e.id))
    const fresh = second.filter((e) => !seen.has(e.id))
    expect(fresh.map((e) => e.kind)).toEqual(["cell.audio.attach"])
    expect(attaches(fresh)).toEqual([["late-arrival.webm", "history"]])
  })

  it("keeps the newest take selectable when Codex has nothing selected, as Codex shows it", () => {
    const events = buildCellAudioEvents("cue1", [take("older", 10), take("newest", 30), take("middle", 20)], null, opts)
    expect(attaches(events)).toEqual([
      ["older.webm", "history"],
      ["newest.webm", "selects"],
      ["middle.webm", "history"],
    ])
    expect(events.some((e) => e.kind === "cell.audio.select")).toBe(false)
  })

  it("keeps a take selectable when the selected one was not copied, so the verse is not left silent", () => {
    const events = buildCellAudioEvents("cue1", [take("older", 10), take("newer", 20)], "lost-in-lfs.webm", opts)
    expect(attaches(events)).toEqual([
      ["older.webm", "history"],
      ["newer.webm", "selects"],
    ])
  })

  it("the audited recovery form lets nothing but the explicit selection select", () => {
    const strict = { ...opts, preserveUnselectedHistory: true }
    expect(attaches(buildCellAudioEvents("cue1", [take("recovered", 10)], null, strict))).toEqual([
      ["recovered.webm", "history"],
    ])
    expect(attaches(buildCellAudioEvents("cue1", [take("old", 10), take("chosen", 20)], "chosen.webm", strict))).toEqual([
      ["old.webm", "history"],
      ["chosen.webm", "selects"],
    ])
  })
})

describe("currentTakeOf", () => {
  it("is Codex's explicit selection when that take was copied", () => {
    expect(currentTakeOf([take("chosen", 10), take("newer", 20)], "chosen.webm")).toBe("chosen.webm")
  })

  it("falls back to the newest copied take when nothing is selected or the selection was not copied", () => {
    const copied = [take("a", 10), take("c", 30), take("b", 20)]
    expect(currentTakeOf(copied, null)).toBe("c.webm")
    expect(currentTakeOf(copied, "lost-in-lfs.webm")).toBe("c.webm")
  })

  it("keeps notebook order on a tie, which is what Codex's own sort does", () => {
    expect(currentTakeOf([take("first"), take("second")], null)).toBe("first.webm")
    expect(currentTakeOf([take("first", 5), take("second", 5)], null)).toBe("first.webm")
  })

  it("is null for a cell with no copied takes", () => {
    expect(currentTakeOf([], "chosen.webm")).toBeNull()
  })
})

function take(id: string, createdAt?: number): AudioImport {
  return {
    aquillaAudioId: `${id}.webm`,
    legacyAudioId: id,
    diskRelPath: `x/${id}.webm`,
    slot: "recording",
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

/** Each attach in order, and whether it may select its own row. */
function attaches(events: IngestEvent[]): Array<[string, "selects" | "history"]> {
  return events
    .filter((e) => e.kind === "cell.audio.attach")
    .map((e) => [String(e.payload.audioId), e.payload.historyOnly === true ? "history" : "selects"])
}
