// AQU-1573: read side of the reference Bibles, shared by auth-worker (the
// SPA's list/passages routes, the agent's draft tool and staging lint) and
// sync-worker (PatchSettings/ProjectSetup validation, the Agent API's
// discovery read and prompt preview), so both answer the same way.
//
// "Installed" means a built-in version (org_id IS NULL — partner uploads come
// later and will be org-scoped) with verses loaded (verse_count > 0; the
// loader zeroes it for the length of a reload).

import { canonicalLaneId, extraRegistryLanes } from "../../src/lib/lanes/registry-lanes"
import { parseReferenceBibleSetting, referenceBibleForLane, referenceBibleSettingShapeProblem, type ReferenceBibleSettings } from "../../src/lib/reference-bible/lane-setting"
import { MAX_VERSES_PER_REFERENCE, findScriptureReferences, formatCanonical, formatLabel, parseCanonicalRef } from "../../src/lib/reference-bible/reference-finder"
import type { ReferenceBibleSummary, ReferencePassage, ScriptureRef } from "../../src/lib/reference-bible/types"
import type { AquillaDb } from "../shim/postgres"

/** References per lookup query; larger requests are split. */
const REFS_PER_QUERY = 60
/** References one source batch may resolve (the route caps requests the same). */
export const MAX_REFERENCES_PER_LOOKUP = 200
/** A cross-chapter range reads at most this many chapters before the verse cap applies. */
const MAX_CHAPTER_SPAN = 5

type VersionRow = {
  id: string
  name: string
  full_name: string
  language_code: string
  language_name: string
  direction: string
  versification: string
  printing: string | null
  license: string
  source: string
  verse_count: number
}

const VERSION_COLUMNS =
  "id, name, full_name, language_code, language_name, direction, versification, printing, license, source, verse_count"
const INSTALLED = "verse_count > 0 AND org_id IS NULL"

function toSummary(r: VersionRow): ReferenceBibleSummary {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    languageCode: r.language_code,
    languageName: r.language_name,
    direction: r.direction === "rtl" ? "rtl" : "ltr",
    versification: r.versification,
    printing: r.printing,
    license: r.license,
    source: r.source,
    verseCount: Number(r.verse_count),
  }
}

/** Every installed built-in Bible, by language then name. */
export async function listReferenceBibles(db: AquillaDb): Promise<ReferenceBibleSummary[]> {
  const { results } = await db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM reference_bible_versions WHERE ${INSTALLED} ORDER BY language_name, name, id`)
    .all<VersionRow>()
  return results.map(toSummary)
}

/** One installed Bible, or null when the id is unknown or not loaded. */
export async function getReferenceBible(db: AquillaDb, id: string): Promise<ReferenceBibleSummary | null> {
  const row = await db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM reference_bible_versions WHERE id = ? AND ${INSTALLED}`)
    .bind(id)
    .first<VersionRow>()
  return row ? toSummary(row) : null
}

/** Position of (chapter, verse) inside a ref's range, for ordering and membership. */
function inRef(ref: ScriptureRef, chapter: number, verse: number): boolean {
  const afterStart = chapter > ref.chapter || (chapter === ref.chapter && verse >= ref.verseStart)
  const beforeEnd = chapter < ref.endChapter || (chapter === ref.endChapter && verse <= ref.verseEnd)
  return afterStart && beforeEnd
}

/**
 * The verses of each reference in one Bible. `refs` are canonical strings
 * ("ISA 40:25") or parsed refs; duplicates are returned once. A reference with
 * no verses in this Bible (Isaiah 40:99, a book it lacks) is listed in
 * `unresolved`; a malformed canonical string is too. Each passage holds at
 * most MAX_VERSES_PER_REFERENCE verses and says when it was cut.
 */
export async function lookupPassages(
  db: AquillaDb,
  versionId: string,
  refs: readonly (string | ScriptureRef)[],
): Promise<{ passages: ReferencePassage[]; unresolved: string[] }> {
  const unresolved: string[] = []
  const wanted: { canonical: string; ref: ScriptureRef }[] = []
  const seen = new Set<string>()
  for (const r of refs) {
    const ref = typeof r === "string" ? parseCanonicalRef(r) : r
    if (!ref) {
      if (typeof r === "string") unresolved.push(r)
      continue
    }
    const canonical = typeof r === "string" ? r.trim() : formatCanonical(ref)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    wanted.push({ canonical, ref })
  }

  const passages: ReferencePassage[] = []
  for (let i = 0; i < wanted.length; i += REFS_PER_QUERY) {
    const chunk = wanted.slice(i, i + REFS_PER_QUERY)
    const clauses: string[] = []
    const params: unknown[] = [versionId]
    for (const { ref } of chunk) {
      const endChapter = Math.min(ref.endChapter, ref.chapter + MAX_CHAPTER_SPAN)
      const verseEnd = endChapter === ref.endChapter ? ref.verseEnd : 999
      clauses.push(
        "(book = ? AND (chapter > ? OR (chapter = ? AND verse >= ?)) AND (chapter < ? OR (chapter = ? AND verse <= ?)))",
      )
      params.push(ref.book, ref.chapter, ref.chapter, ref.verseStart, endChapter, endChapter, verseEnd)
    }
    const { results } = await db
      .prepare(
        `SELECT book, chapter, verse, text FROM reference_bible_verses
          WHERE version_id = ? AND (${clauses.join(" OR ")})
          ORDER BY book, chapter, verse`,
      )
      .bind(...params)
      .all<{ book: string; chapter: number; verse: number; text: string }>()
    for (const { canonical, ref } of chunk) {
      const rows = results.filter((row) => row.book === ref.book && inRef(ref, Number(row.chapter), Number(row.verse)))
      if (rows.length === 0) {
        unresolved.push(canonical)
        continue
      }
      const truncated = rows.length > MAX_VERSES_PER_REFERENCE || ref.endChapter > ref.chapter + MAX_CHAPTER_SPAN
      passages.push({
        canonical,
        label: formatLabel(ref),
        verses: rows.slice(0, MAX_VERSES_PER_REFERENCE).map((row) => ({
          chapter: Number(row.chapter),
          verse: Number(row.verse),
          text: row.text,
        })),
        ...(truncated ? { truncated: true } : {}),
      })
    }
  }
  return { passages, unresolved }
}

/** Mark as truncated the passages whose reference the finder cut short. */
export function markCut<P extends { canonical: string; truncated?: boolean }>(passages: readonly P[], cut: ReadonlySet<string>): P[] {
  return passages.map((p) => (cut.has(p.canonical) && !p.truncated ? { ...p, truncated: true } : p))
}

export interface SourcePassages {
  /** The lane's Bible, or null when the setting names one that is not installed. */
  version: ReferenceBibleSummary | null
  passages: ReferencePassage[]
  /** Cited references this Bible has no verses for. */
  unresolved: string[]
  /** Set when the lane's setting names a Bible that is not installed. */
  missingVersionId?: string
}

/**
 * The verses the given source texts cite, from the Bible `lane` quotes from.
 * Null when the lane has no reference Bible — the caller then adds nothing.
 * Sources are scanned in order; references are de-duplicated across them and
 * capped at MAX_REFERENCES_PER_LOOKUP.
 */
export async function loadReferencePassagesForSources(
  db: AquillaDb,
  input: { settings: ReferenceBibleSettings | null | undefined; lane: string | null | undefined; sources: readonly string[] },
): Promise<SourcePassages | null> {
  const versionId = referenceBibleForLane(input.settings, input.lane)
  if (!versionId) return null
  const version = await getReferenceBible(db, versionId)
  if (!version) return { version: null, passages: [], unresolved: [], missingVersionId: versionId }
  const canonicals: string[] = []
  const seen = new Set<string>()
  // A long range the finder already cut to its first verses ("Psalm 119:1-176"
  // → PSA 119:1-30): the lookup sees a complete 30-verse range, so the cut is
  // carried over here for the block's "the rest is not shown" note.
  const cut = new Set<string>()
  for (const source of input.sources) {
    for (const f of findScriptureReferences(source ?? "")) {
      if (f.truncated) cut.add(f.canonical)
      if (seen.has(f.canonical) || canonicals.length >= MAX_REFERENCES_PER_LOOKUP) continue
      seen.add(f.canonical)
      canonicals.push(f.canonical)
    }
  }
  if (canonicals.length === 0) return { version, passages: [], unresolved: [] }
  const { passages, unresolved } = await lookupPassages(db, version.id, canonicals)
  return { version, passages: markCut(passages, cut), unresolved }
}

export type ReferenceBibleSettingCheck = { ok: true } | { ok: false; message: string }

/**
 * Validate a `referenceBibleVersions` value against what is installed and the
 * project's lanes, as the settings will be AFTER the write (`merged`). Null
 * (clear) is always fine. Used by PatchSettings and ProjectSetup.
 */
export async function validateReferenceBibleSetting(
  db: AquillaDb,
  value: unknown,
  merged: { targetLanguage?: unknown; targetLanes?: unknown } | null | undefined,
): Promise<ReferenceBibleSettingCheck> {
  if (value === null || value === undefined) return { ok: true }
  const shape = referenceBibleSettingShapeProblem(value)
  if (shape) return { ok: false, message: `referenceBibleVersions: ${shape}` }
  const map = parseReferenceBibleSetting(value) ?? {}
  const entries = Object.entries(map)
  if (entries.length === 0) return { ok: true }

  const installed = await listReferenceBibles(db)
  const installedIds = new Set(installed.map((v) => v.id))
  const unknownIds = [...new Set(entries.map(([, id]) => id).filter((id) => !installedIds.has(id)))]
  if (unknownIds.length > 0) {
    const have = installed.length > 0 ? installed.map((v) => v.id).join(", ") : "none installed"
    return {
      ok: false,
      message:
        `referenceBibleVersions: unknown Bible ${unknownIds.map((id) => `"${id}"`).join(", ")}. ` +
        `Installed: ${have}. Call list_reference_bibles (GET /api/v1/external/reference-bibles) for the list.`,
    }
  }

  const targetLanguage = typeof merged?.targetLanguage === "string" ? merged.targetLanguage : null
  const targetLanes = Array.isArray(merged?.targetLanes)
    ? (merged.targetLanes as unknown[]).filter((t): t is string => typeof t === "string")
    : []
  const extras = extraRegistryLanes(targetLanes, targetLanguage).map((t) => t.trim())
  const laneOf = (key: string): string | null => {
    const canonical = canonicalLaneId(key, targetLanguage)
    if (canonical === "") return ""
    const extra = extras.find((t) => t.toLowerCase() === key.toLowerCase())
    return extra ?? null
  }
  const lanesSeen = new Map<string, string>()
  for (const [key] of entries) {
    const lane = laneOf(key)
    if (lane === null) {
      const known = [`"" (${targetLanguage || "the default lane"})`, ...extras.map((t) => `"${t}"`)].join(", ")
      return {
        ok: false,
        message: `referenceBibleVersions: "${key}" is not a lane of this project. Lanes: ${known}.`,
      }
    }
    const earlier = lanesSeen.get(lane)
    if (earlier !== undefined) {
      return {
        ok: false,
        message: `referenceBibleVersions: "${earlier}" and "${key}" name the same lane — keep one Bible per lane.`,
      }
    }
    lanesSeen.set(lane, key)
  }
  return { ok: true }
}
