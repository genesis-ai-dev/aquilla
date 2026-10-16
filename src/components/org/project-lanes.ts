// AQU-538 §3.2 — org "Language Grid" helpers shared by the OrgHome project
// tables (OrgProjectsDataTable + ProjectTable) and their lane sub-components.
//
// The chips/sub-rows are driven by `PortfolioProject.lanes` (per-target-lang
// progress rollups, '' = default lane). When the server didn't send a lane
// breakdown (older server, or a project with no file-scope progress yet) we
// synthesize a single default lane from the scalar counts so a single-lane
// project renders exactly one chip — visual parity with the pre-lane table.

import type { PortfolioLane, PortfolioProject } from "@/lib/frontier/portfolio"
import { progressPercentOfFraction } from "@/lib/progress/progress-percent"
import type { AssignLaneOption } from "@/lib/sync/assignment-lane"

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
  // AQU-1977: archived languages are not live work. The overview's own lane
  // tabs and Languages table already leave them out (AQU-1458); here they were
  // chips and Assign options like any other.
  const lanes = (p.lanes ?? []).filter((lane) => lane.role !== "source" && lane.archived !== true)
  if (lanes.length === 0) return [synthesizedDefault]
  // Every target row stays, including two that share a tag. The server orders them.
  return lanes
}

/** Human label for a lane chip: the '' lane shows the project's default target
 * language (or the neutral `fallbackLabel` when no target is set); named lanes
 * show their tag. `fallbackLabel` is the localized "no target set" placeholder
 * (`org.projectOverview.laneDefaultFallback`) — callers with a `t` should pass
 * it so non-English UIs don't leak the English literal. */
export function laneChipLabel(
  lane: string,
  defaultLaneLabel: string,
  fallbackLabel = "Default",
  name?: string | null,
): string {
  const named = name?.trim()
  if (named) return named
  if (lane) return lane
  return defaultLaneLabel.trim() || fallbackLabel
}

/**
 * AQU-606 — resolve the label for a project's '' (default) lane.
 *
 * The label comes off the lane: a project's target language lives on **project
 * settings** (surfaced as `PortfolioProject.targetLanguage`, AQU-523), and
 * after AQU-1419 on the lane row itself. `''` when there is none, so the caller
 * renders the neutral "no target set" placeholder.
 *
 * AQU-1596: this used to fall back to a per-file `targetLanguage` hint. A file
 * only ever *declared* a language — a Macula file declares the corpus code
 * `hbo`, and a translation imported into the French lane may declare Spanish —
 * so that fallback could label a lane with a language the lane does not have.
 * A missing label is better than a wrong one; the declared value stays on the
 * file as import information and is never read as a lane's language.
 */
export function resolveDefaultLaneLabel(
  project: Pick<PortfolioProject, "targetLanguage" | "lanes">,
): string {
  // AQU-1977: the '' lane's own row name first. The portfolio stopped sending
  // the retired project-level `targetLanguage`, so on its own this read '' for
  // every project and the lane showed as "Default language".
  const row = project.lanes?.find((lane) => lane.role !== "source" && lane.lane === "")
  return row?.name?.trim() || project.targetLanguage?.trim() || ""
}

/**
 * AQU-1977: what an Assign launched from the org table offers — the project's
 * own live languages, in the table's order, labelled as their chips are. No
 * invented default: on a project with no '' lane, an assignment saved into ''
 * belongs to no lane and its progress reads 0.
 */
export function assignLaneOptionsForPortfolio(
  p: PortfolioProject,
  fallbackLabel: string,
): AssignLaneOption[] {
  const defaultLabel = resolveDefaultLaneLabel(p)
  return displayLanes(p).map((lane) => ({
    legacyTag: lane.lane,
    label: laneChipLabel(lane.lane, defaultLabel, fallbackLabel, lane.name),
  }))
}

/**
 * A 0..100 integer percentage guarded against NaN (missing counts), and never
 * 100 while a cell in the lane is outstanding (AQU-1493).
 */
export function safePct(fraction: number): number {
  return progressPercentOfFraction(fraction)
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
