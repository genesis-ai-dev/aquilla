// Reference-Bible version registry (AQU-1573) — the authoritative list of
// Bible versions a project may name in `settings.referenceBibleVersions`.
//
// WHY THIS IS NOT `bibleResourcesEnabled`. That switch is a verse LOOKUP over
// the Aquifer corpus (bibletranslation.org), built for projects whose cells ARE
// Scripture: it offers no version choice and no non-English text. A project
// translating sermons, devotionals, curriculum or books has the opposite need —
// its cells are prose that QUOTES Scripture, and the quoted verse must be
// copied verbatim from the Bible its readers already know rather than
// retranslated from the English. An Arabic reader hears a fresh rendering of
// Isaiah 40:25 immediately. So the two are independent: a reference Bible works
// with Bible resources OFF, which is the state every such project wants.
//
// This file is METADATA + PURE VALIDATORS ONLY, dependency-free so BOTH workers
// and the SPA can import it — same contract as project-settings-keys.ts, which
// delegates the `referenceBibleVersions` value check here.
//
// WHERE THE TEXT LIVES. A version's bytes are per-book USFM objects in the
// existing `aquilla-snapshots` R2 bucket under `r2Prefix`, one object per USFM
// book code (`<prefix><BOOK>.usfm`, e.g. `reference-bibles/arb-vandyck/ISA.usfm`).
// Provisioning those objects is an operations step, deliberately separate from
// this registry: the registry says which versions are LEGAL to name and where
// their text would be, and `referenceBibleObjectKey()` is the one place that
// spelling is decided. A named version whose object is absent resolves to no
// text and is reported as such (see the resolver in
// sync-worker/src/lib/reference-bible.ts) rather than silently drafting without
// the verse — a missing reference text must be visible, never inferred away.
//
// Every seeded version here is PUBLIC DOMAIN. Partner-licensed versions are
// added as further entries once the licence is on file; nothing in the registry
// fetches anything, so adding one is a metadata change plus an R2 upload.

/** One selectable reference Bible version. */
export interface ReferenceBibleVersion {
  /** Stable id stored in `settings.referenceBibleVersions`. Never renamed. */
  id: string
  /** Display label, e.g. "Smith–Van Dyck (1865)". */
  label: string
  /** ISO 639-3 code of the version's language. */
  languageCode: string
  /** Display language name, e.g. "Arabic". */
  languageLabel: string
  /** Licence statement shown beside the option. */
  licence: string
  /** R2 key prefix holding this version's per-book USFM objects. */
  r2Prefix: string
}

/**
 * The versions a project may name today. Ordered as the settings UI lists
 * them: the languages our partners have asked for, then English.
 */
export const REFERENCE_BIBLE_VERSIONS: readonly ReferenceBibleVersion[] = [
  {
    id: "arb-vandyck",
    label: "Smith–Van Dyck (1865)",
    languageCode: "arb",
    languageLabel: "Arabic",
    licence: "Public domain",
    r2Prefix: "reference-bibles/arb-vandyck/",
  },
  {
    id: "spa-rvr1909",
    label: "Reina-Valera (1909)",
    languageCode: "spa",
    languageLabel: "Spanish",
    licence: "Public domain",
    r2Prefix: "reference-bibles/spa-rvr1909/",
  },
  {
    id: "deu-luther1912",
    label: "Luther (1912)",
    languageCode: "deu",
    languageLabel: "German",
    licence: "Public domain",
    r2Prefix: "reference-bibles/deu-luther1912/",
  },
  {
    id: "eng-kjv",
    label: "King James Version (1769)",
    languageCode: "eng",
    languageLabel: "English",
    licence: "Public domain",
    r2Prefix: "reference-bibles/eng-kjv/",
  },
]

const BY_ID = new Map(REFERENCE_BIBLE_VERSIONS.map((v) => [v.id, v]))

/**
 * How many versions one project may name. A reference verse is injected into
 * every drafting prompt that quotes Scripture, so the cap is a prompt-budget
 * guard, not a licensing one: three renderings of the same verse is already
 * more than a drafting model can use.
 */
export const MAX_REFERENCE_BIBLE_VERSIONS = 3

export function referenceBibleVersion(id: string): ReferenceBibleVersion | undefined {
  return BY_ID.get(id)
}

export function isKnownReferenceBibleVersion(id: string): boolean {
  return BY_ID.has(id)
}

/** Resolve ids to versions, dropping unknown ids. Order is the caller's. */
export function resolveReferenceBibleVersions(
  ids: readonly string[] | undefined | null,
): ReferenceBibleVersion[] {
  const seen = new Set<string>()
  const out: ReferenceBibleVersion[] = []
  for (const id of ids ?? []) {
    const version = BY_ID.get(id)
    if (!version || seen.has(version.id)) continue
    seen.add(version.id)
    out.push(version)
  }
  return out
}

/**
 * The R2 object key holding `bookCode`'s USFM for `version`. The one place the
 * layout is spelled; the resolver and any provisioning script share it so an
 * upload and a read cannot disagree about where a book lives.
 */
export function referenceBibleObjectKey(
  version: ReferenceBibleVersion,
  bookCode: string,
): string {
  return `${version.r2Prefix}${bookCode.toUpperCase()}.usfm`
}

/**
 * Validate a `referenceBibleVersions` settings value beyond its `string[]`
 * shape. Returns null when it is fine, else a message naming what is wrong.
 * Shared by PatchSettings and the settings UI so an agent and a human get the
 * same answer.
 */
export function validateReferenceBibleVersions(value: unknown): string | null {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return 'settings key "referenceBibleVersions" expects string[]'
  }
  if (value.length > MAX_REFERENCE_BIBLE_VERSIONS) {
    return `referenceBibleVersions accepts at most ${MAX_REFERENCE_BIBLE_VERSIONS} versions`
  }
  const unknown = (value as string[]).filter((id) => !BY_ID.has(id))
  if (unknown.length) {
    return (
      `unknown reference Bible version${unknown.length > 1 ? "s" : ""} ` +
      `${unknown.map((id) => `"${id}"`).join(", ")} — known versions: ` +
      REFERENCE_BIBLE_VERSIONS.map((v) => `"${v.id}"`).join(", ")
    )
  }
  return null
}
