/**
 * AQU-1937 HARD REQUIREMENT: the first-party Door43 importer extension writes
 * the SAME files and cells as the built-in Door43 import for the same repo/ref
 * — file ids, names, book codes, file types, cell ids, order (anchor chain),
 * values, rich text, types, refs, sequence indexes, metadata and the raw
 * source — so refreshing an existing linked project through the extension
 * never orphans or re-stales a translation.
 *
 * Built-in: importDcsResource → captured bulkUploadSource args.
 * Extension: fetchDcsSources + planDcsFiles + specForPlanned (what the sandbox
 * bundle runs) → the host's public files.upsert (LiveFilesData.upsertFile) →
 * captured bulkUploadSource args. Both against the same fake Door43 client.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BulkUploadArgs } from "@/lib/sync/bulk-import"
import type { DcsCatalogEntry } from "../types"

const captured = vi.hoisted(() => ({ bulk: [] as BulkUploadArgs[], files: [] as Array<{ fileId: string; name: string; role: null; cellCount: number }> }))
vi.mock("@/lib/sync/bulk-import", () => ({
  bulkUploadSource: vi.fn(async (args: BulkUploadArgs) => {
    captured.bulk.push(args)
    captured.files.push({ fileId: args.fileId, name: args.file.name, role: null, cellCount: args.cells.length })
  }),
}))
vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: vi.fn(async () => captured.files),
  fetchAllFileCells: vi.fn(async () => []),
  fetchCellsByIds: vi.fn(async () => []),
  fetchCellsByRef: vi.fn(async () => ({ cells: [], truncated: false })),
}))

import { importDcsResource } from "../import-dcs"
import { fetchDcsSources, planDcsFiles } from "../import-plan"
import { specForPlanned } from "./door43-plan"
import { LiveFilesData } from "@/lib/tools/live-data-files"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ULT_TIT_1 = readFileSync(path.join(__dirname, "../../parsers/__fixtures__/ult-tit-1.usfm"), "utf8")

function entry(name: string, subject: string, contentFormat: string): DcsCatalogEntry {
  return {
    name, owner: "unfoldingWord", fullName: `unfoldingWord/${name}`, subject, contentFormat,
    ref: "v1", refType: "tag", commitSha: "abc123", released: "2026-01-01T00:00:00Z", zipballUrl: "z", metadataUrl: "m", language: "en",
  }
}
const manifest = (type: string, format: string, identifier: string, subject: string, projects: string) => `dublin_core:
  type: '${type}'
  format: '${format}'
  identifier: '${identifier}'
  subject: '${subject}'
  language:
    identifier: 'en'
    title: 'English'
    direction: 'ltr'
projects:
${projects}
`

const CASES: Array<{ label: string; entry: DcsCatalogEntry; files: Record<string, string> }> = [
  {
    label: "ULT (aligned USFM, ult-tit-1 fixture)",
    entry: entry("en_ult", "Aligned Bible", "usfm"),
    files: {
      "manifest.yaml": manifest("bundle", "text/usfm3", "ult", "Aligned Bible", "  - identifier: 'tit'\n    path: './57-TIT.usfm'"),
      "57-TIT.usfm": ULT_TIT_1,
    },
  },
  {
    label: "TN (TSV notes)",
    entry: entry("en_tn", "TSV Translation Notes", "tsv"),
    files: {
      "manifest.yaml": manifest("help", "text/tsv", "tn", "TSV Translation Notes", "  - identifier: 'tit'\n    path: './tn_TIT.tsv'"),
      "tn_TIT.tsv": [
        "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
        "front:intro\tint1\t\t\t\t0\t# Introduction to Titus\\n\\n## Part 1: General Introduction",
        "1:1\tabc1\tgrammar\trc://en/ta/man/figs-abstractnouns\tδοῦλος\t1\tPaul calls himself a servant here.",
        "1:2\txyz9\t\trc://en/ta/man/figs-explicit\tζωῆς\t1\tThe **hope** of eternal life.",
      ].join("\n"),
    },
  },
  {
    label: "TQ (TSV questions)",
    entry: entry("en_tq", "TSV Translation Questions", "tsv"),
    files: {
      "manifest.yaml": manifest("help", "text/tsv", "tq", "TSV Translation Questions", "  - identifier: 'tit'\n    path: './tq_TIT.tsv'"),
      "tq_TIT.tsv": [
        "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse",
        "1:1\tq1a\t\t\t\tWhat is Paul's role?\tA servant of God.",
        "1:2\tq2b\t\t\t\tWhat did God promise?\tEternal life.",
      ].join("\n"),
    },
  },
  {
    label: "OBS (markdown stories)",
    entry: entry("en_obs", "Open Bible Stories", "markdown"),
    files: {
      "manifest.yaml": manifest("book", "text/markdown", "obs", "Open Bible Stories", "  - identifier: 'obs'\n    path: './content'"),
      "content/01.md": "# 1. The Creation\n\n![OBS Image](https://cdn.door43.org/obs/jpg/360px/obs-en-01-01.jpg)\n\nThis is how God made everything in the beginning.\n\n![OBS Image](https://cdn.door43.org/obs/jpg/360px/obs-en-01-02.jpg)\n\nThen God said, \"Let there be light!\"\n\n_A Bible story from: Genesis 1-2_\n",
    },
  },
]

function fakeClient(files: Record<string, string>) {
  return {
    getTree: vi.fn(async () => Object.keys(files)),
    fetchRaw: vi.fn(async (_o: string, _r: string, _ref: string, p: string) => files[p] ?? ""),
  }
}

/** The structure that must match (event ids are per-write and may differ). */
function structure(args: BulkUploadArgs) {
  return {
    fileId: args.fileId,
    name: args.file.name,
    fileType: args.file.fileType,
    bookCode: args.file.bookCode,
    rawSource: args.rawSource,
    rawSourceFormat: args.rawSourceFormat,
    cells: args.cells.map((c) => ({
      cellId: c.cellId, anchorCellId: c.anchorCellId, value: c.value, valueHtml: c.valueHtml, type: c.type,
      canonicalRef: c.canonicalRef, sequenceIndex: c.sequenceIndex, metadata: c.metadata,
    })),
  }
}

beforeEach(() => {
  captured.bulk = []
  captured.files = []
})

describe("first-party Door43 importer ≡ built-in Door43 import", () => {
  for (const c of CASES) {
    it(`writes identical files and cells: ${c.label}`, async () => {
      const PROJECT = "proj-parity"
      // Built-in.
      const builtIn: BulkUploadArgs[] = []
      await importDcsResource({
        entry: c.entry, projectId: PROJECT, client: fakeClient(c.files) as never,
        emit: async (args) => { builtIn.push(args) }, getToken: async () => "tok",
      })
      expect(builtIn.length).toBeGreaterThan(0)

      // Extension: the sandbox's plan, through the public files.upsert host.
      const fetched = await fetchDcsSources(fakeClient(c.files), c.entry)
      const { planned, skipped } = planDcsFiles({ entry: c.entry, fetched, projectId: PROJECT })
      expect(skipped).toEqual([])
      const host = new LiveFilesData({
        projectId: PROJECT, author: "alice",
        toolOrigin: () => ({ origin: "tool", toolId: "door43", version: 1, codeHash: "a".repeat(64), session: "s" }),
        tokenFor: async () => "tok", flush: () => {}, resolveLaneTag: async (l) => l,
      })
      for (const p of planned) await host.upsertFile(specForPlanned(c.entry, p) as never)

      expect(captured.bulk.map(structure)).toEqual(builtIn.map(structure))
    })
  }
})
