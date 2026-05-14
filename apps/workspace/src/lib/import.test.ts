// Phase 2c-β: importer emits file.create + N source.cell.create events
// instead of writing into a Y.Doc.

import { describe, it, expect, beforeEach } from "vitest"
import { importFile, emitParsedFile } from "./import"
import { peekOutboxBatch, resetOutboxConnectionForTests } from "./sync/outbox"
import type { TranslatableString } from "./parsers/types"

beforeEach(async () => {
  await resetOutboxConnectionForTests()
})

function makeString(id: string, original: string, group: string): TranslatableString {
  return {
    id,
    original,
    translated: "",
    context: "",
    group,
    type: "verse",
  }
}

describe("import — event emission (Phase 2c-β)", () => {
  it("emits file.create + N source.cell.create events with anchor-chain order", async () => {
    const refs = await emitParsedFile(
      {
        name: "GEN",
        strings: [
          makeString("GEN 1:1", "In the beginning…", "GEN 1"),
          makeString("GEN 1:2", "And the earth was…", "GEN 1"),
          makeString("GEN 1:3", "And God said…", "GEN 1"),
        ],
      },
      "usfm",
      {
        projectId: "p-1",
        author: "alice",
        sourceLanguage: "heb",
        targetLanguage: "eng",
      },
    )

    expect(refs.cellCount).toBe(3)

    const records = await peekOutboxBatch(200)
    expect(records.length).toBe(4)

    const kinds = records.map((r) => r.event.kind as string)
    expect(kinds[0]).toBe("file.create")
    expect(kinds.slice(1)).toEqual([
      "source.cell.create",
      "source.cell.create",
      "source.cell.create",
    ])

    const cellEvents = records.slice(1)
    // Anchor chain: first cell anchors null, second anchors first, third anchors second.
    const anchors = cellEvents.map((r) => {
      const p = r.event.payload as { anchorCellId?: string | null }
      return p.anchorCellId ?? null
    })
    expect(anchors[0]).toBeNull()
    expect(anchors[1]).toBe("GEN 1:1")
    expect(anchors[2]).toBe("GEN 1:2")

    // All cell events carry the genesis parentId (null).
    for (const r of cellEvents) {
      const ev = r.event as unknown as { parentId?: string | null; author: string; projectId: string }
      expect(ev.parentId ?? null).toBeNull()
      expect(ev.author).toBe("alice")
      expect(ev.projectId).toBe("p-1")
    }
  })

  it("importFile dispatches based on file extension and produces enqueue events", async () => {
    const blob = new Blob(["alpha\nbeta\ngamma\n"], { type: "text/plain" })
    const file = new File([blob], "notes.txt", { type: "text/plain" })

    const refs = await importFile(file, {
      projectId: "p-7",
      author: "carol",
    })
    expect(refs).toHaveLength(1)
    expect(refs[0].cellCount).toBeGreaterThan(0)

    const records = await peekOutboxBatch(200)
    // Filter to the events created by this test only (project p-7).
    const ourRecords = records.filter((r) => r.event.projectId === "p-7")
    expect(ourRecords[0].event.kind as string).toBe("file.create")
    expect(
      ourRecords.slice(1).every((r) => (r.event.kind as string) === "source.cell.create"),
    ).toBe(true)
  })
})
