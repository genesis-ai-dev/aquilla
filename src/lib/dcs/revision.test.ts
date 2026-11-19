// Door43 as a revision provider (AQU-2459).
//
// Why these tests: the loop decides WHICH files an upstream release may touch
// and what it tells the server about them. Getting that wrong either writes
// into books the project never imported, tombstones a file on a path that
// merely 404s, or (the adoption case) moves translations onto the wrong note.

import { describe, it, expect, vi } from "vitest"
import { dcsOptionsHash, dcsRevision, dcsStamp, reviseDcsFiles, type ReviseDcsArgs } from "./revision"
import { DcsRawNotFoundError } from "./catalog"
import { dcsCellId, dcsFileId, dcsLegacyFileId } from "./cell-id"
import { tsvNotesRoute } from "./routes/tsv-notes"
import type { DcsCatalogEntry, DcsManifest } from "./types"
import type { FileRevisionResult, PostFileRevisionArgs } from "@/lib/sync/revision-import"

const ENTRY: DcsCatalogEntry = {
  name: "en_ult",
  owner: "unfoldingWord",
  fullName: "unfoldingWord/en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  ref: "v89",
  refType: "tag",
  commitSha: "84c73ba0",
  released: "2026-06-23T22:01:02Z",
  zipballUrl: "z",
  metadataUrl: "m",
  language: "en",
}
const MANIFEST_YAML = `dublin_core:
  type: 'bundle'
  format: 'text/usfm'
  identifier: 'ult'
  subject: 'Aligned Bible'
  language:
    identifier: 'en'
    title: 'English'
    direction: 'ltr'
projects:
  - identifier: 'tit'
    path: './57-TIT.usfm'
`
const usfm = (book: string, verses: string[]) =>
  [`\\id ${book}`, "\\c 1", "\\p", ...verses.map((v, i) => `\\v ${i + 1} ${v}`)].join("\n")

const PROJECT = "proj-1"
const TIT = dcsFileId(PROJECT, ENTRY.fullName, "57-TIT.usfm")

function harness(members: Record<string, string | null>, over: Partial<ReviseDcsArgs> = {}) {
  const fetchRaw = vi.fn(async (_o: string, _r: string, _ref: string, path: string) => {
    if (path === "manifest.yaml") return MANIFEST_YAML
    const text = members[path]
    if (text === null || text === undefined) throw new DcsRawNotFoundError(`https://x/${path}`, path)
    return text
  })
  const client = { fetchRaw, getTree: vi.fn(async () => ["manifest.yaml", ...Object.keys(members)]) }
  const post = vi.fn(async (_args: PostFileRevisionArgs): Promise<FileRevisionResult> => ({
    noop: false,
    revisionN: 2,
    counts: { equal: 1, changed: 1, moved: 0, inserted: 1, deleted: 1 },
  }))
  const upload = vi.fn(async (a: { artifactId: string }) => ({ artifactId: a.artifactId, sha256: "f".repeat(64) }))
  const run = (extra: Partial<ReviseDcsArgs> = {}) =>
    reviseDcsFiles({
      client: client as unknown as ReviseDcsArgs["client"],
      projectId: PROJECT,
      entry: ENTRY,
      heldFileIds: new Set([TIT]),
      getToken: async () => "tok",
      post,
      upload: upload as unknown as ReviseDcsArgs["upload"],
      ...over,
      ...extra,
    })
  return { run, post, upload, fetchRaw, client }
}

describe("dcsRevision — units and the keys of pre-revision cells", () => {
  it("keys every unit by reference and maps each old deterministic cell id to its key", () => {
    const [file] = tsvNotesRoute.parse({
      entry: { ...ENTRY, name: "en_tn", fullName: "unfoldingWord/en_tn", subject: "TSV Translation Notes", contentFormat: "tsv" },
      manifest: {} as DcsManifest,
      projectId: PROJECT,
      files: new Map([["tn_TIT.tsv", "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n1:1\tabc1\t\t\t\t1\tFirst note\n1:1\txyz2\t\t\t\t1\tSecond note\n"]]),
    })
    const revision = dcsRevision(file, "tsv-notes")
    expect(revision.stamp).toBe(dcsStamp("tsv-notes"))
    expect(revision.origin).toBe("dcs")
    // Two notes on ONE verse: the row id, not the verse, is the identity.
    expect(revision.units.map((u) => u.unitKey)).toEqual(["TIT|abc1", "TIT|xyz2"])
    expect(revision.units.every((u) => u.positional === false)).toBe(true)
    // What a file imported before revisions holds each note under.
    expect(revision.cellKeys).toEqual({
      [dcsCellId("unfoldingWord/en_tn|TIT|abc1")]: "TIT|abc1",
      [dcsCellId("unfoldingWord/en_tn|TIT|xyz2")]: "TIT|xyz2",
    })
  })

  it("a repeated row id cannot fail the file: the repeat takes a suffix", () => {
    const cell = { cellId: "c", unitKey: "TIT|dup", value: "v", type: "text", contentHash: "h" }
    const revision = dcsRevision({ fileId: "f", name: "n", cells: [cell, { ...cell, value: "w" }] }, "tsv-notes")
    expect(revision.units.map((u) => u.unitKey)).toEqual(["TIT|dup", "TIT|dup#dup2"])
  })

  it("the front-matter opt-out is part of the revision's identity; no options is no hash", () => {
    expect(dcsOptionsHash(undefined)).toBeUndefined()
    expect(dcsOptionsHash({ excludeFrontMatter: false })).toBeUndefined()
    expect(dcsOptionsHash({ excludeFrontMatter: true })).toEqual(expect.any(String))
  })
})

describe("reviseDcsFiles", () => {
  it("posts one revision per held file and ignores books this project never imported", async () => {
    const { run, post, upload, fetchRaw } = harness({
      "57-TIT.usfm": usfm("TIT", ["Paul.", "In hope."]),
      "58-PHM.usfm": usfm("PHM", ["Paul, a prisoner."]),
    })
    const out = await run({ paths: ["57-TIT.usfm", "58-PHM.usfm", "manifest.yaml"] })

    expect(post).toHaveBeenCalledTimes(1)
    const sent = post.mock.calls[0][0]
    expect(sent.fileId).toBe(TIT)
    expect(sent.revision.units.map((u) => u.unitKey)).toEqual(["TIT 1:1", "TIT 1:2"])
    // The original is stored first and the revision names it, so the source
    // pointer moves with the cells.
    expect(upload).toHaveBeenCalledTimes(1)
    expect(sent.artifactId).toBe(upload.mock.calls[0][0].artifactId)
    expect(sent.artifactSha256).toBe("f".repeat(64))
    // Philemon was never fetched at all.
    expect(fetchRaw.mock.calls.map((c) => c[3])).not.toContain("58-PHM.usfm")
    expect(out).toMatchObject({ created: 1, updated: 1, removed: 1, revisedFiles: 1 })
    expect(out.scan).toEqual({ heldFiles: 1, resolvedFiles: 1, fetchedFiles: 1 })
  })

  it("reaches a file held under the pre-AQU-1891 project-agnostic id", async () => {
    const legacy = dcsLegacyFileId(ENTRY.fullName, "57-TIT.usfm")
    const { run, post } = harness({ "57-TIT.usfm": usfm("TIT", ["Paul."]) }, { heldFileIds: new Set([legacy]) })
    await run()
    expect(post.mock.calls[0][0].fileId).toBe(legacy)
  })

  it("a changed path that no longer exists at the ref is skipped, and its file is left alone", async () => {
    // compareRefs lists every path any commit in the range touched, so a file
    // renamed part-way is listed and yet absent. Its cells must survive.
    const { run, post } = harness({ "57-TIT.usfm": null })
    const out = await run({ paths: ["57-TIT.usfm"] })
    expect(post).not.toHaveBeenCalled()
    expect(out.scan).toEqual({ heldFiles: 1, resolvedFiles: 1, fetchedFiles: 0 })
  })

  it("an upstream failure that is not a 404 aborts instead of reading as nothing to do", async () => {
    const { run, client } = harness({ "57-TIT.usfm": usfm("TIT", ["Paul."]) })
    client.fetchRaw.mockImplementation(async (_o, _r, _ref, path) => {
      if (path === "manifest.yaml") return MANIFEST_YAML
      throw new Error("HTTP 503")
    })
    await expect(run()).rejects.toThrow("HTTP 503")
  })

  it("never posts an empty parse: a file is not tombstoned whole on a parser or upstream fault", async () => {
    const { run, post } = harness({ "57-TIT.usfm": "" })
    await run()
    expect(post).not.toHaveBeenCalled()
  })

  it("a repair scan is a dry run: nothing is stored, and the route is told to align the same artifact", async () => {
    const { run, post, upload } = harness({ "57-TIT.usfm": usfm("TIT", ["Paul."]) })
    const out = await run({ repair: true, dryRun: true })
    expect(upload).not.toHaveBeenCalled()
    const sent = post.mock.calls[0][0]
    expect(sent).toMatchObject({ dryRun: true, realign: true })
    expect(sent.artifactId).toBeUndefined()
    expect(sent.artifactSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out.updated).toBe(1)
  })

  it("a file whose head already names this content counts as unchanged", async () => {
    const { run, post } = harness({ "57-TIT.usfm": usfm("TIT", ["Paul."]) })
    post.mockResolvedValue({ noop: true, revisionN: 3 })
    const out = await run()
    expect(out).toMatchObject({ created: 0, updated: 0, removed: 0, revisedFiles: 0 })
  })

  it("re-parses under the project's front-matter opt-out and says so in the revision", async () => {
    const { run, post } = harness({ "57-TIT.usfm": `\\id TIT\n\\h Titus\n\\mt Titus\n\\c 1\n\\p\n\\v 1 Paul.` })
    await run({ excludeFrontMatter: true })
    const sent = post.mock.calls[0][0].revision
    expect(sent.optionsHash).toBe(dcsOptionsHash({ excludeFrontMatter: true }))
    expect(sent.units.map((u) => u.unitKey)).toEqual(["TIT 1:1"])
  })
})
