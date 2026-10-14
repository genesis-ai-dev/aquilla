/**
 * AQU-1937: the first-party Door43 importer as SHIPPED — the generated bundle.
 *   1. it is current (rebuilt from its inputs: npx tsx scripts/build-door43-extension.ts);
 *   2. it passes the same save gates every extension does (manifest + lint);
 *   3. run through the real bridge runtime in a fake frame, an import run
 *      upserts exactly the built-in Door43 import's files and cells (by id),
 *      a choices run answers the catalog, and a refresh with an unchanged
 *      upstream sha writes nothing.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { DOOR43_IMPORTER_INPUTS, DOOR43_IMPORTER_INPUT_HASH } from "../../../../shared/tools/first-party/door43-importer.bundle"
import { DOOR43_IMPORTER_MANIFEST, DOOR43_IMPORTER_SOURCE } from "../../../../shared/tools/first-party/door43-importer"
import { validateManifest } from "../../../../shared/tools/manifest"
import { lintToolSource } from "../../../../shared/tools/lint"
import { createBridgeHost } from "@/lib/tools/host-bridge"
import { createToolHandlers, type ToolHostData } from "@/lib/tools/host-handlers"
import { defaultSmokeFixtures } from "@/lib/tools/smoke"
import { buildToolSrcdoc } from "@/lib/tools/srcdoc"
import { createFakeFramePair } from "@/lib/tools/__tests__/fake-frame"
import type { ToolFileUpsert } from "@/lib/tools/host-handlers-files"
import { importDcsResource } from "../import-dcs"
import type { BulkUploadArgs } from "@/lib/sync/bulk-import"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")

describe("the shipped Door43 importer bundle", () => {
  it("is current with its inputs", () => {
    const h = createHash("sha256")
    for (const rel of DOOR43_IMPORTER_INPUTS) {
      h.update(rel)
      h.update(readFileSync(path.join(ROOT, rel)))
    }
    expect(h.digest("hex"), "rebuild: npx tsx scripts/build-door43-extension.ts").toBe(DOOR43_IMPORTER_INPUT_HASH)
  })

  it("passes the save gates", () => {
    expect(validateManifest(DOOR43_IMPORTER_MANIFEST).errors).toEqual([])
    expect(lintToolSource(DOOR43_IMPORTER_SOURCE).issues).toEqual([])
  })
})

const TN = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  "1:1\tabc1\tgrammar\trc://en/ta/man/figs-abstractnouns\tδοῦλος\t1\tPaul calls himself a servant here.",
  "1:2\txyz9\t\trc://en/ta/man/figs-explicit\tζωῆς\t1\tThe **hope** of eternal life.",
].join("\n")
const MANIFEST = `dublin_core:
  type: 'help'
  format: 'text/tsv'
  identifier: 'tn'
  subject: 'TSV Translation Notes'
  language:
    identifier: 'en'
    title: 'English'
    direction: 'ltr'
projects:
  - identifier: 'tit'
    path: './tn_TIT.tsv'
  - identifier: 'phm'
    path: './tn_PHM.tsv'
`
const RAW_ENTRY = {
  name: "en_tn", owner: "unfoldingWord", full_name: "unfoldingWord/en_tn", subject: "TSV Translation Notes", content_format: "tsv",
  branch_or_tag_name: "v80", ref_type: "tag", commit_sha: "sha80", released: "2026-01-01T00:00:00Z", zipball_url: "z", metadata_url: "m", language: "en",
}
const FILES: Record<string, string> = { "manifest.yaml": MANIFEST, "tn_TIT.tsv": TN, "tn_PHM.tsv": TN.replace("Paul", "Paul (PHM)") }

function site(url: string): { status: number; contentType: string; body: unknown; url: string } {
  const u = new URL(url)
  if (u.pathname.endsWith("/catalog/search")) return { status: 200, contentType: "application/json", body: JSON.stringify({ data: [RAW_ENTRY] }), url }
  if (u.pathname.includes("/git/trees/")) return { status: 200, contentType: "application/json", body: JSON.stringify({ tree: Object.keys(FILES).map((p) => ({ path: p, type: "blob" })) }), url }
  const raw = /\/raw\/(?:tag|branch)\/[^/]+\/(.+)$/.exec(u.pathname)
  if (raw) return { status: 200, contentType: "text/plain", body: FILES[raw[1]] ?? "", url }
  return { status: 404, contentType: "text/plain", body: "", url }
}

async function runBundle(importCtx: Record<string, unknown>, data: Partial<ToolHostData>): Promise<{ done: Array<{ message: string | null; ok: boolean }>; choices: unknown[] }> {
  const done: Array<{ message: string | null; ok: boolean }> = []
  const choices: unknown[] = []
  const stub = defaultSmokeFixtures(DOOR43_IMPORTER_MANIFEST)[1].data
  const finished = new Promise<void>((resolve) => {
    const host: ToolHostData = {
      ...stub,
      webFetch: async (url) => site(url),
      actionDone: async (message, ok) => {
        done.push({ message, ok })
        resolve()
        return true
      },
      importChoices: async (c) => {
        choices.push(c)
        resolve()
        return true
      },
      ...data,
    }
    const pair = createFakeFramePair()
    const bridge = createBridgeHost({ getFrameWindow: () => pair.frame as unknown as Window, handlers: createToolHandlers(host), authorize: async () => {} })
    bridge.listen(pair.host as unknown as Window)
    pair.run(buildToolSrcdoc(DOOR43_IMPORTER_SOURCE, {
      tool: { id: "door43", name: "Door43 resources", version: 1 },
      project: { id: "proj-1", name: "P" },
      user: { username: "u", roleLevel: 700 },
      mount: "import",
      import: importCtx as never,
      theme: {},
    }, { sdk: DOOR43_IMPORTER_MANIFEST.sdk }))
  })
  await finished
  return { done, choices }
}

describe("running the shipped bundle", () => {
  it("imports the chosen book with the built-in import's ids, cell for cell", async () => {
    const upserts: ToolFileUpsert[] = []
    const { done } = await runBundle(
      { importerId: "door43", phase: "run", options: { lang: "en", resource: "unfoldingWord/en_tn", books: ["TIT"], alignment: true } },
      { upsertFile: async (spec) => (upserts.push(spec), { fileId: spec.fileId ?? "", created: true, creates: spec.cells.length, commits: 0, deletes: 0, unchanged: 0, cellIds: {} }) },
    )
    expect(done).toEqual([expect.objectContaining({ ok: true })])

    const builtIn: BulkUploadArgs[] = []
    await importDcsResource({
      entry: { name: "en_tn", owner: "unfoldingWord", fullName: "unfoldingWord/en_tn", subject: "TSV Translation Notes", contentFormat: "tsv", ref: "v80", refType: "tag", commitSha: "sha80", released: "2026-01-01T00:00:00Z", zipballUrl: "z", metadataUrl: "m", language: "en" },
      projectId: "proj-1",
      client: { getTree: async () => Object.keys(FILES), fetchRaw: async (_o: string, _r: string, _ref: string, p: string) => FILES[p] } as never,
      emit: async (a) => void builtIn.push(a),
      getToken: async () => "t",
    })
    const titBuiltIn = builtIn.find((b) => b.file.bookCode === "TIT")!
    // Only TIT was chosen.
    expect(upserts.map((u) => u.bookCode)).toEqual(["TIT"])
    expect(upserts[0].fileId).toBe(titBuiltIn.fileId)
    expect(upserts[0].cells.map((c) => [c.cellId, c.value, c.html, c.ref])).toEqual(titBuiltIn.cells.map((c) => [c.cellId, c.value, c.valueHtml, c.canonicalRef]))
    expect(upserts[0].upstream).toMatchObject({ repo: "en_tn", sha: "sha80", path: "tn_TIT.tsv" })
  })

  it("answers the resource and book choices from the catalog", async () => {
    const resources = await runBundle({ importerId: "door43", phase: "choices", field: "resource", options: { lang: "en" } }, {})
    expect(resources.choices[0]).toEqual([{ value: "unfoldingWord/en_tn", label: "TSV Translation Notes — unfoldingWord/en_tn" }])
    const books = await runBundle({ importerId: "door43", phase: "choices", field: "books", options: { lang: "en", resource: "unfoldingWord/en_tn" } }, {})
    expect(books.choices[0]).toEqual([{ value: "TIT", label: "TIT" }, { value: "PHM", label: "PHM" }])
  })

  it("refresh writes nothing when the upstream sha is unchanged", async () => {
    const upsert = vi.fn()
    const { done } = await runBundle(
      { importerId: "door43", phase: "refresh", fileIds: ["f-tit"], options: { lang: "en", resource: "unfoldingWord/en_tn", books: ["TIT"] } },
      {
        listFiles: async () => [{ fileId: "f-tit", name: "tn_TIT.tsv", cellCount: 2, kind: "normal", tags: ["door43", "book:TIT"], group: "door43:TIT", owner: "door43", meta: { sha: "sha80" } }],
        upsertFile: upsert,
      },
    )
    expect(done[0]).toMatchObject({ ok: true, message: expect.stringContaining("up to date") })
    expect(upsert).not.toHaveBeenCalled()
  })
})
