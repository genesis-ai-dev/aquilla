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
 * language (or the neutral `fallbackLabel` when no target is set); named lanes
 * show their tag. `fallbackLabel` is the localized "no target set" placeholder
 * (`org.projectOverview.laneDefaultFallback`) — callers with a `t` should pass
 * it so non-English UIs don't leak the English literal. */
export function laneChipLabel(lane: string, defaultLaneLabel: string, fallbackLabel = "Default"): string {
  if (lane) return lane
  return defaultLaneLabel.trim() || fallbackLabel
}

/**
 * AQU-606 — resolve the label for a project's '' (default) lane.
 *
 * After the lanes migration a project's target language lives on **project
 * settings** (surfaced as `PortfolioProject.targetLanguage`, AQU-523) while its
 * migrated files carry no per-file `targetLanguage` hint. Deriving the label
 * from the file hint alone therefore left every migrated project's default lane
 * showing the generic "Default" placeholder instead of e.g. "French".
 *
 * Resolution order: the project-level target language, then the per-file hint
 * (which still covers projects whose files were tagged before the migration),
 * then '' so the caller renders the neutral "no target set" placeholder.
 */
export function resolveDefaultLaneLabel(
  project: Pick<PortfolioProject, "targetLanguage">,
  fileHint?: string,
): string {
  return project.targetLanguage?.trim() || fileHint?.trim() || ""
}

/** A 0..100 integer percentage guarded against NaN (missing counts). */
export function safePct(fraction: number): number {
  return Number.isFinite(fraction) ? Math.round(fraction * 100) : 0
}

/**
 * AQU-605 — optimistically append a freshly-registered lane to a project row so
 * the org project table updates that row *in place* (a new chip) instead of the
 * whole table blanking on a portfolio refetch. The new lane starts with empty
 * counts (no progress yet); real rollups arrive on the next natural portfolio
 * load. Idempotent: a case-insensitive duplicate (or a blank tag) returns the
 * project unchanged.
 */
export function withOptimisticLane<T extends PortfolioProject>(p: T, lane: string): T {
  const trimmed = lane.trim()
  if (!trimmed) return p
  // Base off the currently-displayed lanes so the default ('') lane is retained
  // even when the server sent no per-lane breakdown (displayLanes synthesizes it).
  const existing = p.lanes && p.lanes.length > 0 ? p.lanes : displayLanes(p)
  if (existing.some((l) => l.lane.toLowerCase() === trimmed.toLowerCase())) return p
  const added: PortfolioLane = {
    lane: trimmed,
    totalCells: 0,
    filledCells: 0,
    validatedCells: 0,
    lastEditAt: null,
  }
  return { ...p, lanes: [...existing, added] }
}
