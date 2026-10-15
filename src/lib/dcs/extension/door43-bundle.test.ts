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
    // A display label rides along; the stored name stays the built-in's.
    expect(upserts[0].label).toBe("Titus · Notes")
    expect(upserts[0].name).toBe(titBuiltIn.file.name)
  })

  it("answers the resource and book choices from the catalog", async () => {
    const resources = await runBundle({ importerId: "door43", phase: "choices", field: "resource", options: { lang: "en" } }, {})
    expect(resources.choices[0]).toEqual([{ value: "unfoldingWord/en_tn", label: "TSV Translation Notes (unfoldingWord)", group: "unfoldingWord" }])
    const books = await runBundle({ importerId: "door43", phase: "choices", field: "books", options: { lang: "en", resource: "unfoldingWord/en_tn" } }, {})
    expect(books.choices[0]).toEqual([{ value: "TIT", label: "TIT" }, { value: "PHM", label: "PHM" }])
  })

  it("maps a real Door43 catalog answer to Resource choices", async () => {
    // A real /catalog/search answer ({ ok, data, last_updated }), six entries with
    // their full per-entry ingredients/books/relations, delivered as the proxy does.
    const catalog = readFileSync(path.join(ROOT, "e2e/fixtures/door43/catalog-search-en.json"), "utf8")
    const asked: string[] = []
    const { choices, done } = await runBundle(
      { importerId: "door43", phase: "choices", field: "resource", options: { lang: "en" } },
      { webFetch: async (url) => (asked.push(url), { status: 200, contentType: "application/json", body: catalog, url }) },
    )
    expect(done).toEqual([])
    expect(new URL(asked[0]).searchParams.get("lang")).toBe("en")
    // The lightest listing: no per-entry ingredients.
    expect(new URL(asked[0]).searchParams.get("showIngredients")).toBe("false")
    const g = "unfoldingWord"
    expect(choices[0]).toEqual([
      { value: "unfoldingWord/en_ust", label: "UST — unfoldingWord® Simplified Text (unfoldingWord)", group: g },
      { value: "unfoldingWord/en_tn", label: "TN — unfoldingWord® Translation Notes (unfoldingWord)", group: g },
      { value: "unfoldingWord/en_twl", label: "TWL — unfoldingWord® Translation Words Links (unfoldingWord)", group: g },
      { value: "unfoldingWord/en_tw", label: "TW — unfoldingWord® Translation Words (unfoldingWord)", group: g },
      { value: "unfoldingWord/en_ta", label: "TA — unfoldingWord® Translation Academy (unfoldingWord)", group: g },
      { value: "unfoldingWord/en_obs", label: "OBS — unfoldingWord® Open Bible Stories (unfoldingWord)", group: g },
    ])
  })

  it("runs in an opaque-origin frame: never touches browser storage (any access throws there)", async () => {
    const names = ["localStorage", "sessionStorage", "indexedDB", "caches"] as const
    const touched: string[] = []
    const saved = names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const)
    for (const n of names) {
      Object.defineProperty(globalThis, n, {
        configurable: true,
        get() {
          touched.push(n)
          throw new DOMException(`Failed to read the '${n}' property from 'Window': The document is sandboxed`, "SecurityError")
        },
      })
    }
    try {
      const resources = await runBundle({ importerId: "door43", phase: "choices", field: "resource", options: { lang: "en" } }, {})
      expect(resources.done).toEqual([])
      expect(resources.choices[0]).toHaveLength(1)
      const upserts: ToolFileUpsert[] = []
      const run = await runBundle(
        { importerId: "door43", phase: "run", options: { lang: "en", resource: "unfoldingWord/en_tn", books: ["TIT"], alignment: true } },
        { upsertFile: async (spec) => (upserts.push(spec), { fileId: spec.fileId ?? "", created: true, creates: spec.cells.length, commits: 0, deletes: 0, unchanged: 0, cellIds: {} }) },
      )
      expect(run.done).toEqual([expect.objectContaining({ ok: true })])
    } finally {
      for (const [n, d] of saved) {
        if (d) Object.defineProperty(globalThis, n, d)
        else delete (globalThis as Record<string, unknown>)[n]
      }
    }
    expect(touched).toEqual([])
  })

  it("writes a book's word alignment in a few batched calls, not one per verse (round-trip budget)", async () => {
    // AQU-1937: per-verse data.put made ULT Revelation take ~40 s and Psalms ~6 min.
    const ultTit = readFileSync(path.join(ROOT, "src/lib/parsers/__fixtures__/ult-tit-1.usfm"), "utf8")
    const ultManifest = MANIFEST.replace("identifier: 'tn'", "identifier: 'ult'").replace("TSV Translation Notes", "Aligned Bible").replace("format: 'text/tsv'", "format: 'text/usfm3'")
      .replace("  - identifier: 'tit'\n    path: './tn_TIT.tsv'\n  - identifier: 'phm'\n    path: './tn_PHM.tsv'\n", "  - identifier: 'tit'\n    path: './57-TIT.usfm'\n")
    const ULT_FILES: Record<string, string> = { "manifest.yaml": ultManifest, "57-TIT.usfm": ultTit }
    const ultEntry = { ...RAW_ENTRY, name: "en_ult", full_name: "unfoldingWord/en_ult", subject: "Aligned Bible", content_format: "usfm", abbreviation: "ult" }
    const ultSite = (url: string) => {
      const u = new URL(url)
      if (u.pathname.endsWith("/catalog/search")) return { status: 200, contentType: "application/json", body: JSON.stringify({ data: [ultEntry] }), url }
      if (u.pathname.includes("/git/trees/")) return { status: 200, contentType: "application/json", body: JSON.stringify({ tree: Object.keys(ULT_FILES).map((p) => ({ path: p, type: "blob" })) }), url }
      const raw = /\/raw\/(?:tag|branch)\/[^/]+\/(.+)$/.exec(u.pathname)
      if (raw) return { status: 200, contentType: "text/plain", body: ULT_FILES[raw[1]] ?? "", url }
      return { status: 404, contentType: "text/plain", body: "", url }
    }
    const single = vi.fn(async () => ({ id: "x", version: "v" }))
    const batches: number[] = []
    const progress: string[] = []
    const { done } = await runBundle(
      { importerId: "door43", phase: "run", options: { lang: "en", resource: "unfoldingWord/en_ult", books: ["TIT"], alignment: true } },
      {
        webFetch: async (url) => ultSite(url),
        upsertFile: async (spec) => ({ fileId: spec.fileId ?? "", created: true, creates: spec.cells.length, commits: 0, deletes: 0, unchanged: 0, cellIds: {} }),
        dataPut: single,
        dataPutMany: async (_ns, coll, items) => {
          batches.push(items.length)
          expect(coll).toBe("tit")
          return items.map((it) => ({ id: it.id, version: "v" }))
        },
        actionProgress: async (message) => (progress.push(message), true),
      },
    )
    expect(done[0]).toMatchObject({ ok: true, message: expect.stringMatching(/\d+ aligned verse\(s\) kept as data/) })
    expect(single).not.toHaveBeenCalled()
    // One record per aligned verse (the fixture's 3), all in ONE call; a whole
    // book is one call (ALIGNMENT_BATCH covers Psalms).
    expect(batches).toEqual([3])
    expect(progress.some((m) => /^Saving alignment 0\/\d+ \(TIT\)$/.test(m))).toBe(true)
  })

  it("reports a choices failure instead of answering an empty list", async () => {
    const { choices, done } = await runBundle(
      { importerId: "door43", phase: "choices", field: "resource", options: { lang: "en" } },
      { webFetch: async (url) => ({ status: 503, contentType: "text/plain", body: "down", url }) },
    )
    expect(choices).toEqual([])
    expect(done).toEqual([{ ok: false, message: expect.stringMatching(/503/) }])
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
