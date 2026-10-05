// AQU-1573: the reference Bibles (Van Dyck Arabic, KJV) — load them into
// Postgres, or rebuild the committed text from eBible.org.
//
//   load     Put every Bible in db/reference-bibles/manifest.json into the
//            database. Reads ONLY committed files (no network). Idempotent:
//            a version whose stored hash matches the manifest is skipped
//            without reading its file. Dev boot runs this (scripts/dev-stack.ts).
//              --version <id>   only this Bible
//              --if-missing     skip any Bible that is loaded at all, even an
//                               older text
//              --force          rewrite the verses even when current
//
//   refresh  Maintainer tool, needs the network. Download each Bible's USFM
//            zip from eBible.org, extract the verses, and rewrite the
//            committed .tsv.gz plus the manifest's hashes, build date and
//            verse count. Commit the result; nothing else ever downloads.
//              --version <id>   only this Bible
//
// Connection: AQUILLA_DATABASE_URL, else NEON_PG_HOST + NEON_PG_PASSWORD
// (+ NEON_PG_DB, NEON_PG_ROLE), the same as scripts/neon-backfill-progress.ts.
//
// PRODUCTION (and every PR-preview database): apply migration
// 0129_reference_bibles.sql by hand like every other migration, then run
//   AQUILLA_DATABASE_URL=… npx tsx scripts/reference-bibles.ts load
// It is safe to run again. Until it has run, the feature reports that no
// reference Bibles are installed. See docs/reference-bibles.md.

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"
import {
  isReferenceBibleCurrent,
  loadReferenceBibleVersion,
  referenceBibleLoadState,
  type ReferenceBibleManifestEntry,
} from "../db/shared/reference-bible-load"
import type { AquillaDb } from "../db/shim/postgres"
import { getBookOrdinal } from "../src/lib/file-labeling/bible-book-names"
import type { ReferenceVerseRow } from "../src/lib/reference-bible/types"
import { extractUsfmVerses } from "../src/lib/reference-bible/usfm-verses"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const REFERENCE_BIBLES_DIR = path.join(REPO_ROOT, "db", "reference-bibles")
const MANIFEST = path.join(REFERENCE_BIBLES_DIR, "manifest.json")

/**
 * What `refresh` builds. Ids are the app's own, stable across re-downloads.
 * eBible ids verified 2026-10-02: `arb-vd` is the Smith & Van Dyck text
 * ("Arabic Van Dyck Bible, Public Domain, Translation by: Syrian Mission"),
 * NOT `arbnav` (Biblica's copyrighted New Arabic Version). `eng-kjv2006` is
 * the 1769 KJV without the Apocrypha. Both number verses the English (KJV)
 * way, so references from English sermons resolve directly.
 */
const CATALOG: ReadonlyArray<Omit<ReferenceBibleManifestEntry, "source" | "verseCount" | "contentSha256"> & { ebibleId: string }> = [
  {
    id: "arb-vandyck",
    ebibleId: "arb-vd",
    name: "Van Dyck",
    fullName: "Smith & Van Dyck Arabic Bible (1865)",
    languageCode: "ar",
    languageName: "Arabic",
    direction: "rtl",
    versification: "eng",
    printing: "vowelled (full tashkeel), as published by eBible.org",
    license: "Public domain",
    file: "arb-vandyck.tsv.gz",
  },
  {
    id: "eng-kjv",
    ebibleId: "eng-kjv2006",
    name: "King James Version",
    fullName: "King James Version (1769 standard text)",
    languageCode: "en",
    languageName: "English",
    direction: "ltr",
    versification: "eng",
    printing: "1769 text without the Apocrypha; Strong's tags and italic brackets removed, supplied words kept",
    license: "Public domain",
    file: "eng-kjv.tsv.gz",
  },
]

export function readManifest(): ReferenceBibleManifestEntry[] {
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as ReferenceBibleManifestEntry[]
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/** One line per verse: BOOK<TAB>CHAPTER<TAB>VERSE<TAB>TEXT, canonical order. */
export function toTsv(rows: readonly ReferenceVerseRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => getBookOrdinal(a.book) - getBookOrdinal(b.book) || a.chapter - b.chapter || a.verse - b.verse,
  )
  return sorted.map((r) => `${r.book}\t${r.chapter}\t${r.verse}\t${r.text}\n`).join("")
}

export function parseTsv(tsv: string): ReferenceVerseRow[] {
  const rows: ReferenceVerseRow[] = []
  for (const line of tsv.split("\n")) {
    if (!line) continue
    const [book, chapter, verse, ...text] = line.split("\t")
    rows.push({ book, chapter: Number(chapter), verse: Number(verse), text: text.join("\t") })
  }
  return rows
}

/** The committed text for one manifest entry, checked against its hash. */
export function readVerses(entry: ReferenceBibleManifestEntry): ReferenceVerseRow[] {
  const tsv = gunzipSync(readFileSync(path.join(REFERENCE_BIBLES_DIR, entry.file))).toString("utf8")
  const hash = sha256(tsv)
  if (hash !== entry.contentSha256) {
    throw new Error(`${entry.file}: content hash ${hash} does not match the manifest (${entry.contentSha256})`)
  }
  return parseTsv(tsv)
}

function connectionString(): string {
  const direct = process.env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = process.env.NEON_PG_HOST?.trim()
  const database = process.env.NEON_PG_DB?.trim() || "neondb"
  const role = process.env.NEON_PG_ROLE?.trim() || "neondb_owner"
  const password = process.env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error("Set AQUILLA_DATABASE_URL, or NEON_PG_HOST and NEON_PG_PASSWORD")
  const url = new URL("postgresql://placeholder")
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set("sslmode", "require")
  return url.toString()
}

export type LoadOutcome = { id: string; status: "loaded" | "already loaded" | "failed"; verseCount: number; error?: string }

/** Load every manifest entry (or `only`) into `db`. Never throws per version. */
export async function loadAll(
  db: AquillaDb,
  opts: { only?: string; ifMissing?: boolean; force?: boolean } = {},
): Promise<LoadOutcome[]> {
  const entries = readManifest().filter((e) => !opts.only || e.id === opts.only)
  if (opts.only && entries.length === 0) throw new Error(`No Bible "${opts.only}" in the manifest`)
  const out: LoadOutcome[] = []
  for (const entry of entries) {
    try {
      if (!opts.force) {
        if (opts.ifMissing) {
          const state = await referenceBibleLoadState(db, entry.id)
          if (state && state.verseCount > 0) {
            out.push({ id: entry.id, status: "already loaded", verseCount: state.verseCount })
            continue
          }
        } else if (await isReferenceBibleCurrent(db, entry)) {
          out.push({ id: entry.id, status: "already loaded", verseCount: entry.verseCount })
          continue
        }
      }
      const status = await loadReferenceBibleVersion(db, entry, readVerses(entry), { force: opts.force })
      out.push({ id: entry.id, status, verseCount: entry.verseCount })
    } catch (err) {
      out.push({ id: entry.id, status: "failed", verseCount: 0, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

export function describeOutcomes(outcomes: readonly LoadOutcome[]): string {
  return (
    "reference Bibles: " +
    outcomes
      .map((o) => (o.status === "failed" ? `${o.id} failed (${o.error})` : `${o.id} ${o.status} (${o.verseCount})`))
      .join(", ")
  )
}

async function refresh(only?: string): Promise<void> {
  const { default: JSZip } = await import("jszip")
  const existing = (() => {
    try {
      return readManifest()
    } catch {
      return [] as ReferenceBibleManifestEntry[]
    }
  })()
  const manifest: ReferenceBibleManifestEntry[] = []
  for (const item of CATALOG) {
    const { ebibleId, ...meta } = item
    const kept = existing.find((e) => e.id === item.id)
    if (only && item.id !== only) {
      if (kept) manifest.push(kept)
      continue
    }
    const url = `https://ebible.org/Scriptures/${ebibleId}_usfm.zip`
    console.log(`downloading ${url}…`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    const zipBytes = new Uint8Array(await res.arrayBuffer())
    const zip = await JSZip.loadAsync(zipBytes)
    const rows: ReferenceVerseRow[] = []
    let buildDate = ""
    for (const file of Object.values(zip.files)) {
      if (file.dir || !file.name.toLowerCase().endsWith(".usfm")) continue
      const day = file.date.toISOString().slice(0, 10)
      if (day > buildDate) buildDate = day
      rows.push(...extractUsfmVerses(await file.async("string")))
    }
    const tsv = toTsv(rows)
    writeFileSync(path.join(REFERENCE_BIBLES_DIR, meta.file), gzipSync(tsv, { level: 9 }))
    manifest.push({
      ...meta,
      source: { provider: "eBible.org", ebibleId, url, buildDate, zipSha256: sha256(zipBytes) },
      verseCount: rows.length,
      contentSha256: sha256(tsv),
    })
    console.log(`${item.id}: ${rows.length} verses from ${ebibleId} (build ${buildDate})`)
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const only = flag("--version")
  if (command === "refresh") {
    await refresh(only)
    return
  }
  if (command !== "load") {
    console.error("usage: npx tsx scripts/reference-bibles.ts load [--version <id>] [--if-missing] [--force]\n" +
      "       npx tsx scripts/reference-bibles.ts refresh [--version <id>]")
    process.exitCode = 2
    return
  }
  const { makePostgres } = await import("../db/shim/postgres")
  const db = makePostgres(connectionString(), 1)
  try {
    const outcomes = await loadAll(db, {
      only,
      ifMissing: process.argv.includes("--if-missing"),
      force: process.argv.includes("--force"),
    })
    console.log(describeOutcomes(outcomes))
    if (outcomes.some((o) => o.status === "failed")) process.exitCode = 1
  } finally {
    await db.close()
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
