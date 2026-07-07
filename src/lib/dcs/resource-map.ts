// Resource dispatch (spec §4). ROUTES is an ordered list; routeFor() returns the
// first route whose `matches` predicate accepts the (entry, manifest) pair. Each
// route turns raw repo files into DcsFile[] with STABLE, content-addressed ids
// (spec §5) — it reuses the existing format parser, then OVERRIDES the parser's
// fresh uuids with `dcsCellId(seed)` so cross-import lineage holds.

import type { DcsCatalogEntry, DcsManifest, DcsFile, DcsCell, ResourceRoute } from "./types"
import { dcsCellId, dcsFileId } from "./cell-id"
import { contentHash } from "./content-hash"
import { extractUsfmStrings } from "@/lib/parsers/usfm"

/** True when the manifest declares a USFM-format scripture bundle/book. */
function isUsfmManifest(manifest: DcsManifest): boolean {
  const fmt = manifest.format.toLowerCase()
  const typeOk = manifest.rcType === "book" || manifest.rcType === "bundle"
  return typeOk && (fmt.includes("usfm") || fmt.includes("usx"))
}

/**
 * USFM route: Bible ULT/UST, UGNT, UHB, … One verse → one cell, id seeded
 * `${repo}|BOOK C:V` (spec §4). Reuses the existing usfm parser, then replaces
 * its fresh uuids with deterministic ones and stamps content hashes.
 */
const usfmRoute: ResourceRoute = {
  id: "usfm",
  matches: (entry, manifest) =>
    entry.contentFormat.toLowerCase() === "usfm" || isUsfmManifest(manifest),
  parse: ({ entry, files }) => {
    const repo = entry.fullName
    const out: DcsFile[] = []

    for (const [path, text] of files) {
      if (!path.toLowerCase().endsWith(".usfm")) continue

      // The existing parser can emit several books per file (\id sections); the
      // adapter keeps one DcsFile per USFM file, book code from the first section.
      const books = extractUsfmStrings(text)
      const cells: DcsCell[] = []
      let bookCode: string | undefined

      // A verse can split into multiple segments (splitIntoSegments); disambiguate
      // the id seed with a per-ref segment index so ids stay stable AND unique.
      const refSegmentCount = new Map<string, number>()

      for (const book of books) {
        if (bookCode === undefined && book.bookId !== "unknown") bookCode = book.bookId

        for (const s of book.strings) {
          // Prefer the explicit globalReferences (verse ref[s]); fall back to
          // context (which the parser sets to "BOOK C:V" for verses).
          const ref = s.globalReferences?.[0] ?? s.context
          const segIdx = refSegmentCount.get(ref) ?? 0
          refSegmentCount.set(ref, segIdx + 1)
          // Only append a segment suffix when a ref actually splits — keeps the
          // common one-segment-per-verse seed clean (`repo|TIT 1:1`).
          const seed = segIdx === 0 ? `${repo}|${ref}` : `${repo}|${ref}#${segIdx}`

          cells.push({
            cellId: dcsCellId(seed),
            value: s.original,
            ...(s.originalHtml !== undefined ? { valueHtml: s.originalHtml } : {}),
            type: s.type,
            canonicalRef: ref,
            contentHash: contentHash(s.original),
          })
        }
      }

      out.push({
        fileId: dcsFileId(repo, path),
        name: bookCode ? `${bookCode} (${path})` : path,
        ...(bookCode !== undefined ? { bookCode } : {}),
        cells,
      })
    }

    return out
  },
}

// ── Ordered dispatch list. First `matches` wins. ───────────────────────────
//
// SWARM-TODO(Slice E): add OBS (markdown story frames), TSV notes/questions,
// and markdown tw/ta routes here, ahead of / after usfm as their `matches`
// predicates dictate. Each is one parser + one cell-id rule (spec §4); the
// pipeline (import-dcs, delta) is unchanged.
export const ROUTES: ResourceRoute[] = [usfmRoute]

/** Return the first route matching (entry, manifest), or null if none. */
export function routeFor(entry: DcsCatalogEntry, manifest: DcsManifest): ResourceRoute | null {
  return ROUTES.find((r) => r.matches(entry, manifest)) ?? null
}
