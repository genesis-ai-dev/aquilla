import { languagesEqual } from "@/lib/language-normalize"
import { laneLanguage } from "@/lib/lanes/lane-display"
import type { LaneLanguageRow } from "@/lib/lanes/lane-language"

/** A lane row the import dialog can read. `position` orders "the first target". */
export type ImportDirectionLane = LaneLanguageRow & { position?: number }

export interface ImportDirectionInput {
  lanes?: readonly ImportDirectionLane[] | null
  /** Active target tag. `""` is the former default lane, not a language. */
  activeTag?: string
  sourceLanguage?: string
  targetLanguage?: string
  inferred?: { sourceLanguage?: string; targetLanguage?: string } | null
}

export interface ImportDirection {
  source: string
  target: string
  needsDirection: boolean
}

function laneText(lane: ImportDirectionLane | null | undefined): string {
  if (!lane) return ""
  return laneLanguage(lane, {
    role: lane.role,
    legacyTag: lane.legacyTag,
  }).trim()
}

/** The source lane's language. Settings are not read. */
function sourceLanguageFromLanes(lanes: readonly ImportDirectionLane[]): string {
  return laneText(lanes.find((lane) => lane.role === "source"))
}

/**
 * The active target lane's language when that row has one. Otherwise the
 * first target lane (by position) that has one.
 *
 * Tag `""` does not match a target tagged with its language (`fr`). Matching
 * the source lane is also wrong: its `legacyTag` is null, which reads as `""`.
 */
function targetLanguageFromLanes(lanes: readonly ImportDirectionLane[], activeTag: string): string {
  const targets = lanes.filter((lane) => lane.role !== "source")
  const active = targets.find((lane) => (lane.legacyTag ?? "") === activeTag || lane.id === activeTag)
  const activeLanguage = laneText(active)
  if (activeLanguage) return activeLanguage

  const ordered = targets
    .map((lane, index) => ({ lane, index }))
    .sort((a, b) => {
      const ap = a.lane.position
      const bp = b.lane.position
      if (ap != null && bp != null && ap !== bp) return ap - bp
      return a.index - b.index
    })
  for (const { lane } of ordered) {
    const language = laneText(lane)
    if (language) return language
  }
  return ""
}

function filled(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ""
}

/**
 * Whether this import must ask the person to set translation direction.
 *
 * A project that already has a source-lane language and a distinct
 * target-lane language does not. Lane rows decide that. The editor's active
 * tag is often `""`, and resolving only that tag reports no target when the
 * real target lane is tagged `fr`. Inferred languages and the dialog's
 * language props fill a side the lanes have not named.
 */
export function resolveImportDirection(input: ImportDirectionInput): ImportDirection {
  const lanes = input.lanes ?? []
  const source = filled(
    sourceLanguageFromLanes(lanes),
    input.inferred?.sourceLanguage,
    input.sourceLanguage,
  )
  const target = filled(
    targetLanguageFromLanes(lanes, input.activeTag ?? ""),
    input.inferred?.targetLanguage,
    input.targetLanguage,
  )
  const bothEmpty = source === "" && target === ""
  const needsDirection =
    bothEmpty ||
    (source !== "" && (target === "" || languagesEqual(source, target)))
  return { source, target, needsDirection }
}
