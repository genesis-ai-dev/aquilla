/**
 * The Living Memory page's lane view, as pure functions (AQU-2348).
 *
 * Slices 1–3 gave the storage, the resolver and the writers; this is the half
 * the PAGE needs — "does this lane own the section, and what do I patch to
 * customize, edit or revert it?". It is pure and React-free so the subtle
 * rules below can be pinned by unit tests rather than inferred from a render.
 *
 * TWO SHAPES, and the page must not blur them:
 *
 *   * OVERRIDE sections — the translation brief and the default prediction
 *     prompt. A lane either INHERITS the project's value or OWNS a copy that
 *     replaces it. These get the Customize / Revert control.
 *   * LIST sections — authored entries, knowledge documents and style rules.
 *     A lane never replaces the project's list; it ADDS to it (the union rule
 *     in `resolveLaneEntries` / `laneScopedRows`). There is nothing to revert,
 *     so these get an explanatory note, never a Customize button. Offering
 *     "Revert to project" over a union would promise to restore something that
 *     was never taken away.
 *
 * THE SUBTLE RULE (the one slices 1 and 2 both flagged forward): "is this
 * section customized?" asks whether the lane OWNS the value, NOT whether it
 * reads one. A lane inheriting a project brief reads a brief; it is not
 * customized. `laneOwnsSection` therefore inspects the by-lane map's own keys
 * and never resolves through the fallback — the same distinction
 * `readOwnedBriefForLane` draws for the writers.
 *
 * AND: customizing COPIES what the lane currently resolves to, so a lane that
 * starts owning the brief starts from the project's answers rather than from
 * a blank form. Writing one section for a lane must not silently discard the
 * rest (`commands-set-brief.ts` does the same thing server-side).
 */

import {
  resolveLaneOverride,
  withLaneMemoryValue,
  withoutLaneMemoryValue,
} from "../../../db/shared/lane-memory"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import type { TranslationBrief } from "@/lib/brief/types"

/** The two sections a lane can own outright. */
export type LaneOverrideSectionId = "brief" | "systemPrompt"

/** Which settings key pair backs each override section. */
const SECTION_KEYS = {
  brief: { project: "translationBrief", byLane: "translationBriefByLane" },
  systemPrompt: { project: "systemPrompt", byLane: "systemPromptByLane" },
} as const satisfies Record<LaneOverrideSectionId, { project: keyof ProjectWideSettings; byLane: keyof ProjectWideSettings }>

type SectionValue<S extends LaneOverrideSectionId> = S extends "brief" ? TranslationBrief : string

function byLaneMap<S extends LaneOverrideSectionId>(
  settings: ProjectWideSettings | null | undefined,
  section: S,
): Record<string, SectionValue<S>> | undefined {
  return settings?.[SECTION_KEYS[section].byLane] as Record<string, SectionValue<S>> | undefined
}

function projectValue<S extends LaneOverrideSectionId>(
  settings: ProjectWideSettings | null | undefined,
  section: S,
): SectionValue<S> | undefined {
  return settings?.[SECTION_KEYS[section].project] as SectionValue<S> | undefined
}

/**
 * Does `laneId` OWN this section — not merely read one?
 *
 * `laneId === undefined` is the project-wide view, which owns nothing by
 * definition. An own-key check, never a resolve: a lane inheriting the
 * project's brief reads a brief and is still inherited, and a lane whose
 * stored value is empty IS customized ("this lane deliberately has none"),
 * which is why `hasOwnProperty` is the test rather than truthiness.
 */
export function laneOwnsSection(
  settings: ProjectWideSettings | null | undefined,
  laneId: string | undefined,
  section: LaneOverrideSectionId,
): boolean {
  if (laneId === undefined) return false
  const map = byLaneMap(settings, section)
  return Boolean(map && Object.prototype.hasOwnProperty.call(map, laneId))
}

/** The value in force for `laneId` — the lane's copy, else the project's. */
export function laneSectionValue<S extends LaneOverrideSectionId>(
  settings: ProjectWideSettings | null | undefined,
  laneId: string | undefined,
  section: S,
): SectionValue<S> | undefined {
  return resolveLaneOverride(projectValue(settings, section), byLaneMap(settings, section), laneId).value
}

/**
 * The patch for "Customize for this lane": the lane starts owning a COPY of
 * what it currently resolves to.
 *
 * A lane whose project value is absent starts owning `undefined`, which still
 * records ownership — the by-lane map gains the key — so the section reads as
 * customized and Revert has something to remove. Without that, customizing an
 * empty project brief would appear to do nothing.
 */
export function customizeSectionPatch<S extends LaneOverrideSectionId>(
  settings: ProjectWideSettings | null | undefined,
  laneId: string,
  section: S,
): ProjectWideSettings {
  const current = laneSectionValue(settings, laneId, section)
  const next = withLaneMemoryValue(
    byLaneMap(settings, section),
    laneId,
    current as SectionValue<S>,
  )
  return { [SECTION_KEYS[section].byLane]: next } as ProjectWideSettings
}

/**
 * The patch for "Revert to project": the lane's copy is removed and the lane
 * reads the project value again. `withoutLaneMemoryValue` returns undefined
 * when that was the last entry, so the key is cleared rather than left as an
 * empty map accumulating on every project that ever tried an override.
 */
export function revertSectionPatch(
  settings: ProjectWideSettings | null | undefined,
  laneId: string,
  section: LaneOverrideSectionId,
): ProjectWideSettings {
  const next = withoutLaneMemoryValue(byLaneMap(settings, section), laneId)
  return { [SECTION_KEYS[section].byLane]: next } as ProjectWideSettings
}

/**
 * Redirect an ordinary section write into the lane's copy when the lane owns
 * it, leaving the project-wide write untouched otherwise.
 *
 * This is what lets `BriefPane` and `PredictionPromptSection` stay unchanged:
 * they keep patching `translationBrief` / `systemPrompt`, and the page rewrites
 * the destination. An edit made while viewing a lane that owns the section must
 * never land on the project's value — that is exactly the leak criterion #3
 * forbids.
 */
export function laneSectionWritePatch<S extends LaneOverrideSectionId>(
  settings: ProjectWideSettings | null | undefined,
  laneId: string | undefined,
  section: S,
  value: SectionValue<S>,
): ProjectWideSettings {
  if (laneId === undefined || !laneOwnsSection(settings, laneId, section)) {
    return { [SECTION_KEYS[section].project]: value } as ProjectWideSettings
  }
  return {
    [SECTION_KEYS[section].byLane]: withLaneMemoryValue(byLaneMap(settings, section), laneId, value),
  } as ProjectWideSettings
}

/**
 * Stamp the viewed lane on a NEW row (a style rule, a knowledge document)
 * created while the page is scoped to one lane.
 *
 * An input that already names a lane wins, so a per-row lane chooser can be
 * added later without touching the call sites. `laneId === undefined` — the
 * project-wide view and every single-lane project — returns the input
 * untouched, so the request is byte-identical to what it was before a lane
 * could own a row, and the row lands project-wide and in force everywhere.
 *
 * Only CREATION is stamped. The management lists stay unnarrowed on purpose:
 * a maintainer has to be able to see what the other lane is held to.
 */
export function stampLaneOnNewRow<T extends { laneId?: string | null }>(
  input: T,
  laneId: string | undefined,
): T {
  if (laneId === undefined || input.laneId !== undefined) return input
  return { ...input, laneId }
}
