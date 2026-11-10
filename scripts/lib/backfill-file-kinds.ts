// AQU-2211: the pure half of scripts/neon-backfill-file-kinds.ts — what to
// write for one `files` row given the Codex notebooks behind it — kept apart
// from the GitLab and Postgres plumbing so it can be unit-tested.
import type { CodexNotebookFile } from "../../src/lib/codex-editor/types"
import { isIdmlPair } from "../../src/lib/migrate/idml"
import {
  legacyCodexFileMeta,
  legacyFileTypeFor,
  type LegacyCodexFileMeta,
  type LegacyFileType,
} from "../../src/lib/migrate/file-type"

/** A `files` row the backfill may touch: `kind = 'codex'`, by construction. */
export interface CodexFileRow {
  id: string
  project_id: string
  name: string
  meta: string | null
}

export type FileKindDecision =
  /** The notebook resolves to an Aquilla type: `kind` changes, `meta` gains `legacyCodex`. */
  | { action: "retype"; kind: LegacyFileType; meta: string; legacy: LegacyCodexFileMeta }
  /** Stays `codex`, but the origin facts are recorded so nothing is lost. */
  | { action: "annotate"; meta: string; legacy: LegacyCodexFileMeta; reason: string }
  /** Nothing to write. */
  | { action: "skip"; reason: string }

function parseMeta(meta: string | null): Record<string, unknown> {
  if (!meta) return {}
  try {
    const parsed: unknown = JSON.parse(meta)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** `files.meta` with `legacyCodex` set, every other key untouched. */
export function metaWithLegacyCodex(meta: string | null, legacy: LegacyCodexFileMeta): string {
  return JSON.stringify({ ...parseMeta(meta), legacyCodex: legacy })
}

function alreadyRecorded(meta: string | null, legacy: LegacyCodexFileMeta): boolean {
  const current = parseMeta(meta).legacyCodex
  return JSON.stringify(current) === JSON.stringify(legacy)
}

/**
 * The one rule, shared with the migrator through file-type.ts. An IDML
 * notebook is never retyped here: the IDML path needs the original bytes and
 * an assessment the migrator runs, so such a row is for a re-migration, not
 * a column update.
 */
export function decideFileKind(
  row: CodexFileRow,
  pair: { source?: CodexNotebookFile; target?: CodexNotebookFile },
): FileKindDecision {
  if (!pair.source && !pair.target) return { action: "skip", reason: "no notebook on GitLab" }
  const legacy = legacyCodexFileMeta(pair)
  if (isIdmlPair(pair)) return { action: "skip", reason: "IDML notebook — re-migrate instead" }
  const kind = legacy ? legacyFileTypeFor(legacy) : undefined
  if (kind && legacy) {
    return { action: "retype", kind, meta: metaWithLegacyCodex(row.meta, legacy), legacy }
  }
  if (!legacy) return { action: "skip", reason: "notebook records no importer and no name" }
  if (alreadyRecorded(row.meta, legacy)) return { action: "skip", reason: "stays codex, already recorded" }
  const reason = legacy.importerType
    ? `importer "${legacy.importerType}" has no Aquilla type`
    : "no importer and no usable file name"
  return { action: "annotate", meta: metaWithLegacyCodex(row.meta, legacy), legacy, reason }
}

/** Per-outcome tallies for the before/after report. */
export function tallyDecisions(decisions: readonly FileKindDecision[]): Map<string, number> {
  const tally = new Map<string, number>()
  const bump = (key: string) => tally.set(key, (tally.get(key) ?? 0) + 1)
  for (const d of decisions) {
    if (d.action === "retype") bump(`codex -> ${d.kind}`)
    else if (d.action === "annotate") bump(`stays codex (${d.reason})`)
    else bump(`untouched (${d.reason})`)
  }
  return new Map([...tally].sort(([a], [b]) => a.localeCompare(b)))
}
