// AQU-1573: put one reference Bible's verses into Postgres, idempotently.
//
// Called by scripts/reference-bibles.ts `load` (dev boot and the production
// command) with the committed, pinned text from db/reference-bibles/. The
// manifest's content hash decides whether there is anything to do: the same
// hash and verse count means the version is already loaded, and only its
// display metadata is refreshed. Otherwise the version row, the delete of the
// old verses and the new verses go in ONE batch (one transaction), with
// `verse_count` written in the final statement — so a failed or interrupted
// load leaves the previous text in place, never half a Bible.

import type { ReferenceVerseRow } from "../../src/lib/reference-bible/types"
import type { AquillaDb, AquillaStatement } from "../shim/postgres"

/** One entry of db/reference-bibles/manifest.json. */
export interface ReferenceBibleManifestEntry {
  id: string
  name: string
  fullName: string
  languageCode: string
  languageName: string
  direction: "ltr" | "rtl"
  versification: string
  printing: string | null
  license: string
  source: {
    provider: string
    ebibleId: string
    url: string
    buildDate: string
    zipSha256: string
  }
  verseCount: number
  /** sha256 of the uncompressed TSV. */
  contentSha256: string
  /** TSV file name next to the manifest. */
  file: string
}

export type ReferenceBibleLoadResult = "loaded" | "already loaded"

const INSERT_CHUNK = 500

/** The human-readable provenance stored in reference_bible_versions.source. */
export function referenceBibleSourceLabel(entry: ReferenceBibleManifestEntry): string {
  return `${entry.source.provider} ${entry.source.ebibleId} (build ${entry.source.buildDate})`
}

/** What is in the database for `id` now, or null when the version row is absent. */
export async function referenceBibleLoadState(
  db: AquillaDb,
  id: string,
): Promise<{ verseCount: number; contentSha256: string | null } | null> {
  const row = await db
    .prepare("SELECT verse_count, content_sha256 FROM reference_bible_versions WHERE id = ?")
    .bind(id)
    .first<{ verse_count: number; content_sha256: string | null }>()
  return row ? { verseCount: Number(row.verse_count), contentSha256: row.content_sha256 } : null
}

/** True when the database already holds exactly this manifest entry's text. */
export async function isReferenceBibleCurrent(db: AquillaDb, entry: ReferenceBibleManifestEntry): Promise<boolean> {
  const state = await referenceBibleLoadState(db, entry.id)
  return !!state && state.contentSha256 === entry.contentSha256 && state.verseCount === entry.verseCount
}

function upsertVersion(db: AquillaDb, entry: ReferenceBibleManifestEntry): AquillaStatement {
  return db
    .prepare(
      `INSERT INTO reference_bible_versions
         (id, name, full_name, language_code, language_name, direction, versification, printing, license, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, full_name = excluded.full_name,
         language_code = excluded.language_code, language_name = excluded.language_name,
         direction = excluded.direction, versification = excluded.versification,
         printing = excluded.printing, license = excluded.license, source = excluded.source,
         updated_at = now()`,
    )
    .bind(
      entry.id,
      entry.name,
      entry.fullName,
      entry.languageCode,
      entry.languageName,
      entry.direction,
      entry.versification,
      entry.printing,
      entry.license,
      referenceBibleSourceLabel(entry),
    )
}

/**
 * Load `verses` as version `entry.id`. Skips the verse rewrite when the stored
 * hash and count already match, unless `force`.
 */
export async function loadReferenceBibleVersion(
  db: AquillaDb,
  entry: ReferenceBibleManifestEntry,
  verses: readonly ReferenceVerseRow[],
  opts: { force?: boolean } = {},
): Promise<ReferenceBibleLoadResult> {
  if (verses.length !== entry.verseCount) {
    throw new Error(`${entry.id}: ${verses.length} verses read but the manifest says ${entry.verseCount}`)
  }
  if (!opts.force && (await isReferenceBibleCurrent(db, entry))) {
    await upsertVersion(db, entry).run()
    return "already loaded"
  }
  const stmts: AquillaStatement[] = [
    upsertVersion(db, entry),
    // Hide the version from readers for the length of the rewrite.
    db.prepare("UPDATE reference_bible_versions SET verse_count = 0, content_sha256 = NULL WHERE id = ?").bind(entry.id),
    db.prepare("DELETE FROM reference_bible_verses WHERE version_id = ?").bind(entry.id),
  ]
  for (let i = 0; i < verses.length; i += INSERT_CHUNK) {
    const chunk = verses.slice(i, i + INSERT_CHUNK)
    const params: unknown[] = []
    for (const v of chunk) params.push(entry.id, v.book, v.chapter, v.verse, v.text)
    stmts.push(
      db
        .prepare(
          `INSERT INTO reference_bible_verses (version_id, book, chapter, verse, text) VALUES ${chunk
            .map(() => "(?, ?, ?, ?, ?)")
            .join(", ")}`,
        )
        .bind(...params),
    )
  }
  stmts.push(
    db
      .prepare(
        `UPDATE reference_bible_versions
            SET verse_count = ?, content_sha256 = ?, loaded_at = now(), updated_at = now()
          WHERE id = ?`,
      )
      .bind(verses.length, entry.contentSha256, entry.id),
  )
  await db.batch(stmts)
  return "loaded"
}
