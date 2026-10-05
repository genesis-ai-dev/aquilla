// AQU-1573: which rows the Reference Bible card shows and in what order it
// offers the Bibles. Pure, so the card's component file exports only the
// component (fast refresh) and these stay unit-testable on their own.

import { activeLanes } from "@/components/project-lane-archive"
import { extraRegistryLanes } from "@/lib/lanes/registry-lanes"
import { languagesEqual } from "@/lib/language-normalize"
import type { ReferenceBibleSummary } from "@/lib/reference-bible/types"
import type { ProjectLaneView } from "@/lib/sync/project-settings"

export interface LaneRow {
  /** Lane tag as the setting keys it: "" for the default lane. */
  tag: string
  label: string
  /** What the lane's language is, for sorting matching Bibles first. */
  language: string
}

/** Rows for the default lane and every extra lane, archived lanes left out. */
export function referenceBibleLaneRows(
  targetLanguage: string,
  targetLanes: readonly string[],
  archivedLanes: readonly string[] | undefined,
  laneRecords: readonly ProjectLaneView[] | undefined,
): LaneRow[] {
  const targets = (laneRecords ?? []).filter((lane) => lane.role === "target")
  const recordFor = (tag: string) =>
    targets.find((lane) => (lane.legacyTag ?? "").toLowerCase() === tag.toLowerCase())
  const defaultRecord = recordFor("")
  const rows: LaneRow[] = []
  // AQU-1600 lets the default lane be archived like any other. Its archived
  // state lives only on its lane row (the archivedLanes mirror holds tags and
  // cannot name ""), so the row is what hides it here.
  if (!defaultRecord?.archivedAt) {
    rows.push({
      tag: "",
      label: defaultRecord?.name || targetLanguage,
      language: defaultRecord?.langCode || targetLanguage,
    })
  }
  for (const tag of activeLanes(extraRegistryLanes(targetLanes, targetLanguage), archivedLanes)) {
    const record = recordFor(tag)
    if (record?.archivedAt) continue
    rows.push({ tag, label: record?.name || tag, language: record?.langCode || tag })
  }
  return rows
}

/** Bibles in the lane's language first, then the rest, each group in server order. */
export function sortBiblesForLane(
  versions: readonly ReferenceBibleSummary[],
  language: string,
): ReferenceBibleSummary[] {
  const matches = (v: ReferenceBibleSummary) =>
    languagesEqual(v.languageCode, language) || languagesEqual(v.languageName, language)
  return [...versions.filter(matches), ...versions.filter((v) => !matches(v))]
}
