// AQU-1937: what the first-party Door43 importer EXTENSION upserts, as pure
// functions (imported by the sandbox bundle AND by the parity test).
//
// The files and cells come from import-plan.ts — the exact fetch/route/parse
// the built-in Door43 import runs — and keep its deterministic ids (fileId,
// cellId), name, book code, type, ref, sequence index, metadata, order and raw
// source. Only provenance differs (which importer wrote it). Translation Words
// (TW) and Translation Words Links (TWL), which the built-in cannot import,
// and word alignment kept as data, are BEYOND the built-in and live here.

import type { DcsCatalogEntry } from "../types"
import type { PlannedDcsFile } from "../import-plan"
import { dcsCellId, dcsFileId } from "../cell-id"
import { contentHash } from "../content-hash"

/** The files.upsert spec shape (host-handlers-files.ts ToolFileUpsert). */
export interface Door43UpsertSpec {
  fileId: string
  key: string
  name: string
  kind: "normal" | "reference"
  tags: string[]
  group?: string
  format: string
  bookCode?: string
  cells: Array<{
    key: string
    cellId: string
    value: string
    html?: string
    type?: string
    ref?: string
    sequenceIndex?: number
    metadata?: Record<string, unknown>
  }>
  raw?: { text: string; format: string }
  upstream: Record<string, unknown>
}

export function upstreamOf(entry: DcsCatalogEntry, path: string): Record<string, unknown> {
  return {
    owner: entry.owner,
    repo: entry.name,
    ref: entry.ref,
    refType: entry.refType ?? "tag",
    sha: entry.commitSha,
    subject: entry.subject,
    released: entry.released,
    path,
  }
}

function tagsFor(entry: DcsCatalogEntry, bookCode: string | undefined): string[] {
  return ["door43", `door43:${entry.name}`, ...(bookCode ? [`book:${bookCode}`] : [])]
}

/** A built-in-parity file → its upsert spec (ids and cells unchanged). */
export function specForPlanned(entry: DcsCatalogEntry, p: PlannedDcsFile): Door43UpsertSpec {
  const { file } = p
  return {
    fileId: file.fileId,
    key: `door43:${entry.fullName}:${p.sourcePath}`,
    name: file.name,
    kind: "normal",
    tags: tagsFor(entry, file.bookCode),
    ...(file.bookCode ? { group: `door43:${file.bookCode}` } : {}),
    format: p.fileType,
    ...(file.bookCode ? { bookCode: file.bookCode } : {}),
    cells: file.cells.map((c) => ({
      key: c.cellId,
      cellId: c.cellId,
      value: c.value,
      ...(c.valueHtml !== undefined ? { html: c.valueHtml } : {}),
      type: c.type,
      ...(c.canonicalRef !== undefined ? { ref: c.canonicalRef } : {}),
      ...(c.sequenceIndex !== undefined ? { sequenceIndex: c.sequenceIndex } : {}),
      ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
    })),
    raw: { text: p.rawSource, format: p.fileType },
    upstream: upstreamOf(entry, p.sourcePath),
  }
}

// ── Beyond the built-in: Translation Words Links (TSV) ─────────────────────

/** twl_<BOOK>.tsv → a REFERENCE file: one cell per row (key = the row ID),
 *  value OrigWords, ref "BOOK c:v", metadata { article, occurrence, tags, link }. */
export function specForTwl(entry: DcsCatalogEntry, projectId: string, path: string, text: string, book: string): Door43UpsertSpec | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.length > 0)
  const header = (lines.shift() ?? "").split("\t")
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  const iRef = col("Reference"), iId = col("ID"), iTags = col("Tags"), iWords = col("OrigWords"), iOcc = col("Occurrence"), iLink = col("TWLink")
  if (iRef < 0 || iId < 0 || iWords < 0) return null
  const cells: Door43UpsertSpec["cells"] = []
  for (const line of lines) {
    const f = line.split("\t")
    const id = f[iId]
    if (!id) continue
    const link = iLink >= 0 ? f[iLink] ?? "" : ""
    const article = /\/dict\/bible\/(.+)$/.exec(link)?.[1] ?? ""
    cells.push({
      key: id,
      cellId: dcsCellId(`${entry.fullName}|${book}|${id}`),
      value: f[iWords] ?? "",
      type: "text",
      ref: `${book} ${f[iRef] ?? ""}`.trim(),
      metadata: { article, occurrence: iOcc >= 0 ? f[iOcc] ?? "" : "", tags: iTags >= 0 ? f[iTags] ?? "" : "", link },
    })
  }
  if (cells.length === 0) return null
  return {
    fileId: dcsFileId(projectId, entry.fullName, path),
    key: `door43:${entry.fullName}:${path}`,
    name: `${book} word links`,
    kind: "reference",
    tags: tagsFor(entry, book),
    group: `door43:${book}`,
    format: "tsv",
    bookCode: book,
    cells,
    raw: { text, format: "tsv" },
    upstream: upstreamOf(entry, path),
  }
}

// ── Beyond the built-in: Translation Words (markdown articles) ─────────────

export interface MdBlock {
  kind: string
  level: number
  text: string
  section: string
}

/** One TW category (kt / names / other) → one file; each article's heading
 *  and blocks are cells keyed "<article>|<section>|<n>", ref "tw:<cat>/<word>". */
export function specForTwCategory(
  entry: DcsCatalogEntry,
  projectId: string,
  category: string,
  articles: Array<{ word: string; blocks: MdBlock[] }>,
): Door43UpsertSpec | null {
  const cells: Door43UpsertSpec["cells"] = []
  for (const { word, blocks } of articles) {
    const counts = new Map<string, number>()
    for (const b of blocks) {
      const n = counts.get(b.section) ?? 0
      counts.set(b.section, n + 1)
      const key = `${category}/${word}|${b.kind === "heading" ? "heading" : b.section}|${n}`
      cells.push({
        key,
        cellId: dcsCellId(`${entry.fullName}|bible/${category}/${word}.md|${b.section}|${n}`),
        value: b.text,
        type: b.kind === "heading" ? "heading" : b.section.startsWith("word-data") ? "paratext" : "text",
        ref: `tw:${category}/${word}`,
        metadata: { article: `${category}/${word}`, section: b.section, block: b.kind, level: b.level },
      })
    }
  }
  if (cells.length === 0) return null
  return {
    fileId: dcsFileId(projectId, entry.fullName, `bible/${category}`),
    key: `door43:${entry.fullName}:bible/${category}`,
    name: `Translation Words: ${category}`,
    kind: "normal",
    tags: ["door43", `door43:${entry.name}`, `tw:${category}`],
    format: "md",
    cells,
    upstream: upstreamOf(entry, `bible/${category}`),
  }
}

// ── Beyond the built-in: word alignment kept as data ───────────────────────

export interface AlignmentGroup {
  src: Array<Record<string, string>>
  tgt: Array<{ w: string; occ: number }>
}

/** Pull each verse's \zaln-s groups out of aligned USFM (words with the
 *  milestones around them), keyed by ref. */
export function alignmentsFromWords(
  verses: Array<{ ref: string; words: Array<{ text: string; occurrence: number; milestones: Record<string, string>[] }> }>,
): Map<string, AlignmentGroup[]> {
  const out = new Map<string, AlignmentGroup[]>()
  for (const v of verses) {
    const groups = new Map<string, AlignmentGroup>()
    for (const w of v.words) {
      if (w.milestones.length === 0) continue
      const key = JSON.stringify(w.milestones)
      const g = groups.get(key) ?? { src: w.milestones, tgt: [] }
      g.tgt.push({ w: w.text, occ: w.occurrence })
      groups.set(key, g)
    }
    if (groups.size > 0) out.set(v.ref, [...groups.values()])
  }
  return out
}

/** Stable hash used in progress messages / tests. */
export const specDigest = (spec: Door43UpsertSpec): string => contentHash(JSON.stringify(spec.cells))
