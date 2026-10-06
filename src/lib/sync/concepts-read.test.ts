// Concepts read client: the wire row → `Concept` mapping for the Bible entity
// link (AQU-1693).
//
// Why: Voices and Who's Who look links up by `concept.externalIds.acai`. A
// `null` from the route, or a row from a sync-worker older than the column,
// must become an ABSENT key, not `externalIds: null`: the glossary's delta
// compares concepts field by field, and a present-but-empty value would read
// as a change and send an unlink nobody asked for.
import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchConcepts } from "./concepts-read"

function wireRow(extra: Record<string, unknown>) {
  return {
    conceptId: "c1", projectId: "p1", sourceTerm: "Jesus",
    renderings: [{ rendering: "Yesus", status: "preferred" }],
    notes: null, status: "active", caseSensitive: false, matchOptions: null,
    createdBy: null, createdAt: 1, updatedAt: 1, deletedAt: null,
    ...extra,
  }
}

afterEach(() => vi.unstubAllGlobals())

async function read(extra: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ concepts: [wireRow(extra)] })))
  const [concept] = await fetchConcepts("p1", "jwt")
  return concept
}

describe("fetchConcepts — the Bible entity link", () => {
  it("maps a linked row to externalIds", async () => {
    expect((await read({ externalIds: { acai: "person:Jesus.2" } })).externalIds).toEqual({ acai: "person:Jesus.2" })
  })

  it("omits the key for an unlinked row and for a worker that predates the column", async () => {
    expect(await read({ externalIds: null })).not.toHaveProperty("externalIds")
    expect(await read({})).not.toHaveProperty("externalIds")
  })
})
