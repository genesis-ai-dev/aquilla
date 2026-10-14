// AQU-1937: the first-party Door43 importer EXTENSION — the code that runs in
// its sandboxed frame. Bundled into shared/tools/first-party/
// door43-importer.bundle.ts by scripts/build-door43-extension.ts; it reaches
// the app ONLY through the public bridge (window.aquilla) and the SDK
// (window.aq): web.fetch for Door43, files.upsert for every file, data.put for
// alignment, import.progress/done/choices for the Import dialog.
//
// Same fetch/route/parse/ids as the built-in import (import-plan.ts), so its
// files are the built-in's files (door43-parity.test.ts). Beyond the built-in:
// Translation Words, Translation Words Links, and word alignment as data.

import { DcsClient } from "../catalog"
import { parseManifest } from "../manifest"
import { MANIFEST_PATH, dcsBookOfPath, fetchDcsSources, planDcsFiles } from "../import-plan"
import type { DcsCatalogEntry } from "../types"
import { alignmentsFromWords, specForPlanned, specForTwCategory, specForTwl, type Door43UpsertSpec, type MdBlock } from "./door43-plan"

interface WebResponse { status: number; contentType: string; body: unknown; url: string }
interface FileView { fileId: string; name: string; tags?: string[]; meta?: Record<string, unknown> | null }
interface Bridge {
  context: {
    project: { id: string } | null
    mount: string
    import: { importerId: string; phase: "run" | "refresh" | "choices"; options: Record<string, unknown>; fileIds?: string[]; field?: string } | null
  }
  web: { fetch: (url: string, opts?: { as?: "text" | "json" | "bytes" }) => Promise<WebResponse> }
  files: {
    upsert: (spec: Door43UpsertSpec & { meta?: Record<string, unknown> }) => Promise<{ fileId: string; created: boolean; creates: number; commits: number; deletes: number }>
    list: (filter?: Record<string, unknown>) => Promise<FileView[]>
  }
  data: { put: (ns: string, id: string, doc: unknown, opts: Record<string, unknown>) => Promise<unknown> }
  import: {
    progress: (message: string, fraction: number | null) => Promise<unknown>
    done: (message: string, opts?: { ok?: boolean }) => Promise<unknown>
    choices: (list: { value: string; label: string }[]) => Promise<unknown>
  }
}
interface Sdk {
  zip: { read: (buf: ArrayBuffer) => Promise<{ names: string[]; text: (n: string) => Promise<string> }> }
  parse: {
    usfm: (text: string) => { verses: Array<{ ref: string; words: Array<{ text: string; occurrence: number; milestones: Record<string, string>[] }> }> }
    mdBlocks: (text: string) => MdBlock[]
  }
}

// `window`, not globalThis: the frame's globals (and the test harness's fake frame).
const w = window as unknown as { aquilla: Bridge; aq: Sdk }
const DCS = "https://git.door43.org"

/** DcsClient over the host's proxy (the frame has no network of its own). */
function bridgeFetch(input: RequestInfo | URL): Promise<Response> {
  return w.aquilla.web.fetch(String(input), { as: "text" }).then((r) => {
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? r.contentType : null) },
      body: null,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response
  })
}

const client = new DcsClient({ fetchImpl: bridgeFetch as typeof fetch })

function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}
function splitRepo(value: string): { owner: string; repo: string } {
  const [owner, repo] = value.split("/")
  if (!owner || !repo) throw new Error("Choose a resource first")
  return { owner, repo }
}
const isTwl = (e: DcsCatalogEntry) => /translation words links/i.test(e.subject)
const isTw = (e: DcsCatalogEntry) => !isTwl(e) && /translation words/i.test(e.subject)

async function latestEntry(owner: string, repo: string): Promise<DcsCatalogEntry> {
  const entry = await client.getLatestRelease(owner, repo)
  if (!entry) throw new Error(`${owner}/${repo} has no release on Door43`)
  return entry
}

async function choices(field: string, options: Record<string, unknown>): Promise<void> {
  if (field === "resource") {
    const lang = str(options.lang, "en") || "en"
    const entries = await client.searchCatalog({ lang, stage: "prod", limit: 200 })
    const seen = new Set<string>()
    const out: { value: string; label: string }[] = []
    for (const e of entries) {
      if (seen.has(e.fullName)) continue
      seen.add(e.fullName)
      out.push({ value: e.fullName, label: `${e.subject} — ${e.fullName}` })
    }
    out.sort((a, b) => a.label.localeCompare(b.label))
    await w.aquilla.import.choices(out)
    return
  }
  if (field === "books") {
    const value = str(options.resource)
    if (!value) return void (await w.aquilla.import.choices([]))
    const { owner, repo } = splitRepo(value)
    const entry = await latestEntry(owner, repo)
    const manifest = parseManifest(await client.fetchRaw(owner, repo, entry.ref, MANIFEST_PATH, entry.refType === "branch" ? "branch" : "tag"))
    const books = manifest.projects
      .map((p) => p.identifier.toUpperCase())
      .filter((b) => /^[1-3]?[A-Z]{2,3}$/.test(b) && b !== "OBS" && b !== "FRT")
    await w.aquilla.import.choices(books.map((b) => ({ value: b, label: b })))
    return
  }
  await w.aquilla.import.choices([])
}

function metaOf(spec: Door43UpsertSpec): Record<string, unknown> {
  return { repo: spec.upstream.repo, owner: spec.upstream.owner, sha: spec.upstream.sha, path: spec.upstream.path }
}

async function upsertAll(specs: Door43UpsertSpec[], label: (s: Door43UpsertSpec) => string): Promise<{ files: number; changed: number }> {
  let changed = 0
  for (const [i, spec] of specs.entries()) {
    await w.aquilla.import.progress(label(spec), i / Math.max(1, specs.length))
    const out = await w.aquilla.files.upsert({ ...spec, meta: metaOf(spec) })
    if (out.created || out.creates + out.commits + out.deletes > 0) changed++
  }
  return { files: specs.length, changed }
}

async function alignmentAsData(spec: Door43UpsertSpec, rawUsfm: string, entry: DcsCatalogEntry): Promise<number> {
  if (!/\\zaln-s/.test(rawUsfm) || !w.aq?.parse?.usfm) return 0
  const byRef = new Map(spec.cells.filter((c) => c.ref).map((c) => [c.ref as string, c.cellId]))
  const groups = alignmentsFromWords(w.aq.parse.usfm(rawUsfm).verses)
  let n = 0
  for (const [ref, g] of groups) {
    const cellId = byRef.get(ref)
    if (!cellId) continue
    await w.aquilla.data.put("door43.alignment", `${ref}|${entry.name}`, { groups: g }, {
      coll: (spec.bookCode ?? "all").toLowerCase(),
      anchor: { fileId: spec.fileId, cellId, side: "source" },
    })
    n++
  }
  return n
}

async function importResource(options: Record<string, unknown>, onlyBooks: string[] | null): Promise<string> {
  const { owner, repo } = splitRepo(str(options.resource))
  const entry = await latestEntry(owner, repo)
  const projectId = w.aquilla.context.project?.id ?? ""
  const books = new Set((onlyBooks ?? list(options.books)).map((b) => b.toUpperCase()))
  const wantPath = (path: string) => {
    if (books.size === 0) return true
    const b = dcsBookOfPath(path)
    return b === null || books.has(b)
  }

  if (isTwl(entry)) {
    const tree = await client.getTree(owner, repo, entry.ref)
    const specs: Door43UpsertSpec[] = []
    for (const path of tree.filter((p) => /twl_[1-3]?[A-Z]{2,3}\.tsv$/i.test(p) && wantPath(p))) {
      const text = await client.fetchRaw(owner, repo, entry.ref, path, entry.refType === "branch" ? "branch" : "tag")
      const spec = specForTwl(entry, projectId, path, text, dcsBookOfPath(path) ?? "")
      if (spec) specs.push(spec)
    }
    const r = await upsertAll(specs, (s) => s.name)
    return `${r.files} word-link file(s) from ${entry.fullName} ${entry.ref}; ${r.changed} changed.`
  }

  if (isTw(entry)) {
    const zip = await w.aquilla.web.fetch(`${DCS}/${owner}/${repo}/archive/${entry.ref}.zip`, { as: "bytes" })
    if (!(zip.body instanceof ArrayBuffer)) throw new Error("Door43 did not return the archive")
    const archive = await w.aq.zip.read(zip.body)
    const byCat = new Map<string, Array<{ word: string; blocks: MdBlock[] }>>()
    for (const name of archive.names.sort()) {
      const m = /bible\/(kt|names|other)\/([^/]+)\.md$/.exec(name)
      if (!m) continue
      const arr = byCat.get(m[1]) ?? []
      arr.push({ word: m[2], blocks: w.aq.parse.mdBlocks(await archive.text(name)) })
      byCat.set(m[1], arr)
    }
    const specs = [...byCat.entries()].flatMap(([cat, articles]) => {
      const s = specForTwCategory(entry, projectId, cat, articles)
      return s ? [s] : []
    })
    const r = await upsertAll(specs, (s) => s.name)
    return `${r.files} Translation Words file(s) from ${entry.fullName} ${entry.ref}; ${r.changed} changed.`
  }

  // Built-in parity: the exact fetch/route/parse the built-in import runs.
  const fetched = await fetchDcsSources(client, entry, {
    includePath: wantPath,
    onFetched: (path, done, total) => void w.aquilla.import.progress(`Fetching ${path}`, (done / Math.max(1, total)) * 0.5),
  })
  const { planned, skipped } = planDcsFiles({ entry, fetched, projectId })
  let changed = 0
  let aligned = 0
  for (const [i, p] of planned.entries()) {
    const spec = specForPlanned(entry, p)
    await w.aquilla.import.progress(`Importing ${spec.name}`, 0.5 + (i / Math.max(1, planned.length)) * 0.5)
    const out = await w.aquilla.files.upsert({ ...spec, meta: metaOf(spec) })
    if (out.created || out.creates + out.commits + out.deletes > 0) changed++
    if (options.alignment !== false && p.fileType === "usfm") aligned += await alignmentAsData(spec, p.rawSource, entry)
  }
  return [
    `${planned.length} file(s) from ${entry.fullName} ${entry.ref}; ${changed} changed.`,
    aligned ? `${aligned} aligned verse(s) kept as data.` : "",
    skipped.length ? `Skipped: ${skipped.map((s) => s.book).join(", ")}.` : "",
  ].filter(Boolean).join(" ")
}

async function refresh(options: Record<string, unknown>, fileIds: string[]): Promise<string> {
  const { owner, repo } = splitRepo(str(options.resource))
  const files = (await w.aquilla.files.list()).filter((f) => fileIds.includes(f.fileId))
  const entry = await latestEntry(owner, repo)
  if (files.length > 0 && files.every((f) => f.meta?.sha === entry.commitSha)) return `Already up to date (${entry.fullName} ${entry.ref}).`
  const books = files.flatMap((f) => (f.tags ?? []).filter((t) => t.startsWith("book:")).map((t) => t.slice(5)))
  return importResource(options, books.length > 0 ? books : null)
}

async function main(): Promise<void> {
  const ctx = w.aquilla.context
  if (ctx.mount !== "import" || !ctx.import) {
    document.body.textContent = "Door43 resources: use it from Import (Smart Extensions)."
    return
  }
  const job = ctx.import
  try {
    if (job.phase === "choices") return await choices(job.field ?? "", job.options)
    const message = job.phase === "refresh" ? await refresh(job.options, job.fileIds ?? []) : await importResource(job.options, null)
    await w.aquilla.import.done(message)
  } catch (err) {
    if (job.phase === "choices") await w.aquilla.import.choices([])
    else await w.aquilla.import.done(err instanceof Error ? err.message : String(err), { ok: false })
  }
}

void main()
