// Resolve reference-Bible verses for a drafting prompt (AQU-1573).
//
// A project names one or more reference Bible versions in
// `settings.referenceBibleVersions`; the registry (db/shared/reference-bibles.ts)
// says where each version's per-book USFM lives in the `aquilla-snapshots` R2
// bucket. This module is the read side: given the citations a source cell makes,
// hand back the verse text in each named version.
//
// WHY R2 AND NOT A LIVE THIRD-PARTY LOOKUP. The verse has to be in the prompt on
// every draft call, including a batch over 49 sessions, so it must be cheap and
// it must not fail the draft when someone else's service is down. It also has to
// be the SAME bytes every time, because the whole point is reproducing wording a
// reader already knows. An object in our own bucket satisfies all three; the
// Aquifer lookup behind `bibleResourcesEnabled` satisfies none of them (and
// carries no non-English text).
//
// A MISSING OBJECT IS REPORTED, NEVER INFERRED AWAY. If a version is named but
// its book has not been provisioned, the resolver returns the citation with no
// text and records why. Callers surface that — drafting without the reference
// verse while the project believes it is in force is the exact failure the
// feature exists to prevent.

import {
  referenceBibleObjectKey,
  resolveReferenceBibleVersions,
  type ReferenceBibleVersion,
} from "../../../db/shared/reference-bibles"
import {
  citationLabel,
  findScriptureCitations,
  type ScriptureCitation,
} from "../../../src/lib/completion/scripture-citations"
import { extractVerseText } from "../../../src/lib/completion/usfm-verse"
import type { ReferenceScriptureEntry } from "../../../src/lib/completion/prompt-build"

/** The subset of R2 this module needs — get only. */
export interface ReferenceBibleBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>
}

/** Why a named version produced no text for a citation. */
export type ReferenceBibleMissReason =
  /** The version's book object is not in the bucket. */
  | "book_not_provisioned"
  /** The book is provisioned but carries no such chapter/verse. */
  | "verse_not_in_version"

export interface ReferenceBibleMiss {
  canonicalRef: string
  citedAs: string
  versionId: string
  versionLabel: string
  reason: ReferenceBibleMissReason
  /** The R2 key consulted — the one thing an operator needs to fix it. */
  objectKey: string
}

export interface ResolvedReferenceScripture {
  /** Citations found in the source text, in order of appearance. */
  citations: ScriptureCitation[]
  /** One entry per (citation × version) that produced text. */
  entries: ReferenceScriptureEntry[]
  /** One entry per (citation × version) that did not. */
  misses: ReferenceBibleMiss[]
}

/** A fresh empty result each time — the arrays are the caller's to hold, and a
 *  shared constant would let one caller's mutation reach the next. */
function empty(): ResolvedReferenceScripture {
  return { citations: [], entries: [], misses: [] }
}

export interface ResolveReferenceScriptureArgs {
  /** The cell's effective source text. */
  sourceText: string
  /** `settings.referenceBibleVersions` as stored. */
  versionIds: readonly string[] | undefined | null
  /** Cap on citations resolved for one cell; defaults to the module's own. */
  citationLimit?: number
}

/**
 * Resolve the reference verses for one cell.
 *
 * Returns the empty result — without touching R2 — when the project names no
 * version or the source quotes nothing. `bibleResourcesEnabled` is deliberately
 * not consulted: a non-Scripture project keeps it off and still gets its
 * reference Bible.
 */
export async function resolveReferenceScripture(
  bucket: ReferenceBibleBucket | undefined,
  args: ResolveReferenceScriptureArgs,
): Promise<ResolvedReferenceScripture> {
  const versions = resolveReferenceBibleVersions(args.versionIds)
  if (!versions.length) return empty()

  const citations = findScriptureCitations(
    args.sourceText,
    args.citationLimit === undefined ? {} : { limit: args.citationLimit },
  )
  if (!citations.length) return empty()
  if (!bucket) {
    return {
      citations,
      entries: [],
      misses: citations.flatMap((citation) =>
        versions.map((version) => miss(citation, version, "book_not_provisioned")),
      ),
    }
  }

  // One R2 read per (version, book) however many verses of it are cited.
  const books = new Map<string, Promise<string | null>>()
  const readBook = (version: ReferenceBibleVersion, bookCode: string): Promise<string | null> => {
    const key = referenceBibleObjectKey(version, bookCode)
    const cached = books.get(key)
    if (cached) return cached
    const pending = loadBook(bucket, key)
    books.set(key, pending)
    return pending
  }

  const entries: ReferenceScriptureEntry[] = []
  const misses: ReferenceBibleMiss[] = []
  for (const citation of citations) {
    for (const version of versions) {
      const usfm = await readBook(version, citation.bookCode)
      if (usfm === null) {
        misses.push(miss(citation, version, "book_not_provisioned"))
        continue
      }
      const text = extractVerseText({
        usfm,
        chapter: citation.chapter,
        verseStart: citation.verseStart,
        verseEnd: citation.verseEnd,
      })
      if (!text) {
        misses.push(miss(citation, version, "verse_not_in_version"))
        continue
      }
      entries.push({
        canonicalRef: citation.canonicalRef,
        citedAs: citationLabel(citation),
        versionId: version.id,
        versionLabel: `${version.label}, ${version.languageLabel}`,
        text,
      })
    }
  }

  return { citations, entries, misses }
}

function miss(
  citation: ScriptureCitation,
  version: ReferenceBibleVersion,
  reason: ReferenceBibleMissReason,
): ReferenceBibleMiss {
  return {
    canonicalRef: citation.canonicalRef,
    citedAs: citationLabel(citation),
    versionId: version.id,
    versionLabel: `${version.label}, ${version.languageLabel}`,
    reason,
    objectKey: referenceBibleObjectKey(version, citation.bookCode),
  }
}

/** Read one book's USFM, or null when it is absent or unreadable. An R2 error
 *  must not fail the read that asked for it — a prompt without the reference
 *  verse is reported as a miss, which is the honest answer. */
async function loadBook(bucket: ReferenceBibleBucket, key: string): Promise<string | null> {
  try {
    const object = await bucket.get(key)
    if (!object) return null
    const usfm = await object.text()
    return usfm.trim() ? usfm : null
  } catch {
    return null
  }
}
