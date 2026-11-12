// AQU-1673 — imported proposals must be distinguishable on the approval page.
//
// "Import as proposals" stages an uploaded translation set through the same
// changeset gate an agent uses, so by the time it reaches a reviewer it looks
// exactly like AI work. The one thing that tells them apart is the provenance
// the command carries: a proposal read out of a file names that file; an AI
// draft and a hand-written agent proposal name nothing.
//
// Without this the reviewer cannot tell a consultant's human translation from
// model output, and would review the former as machine text.

import { describe, it, expect } from "vitest"
import { buildChangeDetails } from "../lib/changeset-approval-changes"

/** Minimal `cells`/`files` stub in the D1-shaped shim shape the real code
 *  queries through. Two statements, in the order buildChangeDetails issues
 *  them: the cell lookup, then the file-name lookup. */
function stubDb(
  cellRows: {
    file_id: string
    cell_id: string
    side: string
    target_lang: string
    value: string
    canonical_ref: string | null
  }[],
  fileRows: { id: string; name: string }[] = [{ id: "f1", name: "Genesis" }],
) {
  return {
    prepare(sql: string) {
      const rows = sql.includes("FROM cells") ? cellRows : fileRows
      return {
        bind: () => ({ all: async () => ({ results: rows }) }),
      }
    },
  } as unknown as Parameters<typeof buildChangeDetails>[0]
}

const SOURCE_ROW = {
  file_id: "f1",
  cell_id: "c1",
  side: "source",
  target_lang: "",
  value: "In the beginning",
  canonical_ref: "GEN 1:1",
}

const IMPORTED = {
  kind: "SetTranslation",
  fileId: "f1",
  cellId: "c1",
  value: "En el principio",
  importOrigin: { fileName: "samuel-revisions.csv", importedAt: 1_700_000_000_000 },
}

describe("buildChangeDetails — imported-proposal provenance (AQU-1673)", () => {
  it("names the file an imported proposal came from", async () => {
    const out = await buildChangeDetails(stubDb([SOURCE_ROW]), "p1", JSON.stringify([IMPORTED]))
    expect(out.changes?.items[0].importedFrom).toBe("samuel-revisions.csv")
  })

  it("leaves provenance absent on an ordinary agent proposal", async () => {
    const plain = { kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "En el principio" }
    const out = await buildChangeDetails(stubDb([SOURCE_ROW]), "p1", JSON.stringify([plain]))
    expect(out.changes?.items[0]).not.toHaveProperty("importedFrom")
  })

  it("still carries the before/after a reviewer approves on", async () => {
    const out = await buildChangeDetails(
      stubDb([
        SOURCE_ROW,
        {
          file_id: "f1",
          cell_id: "c1",
          side: "target",
          target_lang: "",
          value: "previous wording",
          canonical_ref: "GEN 1:1",
        },
      ]),
      "p1",
      JSON.stringify([IMPORTED]),
    )
    expect(out.changes?.items[0]).toMatchObject({
      before: "previous wording",
      after: "En el principio",
      source: "In the beginning",
      canonicalRef: "GEN 1:1",
      importedFrom: "samuel-revisions.csv",
    })
  })

  it.each([
    ["a blank file name", { fileName: "", importedAt: 1 }],
    ["a non-string file name", { fileName: 42, importedAt: 1 }],
    ["no file name at all", { importedAt: 1 }],
    ["a non-object origin", "samuel-revisions.csv"],
  ])("omits provenance rather than rendering junk for %s", async (_label, importOrigin) => {
    const out = await buildChangeDetails(
      stubDb([SOURCE_ROW]),
      "p1",
      JSON.stringify([{ ...IMPORTED, importOrigin }]),
    )
    expect(out.changes?.items[0]).not.toHaveProperty("importedFrom")
  })

  it("marks each row with its own origin in a mixed changeset", async () => {
    const out = await buildChangeDetails(
      stubDb([
        SOURCE_ROW,
        { ...SOURCE_ROW, cell_id: "c2", value: "And the earth", canonical_ref: "GEN 1:2" },
      ]),
      "p1",
      JSON.stringify([
        IMPORTED,
        { kind: "SetTranslation", fileId: "f1", cellId: "c2", value: "Y la tierra" },
      ]),
    )
    const items = out.changes?.items ?? []
    expect(items).toHaveLength(2)
    expect(items[0].importedFrom).toBe("samuel-revisions.csv")
    expect(items[1]).not.toHaveProperty("importedFrom")
  })
})
