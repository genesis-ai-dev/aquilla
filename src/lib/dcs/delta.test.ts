import { describe, it, expect, vi } from "vitest"
import { computeDelta, applyDelta, type DeltaEmitters, type CurrentCell } from "./delta"
import { dcsCellId, dcsFileId, dcsEventId } from "./cell-id"
import { contentHash } from "./content-hash"
import type { DcsCatalogEntry } from "./types"

const REPO = "unfoldingWord/en_ult"
const PROJECT_ID = "adapter-proj-1"

const OLD_ENTRY: DcsCatalogEntry = {
  name: "en_ult",
  owner: "unfoldingWord",
  fullName: REPO,
  subject: "Aligned Bible",
  contentFormat: "usfm",
  ref: "v88",
  refType: "tag",
  commitSha: "old000",
  released: "2026-05-01T00:00:00Z",
  zipballUrl: "z",
  metadataUrl: "m",
  language: "en",
}
const NEW_ENTRY: DcsCatalogEntry = { ...OLD_ENTRY, ref: "v89", commitSha: "new111" }

const MANIFEST_YAML = `dublin_core:
  type: 'bundle'
  format: 'text/usfm'
  identifier: 'ult'
  subject: 'Aligned Bible'
  language: { identifier: 'en', title: 'English', direction: 'ltr' }
projects:
  - identifier: 'tit'
    path: './57-TIT.usfm'
`

// The NEW state of TIT: v1 edited, v2 unchanged, v3 ADDED, (old v-to-delete gone).
const NEW_TIT_USFM = `\\id TIT
\\c 1
\\p
\\v 1 Paul, a bondservant of God.
\\v 2 In the hope of eternal life.
\\v 3 A new verse added in v89.`

const TIT_PATH = "57-TIT.usfm"
const TIT_FILE_ID = dcsFileId(REPO, TIT_PATH)

// cell ids for the four refs in play.
const V1 = dcsCellId(`${REPO}|TIT 1:1`)
const V2 = dcsCellId(`${REPO}|TIT 1:2`)
const V3 = dcsCellId(`${REPO}|TIT 1:3`)
const V4_GONE = dcsCellId(`${REPO}|TIT 1:4`) // present in OLD, absent in NEW parse → delete

function fakeClient() {
  return {
    getCatalogEntry: vi.fn(),
    searchCatalog: vi.fn(),
    compareRefs: vi.fn(async () => ({ totalCommits: 1, changedFiles: [TIT_PATH] })),
    getTree: vi.fn(),
    fetchRaw: vi.fn(async (_o: string, _r: string, _ref: string, path: string) => {
      if (path === "manifest.yaml") return MANIFEST_YAML
      if (path === TIT_PATH) return NEW_TIT_USFM
      return ""
    }),
  }
}

/** The adapter project's CURRENT source cells (as they stand at the OLD ref).
 *  v1's hash matches the OLD text; v2 matches the (unchanged) NEW text; v4 is a
 *  cell that no longer exists in the NEW parse. */
function currentCells(): Map<string, CurrentCell> {
  const m = new Map<string, CurrentCell>()
  m.set(V1, {
    eventId: dcsEventId(PROJECT_ID, REPO, OLD_ENTRY.commitSha, V1),
    contentHash: contentHash("Paul, a servant of God."), // OLD text — differs from NEW
    fileId: TIT_FILE_ID,
  })
  m.set(V2, {
    eventId: dcsEventId(PROJECT_ID, REPO, OLD_ENTRY.commitSha, V2),
    contentHash: contentHash("In the hope of eternal life."), // unchanged
    fileId: TIT_FILE_ID,
  })
  m.set(V4_GONE, {
    eventId: dcsEventId(PROJECT_ID, REPO, OLD_ENTRY.commitSha, V4_GONE),
    contentHash: contentHash("Old verse 4 that got removed."),
    fileId: TIT_FILE_ID,
  })
  return m
}

describe("computeDelta — adapter-file scoping (subset adapter must ignore other books)", () => {
  it("ignores changed files the adapter does not hold (no 83k-creates hang)", async () => {
    const PHM_PATH = "58-PHM.usfm"
    const NEW_PHM_USFM = `\\id PHM
\\c 1
\\p
\\v 1 Paul, a prisoner of Christ Jesus.
\\v 2 Grace to you and peace.`
    const MANIFEST_BOTH = `dublin_core:
  type: 'bundle'
  format: 'text/usfm'
  identifier: 'ult'
  subject: 'Aligned Bible'
  language: { identifier: 'en', title: 'English', direction: 'ltr' }
projects:
  - identifier: 'tit'
    path: './57-TIT.usfm'
  - identifier: 'phm'
    path: './58-PHM.usfm'
`
    // The release changed BOTH TIT (which the adapter holds) and PHM (which it
    // does NOT). The adapter's currentCells are TIT-only.
    const client = {
      getCatalogEntry: vi.fn(),
      searchCatalog: vi.fn(),
      compareRefs: vi.fn(async () => ({ totalCommits: 1, changedFiles: [TIT_PATH, PHM_PATH] })),
      getTree: vi.fn(),
      fetchRaw: vi.fn(async (_o: string, _r: string, _ref: string, path: string) => {
        if (path === "manifest.yaml") return MANIFEST_BOTH
        if (path === TIT_PATH) return NEW_TIT_USFM
        if (path === PHM_PATH) return NEW_PHM_USFM
        return ""
      }),
    }
    const delta = await computeDelta({
      client: client as never,
      cursor: { ...OLD_ENTRY, trackMode: "release", importedAt: "x" } as never,
      oldEntry: OLD_ENTRY,
      newEntry: NEW_ENTRY,
      currentCells: currentCells(), // TIT cells only
    })
    // PHM cells (a book the adapter never imported) must NOT be pulled in.
    const phmV1 = dcsCellId(`${REPO}|PHM 1:1`)
    expect(delta.creates.some((c) => c.cell.cellId === phmV1)).toBe(false)
    // Only TIT's genuinely-new verse is a create.
    expect(delta.creates.map((c) => c.cell.cellId)).toEqual([V3])
    // TIT commit/delete still work (adapter holds TIT).
    expect(delta.commits.map((c) => c.cell.cellId)).toEqual([V1])
    expect(delta.deletes).toEqual([V4_GONE])
  })
})

describe("computeDelta — classification (spec §6, THE money logic)", () => {
  it("classifies edited→commit, added→create, unchanged→nothing, vanished→delete", async () => {
    const delta = await computeDelta({
       
      client: fakeClient() as any,
      cursor: { ...OLD_ENTRY, trackMode: "release", importedAt: "x" } as never,
      oldEntry: OLD_ENTRY,
      newEntry: NEW_ENTRY,
      currentCells: currentCells(),
    })

    // v3 is new.
    expect(delta.creates.map((c) => c.cell.cellId)).toEqual([V3])
    expect(delta.creates[0].cell.value).toContain("A new verse added")
    // The create carries the parsed FILE's id (so it lands in the right file),
    // never the cell id — guards the phantom-file orphaning bug.
    expect(delta.creates[0].fileId).toBeTruthy()
    expect(delta.creates[0].fileId).not.toBe(V3)

    // v1 changed → commit, chained on v1's current head event id.
    expect(delta.commits).toHaveLength(1)
    expect(delta.commits[0].cell.cellId).toBe(V1)
    expect(delta.commits[0].cell.value).toContain("bondservant")
    expect(delta.commits[0].parentEventId).toBe(dcsEventId(PROJECT_ID, REPO, OLD_ENTRY.commitSha, V1))

    // v2 unchanged → NOT in commits (no-op suppression).
    expect(delta.commits.map((c) => c.cell.cellId)).not.toContain(V2)

    // v4 vanished from a changed file → delete (tombstone).
    expect(delta.deletes).toEqual([V4_GONE])
  })

  it("emits nothing at all when the only changed file is byte-identical", async () => {
    const client = {
      compareRefs: vi.fn(async () => ({ totalCommits: 1, changedFiles: [TIT_PATH] })),
      fetchRaw: vi.fn(async (_o: string, _r: string, _ref: string, path: string) =>
        path === "manifest.yaml" ? MANIFEST_YAML : `\\id TIT
\\c 1
\\p
\\v 1 Paul, a servant of God.`,
      ),
    }
    const current = new Map<string, CurrentCell>([
      [
        V1,
        {
          eventId: dcsEventId(PROJECT_ID, REPO, OLD_ENTRY.commitSha, V1),
          contentHash: contentHash("Paul, a servant of God."),
          fileId: TIT_FILE_ID,
        },
      ],
    ])
    const delta = await computeDelta({
       
      client: client as any,
      cursor: { ...OLD_ENTRY } as never,
      oldEntry: OLD_ENTRY,
      newEntry: NEW_ENTRY,
      currentCells: current,
    })
    expect(delta.creates).toEqual([])
    expect(delta.commits).toEqual([])
    expect(delta.deletes).toEqual([])
  })

  it("returns an empty delta when compare reports no changed files", async () => {
    const client = {
      compareRefs: vi.fn(async () => ({ totalCommits: 0, changedFiles: [] })),
      fetchRaw: vi.fn(),
    }
    const delta = await computeDelta({
       
      client: client as any,
      cursor: { ...OLD_ENTRY } as never,
      oldEntry: OLD_ENTRY,
      newEntry: NEW_ENTRY,
      currentCells: currentCells(),
    })
    expect(delta).toEqual({ creates: [], commits: [], deletes: [] })
    // fetchRaw is never called when nothing changed.
    expect(client.fetchRaw).not.toHaveBeenCalled()
  })
})

describe("applyDelta — routes to the injected emitters, idempotent event ids", () => {
  it("calls create/commit(chained)/delete with deterministic event ids", async () => {
    const delta = await computeDelta({
       
      client: fakeClient() as any,
      cursor: { ...OLD_ENTRY } as never,
      oldEntry: OLD_ENTRY,
      newEntry: NEW_ENTRY,
      currentCells: currentCells(),
    })

    const emitters: DeltaEmitters = {
      create: vi.fn(async () => "e-create"),
      commit: vi.fn(async () => "e-commit"),
      delete: vi.fn(async () => "e-delete"),
    }
    await applyDelta(delta, emitters, {
      projectId: PROJECT_ID,
      repo: REPO,
      sha: NEW_ENTRY.commitSha,
    })

    // create for v3 — event id is scoped to the destination project.
    expect(emitters.create).toHaveBeenCalledTimes(1)
    const createArg = (emitters.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createArg.cellId).toBe(V3)
    expect(createArg.eventId).toBe(dcsEventId(PROJECT_ID, REPO, NEW_ENTRY.commitSha, V3))

    // commit for v1, chained on the old head (also project-scoped).
    expect(emitters.commit).toHaveBeenCalledTimes(1)
    const commitArg = (emitters.commit as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(commitArg.cellId).toBe(V1)
    expect(commitArg.parentEventId).toBe(dcsEventId(PROJECT_ID, REPO, OLD_ENTRY.commitSha, V1))
    expect(commitArg.eventId).toBe(dcsEventId(PROJECT_ID, REPO, NEW_ENTRY.commitSha, V1))

    // delete for v4.
    expect(emitters.delete).toHaveBeenCalledTimes(1)
    const delArg = (emitters.delete as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(delArg.cellId).toBe(V4_GONE)
  })

  it("running applyDelta twice yields the SAME event ids (idempotency)", async () => {
    const delta = await computeDelta({
       
      client: fakeClient() as any,
      cursor: { ...OLD_ENTRY } as never,
      oldEntry: OLD_ENTRY,
      newEntry: NEW_ENTRY,
      currentCells: currentCells(),
    })
    const seen1: string[] = []
    const seen2: string[] = []
    const mk = (bucket: string[]): DeltaEmitters => ({
      create: vi.fn(async (a) => { bucket.push(a.eventId); return a.eventId }),
      commit: vi.fn(async (a) => { bucket.push(a.eventId); return a.eventId }),
      delete: vi.fn(async (a) => { bucket.push(a.cellId); return "x" }),
    })
    await applyDelta(delta, mk(seen1), {
      projectId: PROJECT_ID,
      repo: REPO,
      sha: NEW_ENTRY.commitSha,
    })
    await applyDelta(delta, mk(seen2), {
      projectId: PROJECT_ID,
      repo: REPO,
      sha: NEW_ENTRY.commitSha,
    })
    expect(seen1).toEqual(seen2)
  })

  it("scopes event ids to the destination project: same delta into two projects → different event ids", async () => {
    // FINDING 4 fix: without project scope, the same resource delta'd into two
    // projects mints identical event ids, and the server's INSERT OR IGNORE
    // silently drops the second project's import. The event id MUST carry the
    // projectId so both projects land their own events.
    const delta = await computeDelta({

      client: fakeClient() as any,
      cursor: { ...OLD_ENTRY } as never,
      oldEntry: OLD_ENTRY,
      newEntry: NEW_ENTRY,
      currentCells: currentCells(),
    })
    const seenA: string[] = []
    const seenB: string[] = []
    const mk = (bucket: string[]): DeltaEmitters => ({
      create: vi.fn(async (a) => { bucket.push(a.eventId); return a.eventId }),
      commit: vi.fn(async (a) => { bucket.push(a.eventId); return a.eventId }),
      delete: vi.fn(async (a) => { void a; return "x" }),
    })
    await applyDelta(delta, mk(seenA), { projectId: "proj-A", repo: REPO, sha: NEW_ENTRY.commitSha })
    await applyDelta(delta, mk(seenB), { projectId: "proj-B", repo: REPO, sha: NEW_ENTRY.commitSha })
    expect(seenA.length).toBeGreaterThan(0)
    expect(seenA).toHaveLength(seenB.length)
    // No event id is shared between the two projects.
    for (const id of seenA) expect(seenB).not.toContain(id)
  })
})
