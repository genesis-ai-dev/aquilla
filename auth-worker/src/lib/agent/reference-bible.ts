// AQU-1573: the cited verses for the agent's drafting pipeline.
//
// generateDrafts (the in-app agent's draft tool AND the Agent API's
// DraftCells, through routes/ai-draft-internal.ts) reads the lane's reference
// Bible here, so a sermon cell that quotes "Isaiah 40:25" is drafted with the
// Bible's wording instead of a fresh translation. The block itself comes from
// the copilot's builder (src/lib/completion/prompt-build.ts), so the editor,
// the agent and the Agent API prompt preview all show the model the same text.
//
// Best-effort, like the rest of prompt grounding: a missing settings row, a
// Bible that is not installed, or a failed query means no block, never a
// failed draft.

import { loadReferencePassagesForSources, type SourcePassages } from "../../../../db/shared/reference-bible"
import { buildReferenceVersesBlock } from "../../../../src/lib/completion/prompt-build"

/** The project's settings as far as the reference Bible needs them. */
async function loadReferenceSettings(
  db: AquillaDb,
  projectId: string,
): Promise<{ referenceBibleVersions?: unknown; targetLanguage?: unknown } | null> {
  const row = await db
    .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
    .bind(projectId)
    .first<{ settings: unknown }>()
  if (!row?.settings) return null
  const parsed: unknown = typeof row.settings === "string" ? JSON.parse(row.settings) : row.settings
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { referenceBibleVersions?: unknown; targetLanguage?: unknown })
    : null
}

/**
 * The verses `sources` cite, from the Bible `lane` quotes from. Null when the
 * lane has no reference Bible (or the project has no settings yet).
 */
export async function loadLaneReferencePassages(
  db: AquillaDb,
  input: { projectId: string; lane: string; sources: readonly string[] },
): Promise<SourcePassages | null> {
  const settings = await loadReferenceSettings(db, input.projectId)
  if (!settings) return null
  return loadReferencePassagesForSources(db, { settings, lane: input.lane, sources: input.sources })
}

/** The MUST-copy block for a lookup result, or "" when there is nothing to copy. */
export function referenceBlockFromPassages(found: SourcePassages | null): string {
  if (!found?.version || found.passages.length === 0) return ""
  return buildReferenceVersesBlock({
    versionName: found.version.name,
    languageName: found.version.languageName,
    passages: found.passages,
  })
}

/** loadLaneReferencePassages + the block, swallowing failures (drafting goes on without it). */
export async function loadDraftReferenceBlock(
  db: AquillaDb,
  input: { projectId: string; lane: string; sources: readonly string[] },
): Promise<string> {
  try {
    return referenceBlockFromPassages(await loadLaneReferencePassages(db, input))
  } catch (err) {
    console.warn("[agent draft] reference verses lookup failed:", err)
    return ""
  }
}
