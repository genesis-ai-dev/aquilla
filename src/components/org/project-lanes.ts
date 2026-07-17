// AQU-538 §3.2 — org "Language Grid" helpers shared by the OrgHome project
// tables (OrgProjectsDataTable + ProjectTable) and their lane sub-components.
//
// The chips/sub-rows are driven by `PortfolioProject.lanes` (per-target-lang
// progress rollups, '' = default lane). When the server didn't send a lane
// breakdown (older server, or a project with no file-scope progress yet) we
// synthesize a single default lane from the scalar counts so a single-lane
// project renders exactly one chip — visual parity with the pre-lane table.

import type { PortfolioLane, PortfolioProject } from "@/lib/frontier/portfolio"

/**
 * Display lanes for a project: the default ('') lane is always first, followed
 * by any extra named lanes in server order. Falls back to a single synthesized
 * default lane (from the project's scalar totals) when no lane breakdown exists.
 */
export function displayLanes(p: PortfolioProject): PortfolioLane[] {
  const synthesizedDefault: PortfolioLane = {
    lane: "",
    totalCells: p.totalCells,
    filledCells: p.filledCells,
    validatedCells: p.validatedCells,
    lastEditAt: p.lastEditAt,
  }
  if (!p.lanes || p.lanes.length === 0) return [synthesizedDefault]
  const defaults = p.lanes.filter((l) => l.lane === "")
  const rest = p.lanes.filter((l) => l.lane !== "")
  const defaultLane = defaults.length > 0 ? defaults[0] : synthesizedDefault
  return [defaultLane, ...rest]
}

/** Human label for a lane chip: the '' lane shows the project's default target
 * language (or a generic "Default" when unknown); named lanes show their tag. */
export function laneChipLabel(lane: string, defaultLaneLabel: string): string {
  if (lane) return lane
  return defaultLaneLabel.trim() || "Default"
}

/**
 * AQU-606: resolve the display label for a project's default ('') lane. Prefer
 * the project's configured `targetLanguage` (AQU-523) — it comes from project
 * settings and therefore survives the lanes migration even when the per-file
 * language hints are absent, so a migrated project whose target is e.g. French
 * reads "French" rather than the placeholder "default". Fall back to the
 * per-file hint (the first file that carries a target language), then to '' so
 * {@link laneChipLabel} renders its generic placeholder instead of a literal
 * lane label.
 */
export function resolveDefaultLaneLabel(
  project: { targetLanguage?: string | null },
  fileTargetHint?: string,
): string {
  return project.targetLanguage?.trim() || fileTargetHint?.trim() || ""
}

/** A 0..100 integer percentage guarded against NaN (missing counts). */
export function safePct(fraction: number): number {
  return Number.isFinite(fraction) ? Math.round(fraction * 100) : 0
}
