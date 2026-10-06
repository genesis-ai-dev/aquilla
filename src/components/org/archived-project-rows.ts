import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import type { OrgProjectRow } from "./OrgProjectsDataTable"

/**
 * AQU-1070: archived projects as rows for the ordinary projects list.
 *
 * PMs asked to be able to see archived projects *in place* — greyed out, beside
 * the live ones — rather than only on the separate Archived page, so a partner
 * reviewing their active-language band can tell at a glance which languages were
 * stood down and which were never there.
 *
 * The archived list endpoint returns `CloudProjectSummary`, which carries no
 * portfolio rollups (the projection only aggregates live projects). So an
 * archived row reports zeroes for progress and a null last-edit rather than
 * pretending to numbers we don't have — the greyed row plus the "Archived"
 * status chip is what carries the meaning.
 */
export function toArchivedProjectRow(
  project: CloudProjectSummary,
  fallbackOrgName?: string | null,
): OrgProjectRow {
  const files = project.files ?? []
  return {
    id: project.id,
    name: project.name,
    totalCells: 0,
    validatedCells: 0,
    filledCells: 0,
    aiDraftedCells: 0,
    lastEditAt: null,
    audioCells: 0,
    validatedAudioCells: 0,
    recordedMs: 0,
    deadlineAt: null,
    sourceLanguage: files.find((f) => f.sourceLanguage)?.sourceLanguage ?? null,
    targetLanguage: files.find((f) => f.targetLanguage)?.targetLanguage ?? null,
    pm: project.pm ?? null,
    orgId: project.orgId ?? undefined,
    orgName: project.orgName ?? fallbackOrgName ?? null,
    archivedAt: project.archivedAt ?? null,
  }
}

/**
 * Append archived rows to the live list, skipping any id already present.
 *
 * The two lists come from separate requests, so they can briefly disagree — a
 * project restored in another tab shows up in both. The live row wins, because
 * it is the one carrying real rollups; a stale archived duplicate would
 * otherwise render the same project twice, once greyed.
 */
export function withArchivedProjects(
  live: readonly OrgProjectRow[],
  archived: readonly OrgProjectRow[],
): OrgProjectRow[] {
  if (archived.length === 0) return [...live]
  const seen = new Set(live.map((p) => p.id))
  return [...live, ...archived.filter((p) => !seen.has(p.id))]
}
