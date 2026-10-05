import type { ProjectRecord } from "@/lib/parsers/types"
import { buildCompletionSettings } from "@/hooks/useCompletionSettings"
import type { ProjectWideSettings, ProjectLaneView } from "@/lib/sync/project-settings"

/**
 * Overlay synced project-wide settings onto the server-returned ProjectRecord.
 * Mutates a shallow copy — never the input.
 */
export function overlaySettings(
  record: ProjectRecord,
  settings: ProjectWideSettings,
  lanes?: ProjectLaneView[] | null,
): ProjectRecord {
  let next: ProjectRecord | null = null
  const draft = () => {
    next ??= { ...record }
    return next
  }
  const assign = <K extends keyof ProjectRecord>(key: K, value: ProjectRecord[K] | null | undefined) => {
    if (value == null) return
    if (record[key] === value) return
    draft()[key] = value
  }
  assign("sourceLanguage", settings.sourceLanguage)
  assign("targetLanguage", settings.targetLanguage)
  // AQU-538: the lane registry must reach the workspace or the LaneSwitcher
  // never renders (found by the add-target-language e2e journey).
  assign("targetLanes", settings.targetLanes)
  // AQU-601: archived-lane markers overlay alongside the registry so the
  // workspace switcher can hide archived lanes by default.
  assign("archivedLanes", settings.archivedLanes)
  if (lanes) {
    draft().lanes = lanes
  }
  if (settings.systemPrompt != null) {
    if (record.completionSettings?.systemPrompt !== settings.systemPrompt) {
      draft().completionSettings = buildCompletionSettings(
        record.completionSettings,
        { systemPrompt: settings.systemPrompt },
      )
    }
  }
  assign("rules", settings.rules)
  assign("rulePenalties", settings.rulePenalties)
  assign("algorithmicChecks", settings.algorithmicChecks)
  assign("terminology", settings.terminology)
  assign("termMatching", settings.termMatching)
  assign("fileGenres", settings.fileGenres)
  // AQU-207: confirmed/invalidated interlinear alignments. Must reach the
  // workspace or the glosser and the alignment panel both read an empty list:
  // a confirmation then persisted server-side but never fed the BT, never
  // rendered as decided, and the next PATCH replaced the array instead of
  // extending it (the panel's dedupe reads this same field).
  assign("alignmentSeeds", settings.alignmentSeeds)
  assign("livingMemoryEntries", settings.livingMemoryEntries)
  assign("translationBrief", settings.translationBrief)
  assign("validationCount", settings.validationCount)
  assign("validationCountAudio", settings.validationCountAudio)
  assign("validationRoleFloor", settings.validationRoleFloor)
  assign("validationNamedUsers", settings.validationNamedUsers)
  assign("allowSelfValidation", settings.allowSelfValidation)
  // AQU-490: the audio policy. Must reach the workspace or the gutter control
  // would apply the TEXT project's rules to recordings — the one thing Sam's
  // "separate settings" ruling exists to prevent.
  assign("validationRoleFloorAudio", settings.validationRoleFloorAudio)
  assign("validationNamedUsersAudio", settings.validationNamedUsersAudio)
  assign("allowSelfValidationAudio", settings.allowSelfValidationAudio)
  assign("cellEditingFloor", settings.cellEditingFloor)
  // AQU-646 stage 2: the second gate on track editing. Must reach the workspace
  // or the add-track button and the colour menu would be invisible everywhere,
  // since they render only when this is on.
  assign("allowTrackEditing", settings.allowTrackEditing)
  // AQU-1246: the Autopilot opt-in. Must reach the workspace and the project
  // overview or the gate reads false everywhere and an opted-in project would
  // see no Autopilot at all — the surfaces render only when this is on (or the
  // legacy device-local flag was already stored true).
  assign("autopilotEnabled", settings.autopilotEnabled)
  assign("bibleResourcesEnabled", settings.bibleResourcesEnabled)
  assign("draftContext", settings.draftContext)
  // AQU-646 SUB-53: the Media lens reads this to decide whether to draw the
  // timeline against the imported file's clock or lay the verses out end to end.
  assign("audioTimingMode", settings.audioTimingMode)
  // AQU-646: the timeline lock. Must reach the workspace or the chips would be
  // draggable for everyone until someone opened Project Settings.
  assign("timingLocked", settings.timingLocked)
  // AQU-634: USFM front-matter opt-out must reach the workspace so ImportDialog
  // and the target-import panel drop front matter when it's on.
  assign("importExcludeFrontMatter", settings.importExcludeFrontMatter)
  assign("harmonize_min_role", settings.harmonize_min_role)
  // Smart quotes must reach the workspace, where the cell editor reads it.
  assign("smartQuotes", settings.smartQuotes)
  if (settings.ttsSettings != null) {
    // Server carries voice profiles (no apiKey); keep any device-local apiKey.
    const merged = { ...record.ttsSettings, ...settings.ttsSettings }
    if (JSON.stringify(record.ttsSettings ?? {}) !== JSON.stringify(merged)) {
      draft().ttsSettings = merged
    }
  }
  return next ?? record
}
