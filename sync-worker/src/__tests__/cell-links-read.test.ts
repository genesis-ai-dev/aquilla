// GET /api/v1/projects/:projectId/files/:fileId/cell-links
//
// Against a real Postgres (PGlite) on the canonical schema, because the thing
// most worth pinning here is a JOIN: an edge is only live if the file on its
// FAR side still exists.
//
// THE BUG THIS EXISTS FOR (measured on a real project, 2026-08-14): replacing
// an episode's audio cues minted a new sibling file, and nothing tombstoned the
// edges pointing at the old one — while `from_file_id`, the subtitle file,
// never changes. So every stale edge came back on every read: 1,387 of 3,430.
// The damage was not cosmetic. An index that is never empty means the timeline
// can never say "these cues have never been paired", and a subtitle line paired
// only with dead cues reads as paired, so it never gets its unpaired mark.

import { describe, it, expect } from "vitest"
import { handleCellLinksReadRequest } from "../events/cell-links-read-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "cell-links-read-secret"
const PROJECT = "proj-a"
const TEXT = "file-subs"
const CUES = "file-cues"
const OLD_CUES = "file-cues-old"

interface LinkOut {
  fromFileId: string
  fromCellId: string
  toFileId: string
  toCellId: string
  origin: string
  confidence: number | null
}

const file = (id: string, deletedAt: number | null) => ({
  id,
  project_id: PROJECT,
  name: id,
  file_type: "vtt",
  ...(deletedAt === null ? {} : { deleted_at: deletedAt }),
})

const link = (fromCellId: string, toFileId: string, toCellId: string, linked = 1) => ({
  project_id: PROJECT,
  kind: "text-audio",
  from_file_id: TEXT,
  from_cell_id: fromCellId,
  to_file_id: toFileId,
  to_cell_id: toCellId,
  linked,
  origin: "auto",
  confidence: 0.9,
  event_id: `evt-${fromCellId}-${toCellId}`,
  created_ts: 1000,
})

async function readFull(fileId: string, seed: Parameters<typeof makeTestDb>[0]) {
  const { db } = await makeTestDb(seed)
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId })
  const req = new Request(
    `https://w/api/v1/projects/${PROJECT}/files/${fileId}/cell-links`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const res = (await handleCellLinksReadRequest(req, {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
  }))!
  expect(res.status).toBe(200)
  return (await res.json()) as {
    links: LinkOut[]
    rejected: { fromCellId: string; toCellId: string }[]
  }
}

async function read(fileId: string, seed: Parameters<typeof makeTestDb>[0]) {
  return (await readFull(fileId, seed)).links
}

describe("cue-link read", () => {
  it("returns the file's live pairings from BOTH sides in one request", async () => {
    // The point of the one-request shape: asking about the subtitle file
    // answers "which cues perform this line?" and "which line does this cue
    // perform?" without a second round trip or a reverse index in the client.
    const links = await read(TEXT, {
      files: [file(TEXT, null), file(CUES, null)],
      cell_links: [link("s1", CUES, "c1"), link("s2", CUES, "c2")],
    })
    expect(links.map((l) => [l.fromCellId, l.toCellId]).sort()).toEqual([
      ["s1", "c1"],
      ["s2", "c2"],
    ])
  })

  it("answers the same edges when asked from the CUE file's side", async () => {
    const links = await read(CUES, {
      files: [file(TEXT, null), file(CUES, null)],
      cell_links: [link("s1", CUES, "c1")],
    })
    expect(links).toHaveLength(1)
    expect(links[0].fromCellId).toBe("s1")
  })

  it("DROPS edges whose cue file has been replaced — the 1,387-stale-edge bug", async () => {
    // Both edges are `linked = 1` and both name the same subtitle file, so
    // before the join they were indistinguishable to the read.
    const links = await read(TEXT, {
      files: [file(TEXT, null), file(CUES, null), file(OLD_CUES, 1699999999000)],
      cell_links: [link("s1", CUES, "c1"), link("s1", OLD_CUES, "old-c1")],
    })
    expect(links).toHaveLength(1)
    expect(links[0].toFileId).toBe(CUES)
    expect(links[0].toCellId).toBe("c1")
  })

  it("comes back EMPTY when every cue file is gone, so 'never paired' can be said", async () => {
    // The consequence that mattered most: a non-empty index made the timeline
    // unable to tell you the current cues have no pairings at all.
    const links = await read(TEXT, {
      files: [file(TEXT, null), file(OLD_CUES, 1699999999000)],
      cell_links: [link("s1", OLD_CUES, "old-c1"), link("s2", OLD_CUES, "old-c2")],
    })
    expect(links).toEqual([])
  })

  it("drops unlinked tombstones", async () => {
    // An unlink is a tombstone rather than a deleted row, so that replaying the
    // import-time linker cannot resurrect it — but nothing downstream wants the
    // record of a pairing that isn't one.
    const links = await read(TEXT, {
      files: [file(TEXT, null), file(CUES, null)],
      cell_links: [link("s1", CUES, "c1", 0), link("s2", CUES, "c2", 1)],
    })
    expect(links.map((l) => l.fromCellId)).toEqual(["s2"])
  })

  it("never leaks another project's edges", async () => {
    const links = await read(TEXT, {
      files: [file(TEXT, null), file(CUES, null)],
      cell_links: [
        link("s1", CUES, "c1"),
        { ...link("s9", CUES, "c9"), project_id: "proj-other" },
      ],
    })
    expect(links.map((l) => l.fromCellId)).toEqual(["s1"])
  })

  // A person saying "these two are not a pair" is recorded as a manual
  // tombstone, and the review list reads them so it never proposes a dismissed
  // pair again. An AUTO tombstone is different — that is the matcher changing
  // its mind, and re-proposing later is legitimate — so only manual ones come
  // back.
  it("returns MANUAL rejections, and only manual ones", async () => {
    const res = await readFull(TEXT, {
      files: [file(TEXT, null), file(CUES, null)],
      cell_links: [
        { ...link("s1", CUES, "c1", 0), origin: "manual" },
        { ...link("s2", CUES, "c2", 0), origin: "auto" },
        link("s3", CUES, "c3", 1),
      ],
    })
    expect(res.rejected).toEqual([{ fromCellId: "s1", toCellId: "c1" }])
    // And a rejection is never also a live link.
    expect(res.links.map((l) => l.fromCellId)).toEqual(["s3"])
  })

  it("drops a rejection whose cue file has been replaced", async () => {
    const res = await readFull(TEXT, {
      files: [file(TEXT, null), file(OLD_CUES, 1699999999000)],
      cell_links: [{ ...link("s1", OLD_CUES, "old-c1", 0), origin: "manual" }],
    })
    expect(res.rejected).toEqual([])
  })

  it("refuses without a token", async () => {
    const { db } = await makeTestDb({ files: [file(TEXT, null)] })
    const req = new Request(`https://w/api/v1/projects/${PROJECT}/files/${TEXT}/cell-links`)
    const res = (await handleCellLinksReadRequest(req, {
      AQUILLA_PG: db,
      SYNC_SECRET_KEY: SECRET,
    }))!
    expect(res.status).toBe(401)
  })
})
