// Public contract for the DCS (Door43 Content Service) importer / external-upstream
// adapter. See docs/superpowers/specs/2026-07-06-dcs-importer-design.md.
//
// This file is the API boundary between the foundation module (catalog client,
// manifest, cell-id, resource-map, import, delta, cursor) and its consumers
// (ImportDialog UI, aligned-target flow, freshness panel). Implementations may
// EXTEND these types additively but must not change existing field meanings.

export type DcsTrackMode = "release" | "head"

/** One Door43 Catalog entry (a released Resource Container). Normalized from
 *  GET /api/v1/catalog/entry/{owner}/{repo}/{ref} or a /catalog/search row. */
export interface DcsCatalogEntry {
  name: string // repo name, e.g. "en_ult"
  owner: string // e.g. "unfoldingWord"
  fullName: string // "unfoldingWord/en_ult"
  subject: string // e.g. "Aligned Bible", "Translation Notes", "Open Bible Stories"
  contentFormat: string // "usfm" | "markdown" | "tsv" | ...
  flavorType?: string // "scripture" | "gloss"
  ref: string // branch_or_tag_name, e.g. "v89"
  refType?: string // "tag" | "branch"
  commitSha: string
  released: string // ISO timestamp
  zipballUrl: string
  metadataUrl: string // raw manifest.yaml URL
  language: string // "en", "el-x-koine", "hbo", ...
  languageTitle?: string
  languageDirection?: string // "ltr" | "rtl"
}

/** Result of GET /repos/{owner}/{repo}/compare/{old}...{new}.
 *  NOTE: DCS's Gitea does NOT populate the response's top-level `.files`; the
 *  changed-file set is the UNION of `.commits[].files[].filename`. The client
 *  MUST compute it from per-commit files. */
export interface DcsCompareResult {
  totalCommits: number
  changedFiles: string[]
}

/** Where a DCS-fed adapter project is pinned. Persisted in the adapter project's
 *  project_settings under the key "dcsUpstream" (JSONB; no schema migration). */
export interface DcsCursor {
  owner: string
  repo: string
  subject: string
  contentFormat: string
  trackMode: DcsTrackMode
  ref: string // pinned tag/branch, e.g. "v89"
  commitSha: string // the cursor
  released: string
  importedAt: string
}

/** Parsed RC manifest.yaml (subset we route on). */
export interface DcsManifest {
  rcType: string // dublin_core.type: "book" | "help" | "dict" | "man" | "bundle"
  subject: string
  format: string // dublin_core.format, e.g. "text/usfm"
  identifier: string // e.g. "ult", "tn", "obs"
  language: { identifier: string; title: string; direction: string }
  projects: Array<{ identifier: string; path: string; title?: string; sort?: number }>
}

/** A translatable unit with a STABLE, content-addressed id (see cell-id.ts).
 *  The unit of import, delta comparison, and downstream lineage. */
export interface DcsCell {
  cellId: string // deterministic uuidv5 (NEVER a fresh uuidv7)
  value: string // translatable text (plain)
  valueHtml?: string
  type: string // CellType, e.g. "verse" | "text" | "heading"
  canonicalRef?: string
  contentHash: string // djb2, MUST match sync-worker contentHash() normalization
  sequenceIndex?: number
  metadata?: Record<string, unknown> // untranslated cols (SupportReference, Quote, ...)
}

/** A parsed DCS file (a book, story, or note file) with its cells. */
export interface DcsFile {
  fileId: string // deterministic uuidv5
  name: string // e.g. "57-TIT.usfm" or book/story title
  /** Exact repository-relative member that produced this file. */
  sourcePath?: string
  bookCode?: string
  cells: DcsCell[]
}

/** Dispatch entry: a resource type's parser. resource-map.ts holds the ordered
 *  list; the first `matches` wins. */
export interface ResourceRoute {
  id: string // "usfm" | "obs" | "tsv-notes" | "tsv-questions" | "md-dict" | "md-manual"
  matches: (entry: DcsCatalogEntry, manifest: DcsManifest) => boolean
  /** Turn raw repo files (path → text) into translatable files/cells with stable
   *  ids. `files` keys are repo-relative paths from the git tree. */
  parse: (input: {
    entry: DcsCatalogEntry
    manifest: DcsManifest
    files: Map<string, string>
  }) => DcsFile[]
}
