/**
 * Each setting's name in an Undo step, "Change: <name>". (AQU-2262)
 *
 * The names are the settings' own labels on the page, so the History panel
 * says what the person saw. Keyed by where the value lives: a shared settings
 * key, a field of the drafting settings, or a setting kept on this device.
 */
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { DeviceSettingKey } from "./useSettingsStepKinds"

export const SHARED_SETTING_LABELS: Record<string, MessageKey> = {
  smartQuotes: "projectSettings.info.smartQuotesLabel",
  cellEditingFloor: "projectSettings.cellEditing.label",
  bibleResourcesEnabled: "bibleData.card.title",
  bibleEnrichments: "bibleData.card.title",
  importExcludeFrontMatter: "projectSettings.import.excludeFrontMatterLabel",
  importCellUnit: "projectSettings.import.cellUnitLabel",
  validationCount: "projectSettings.validation.requiredTextLabel",
  validationRoleFloor: "projectSettings.validation.minRoleLabel",
  allowSelfValidation: "projectSettings.validation.allowSelfLabel",
  validationNamedUsers: "projectSettings.validation.namedValidatorsLabel",
  validationCountAudio: "projectSettings.validation.requiredAudioLabel",
  validationRoleFloorAudio: "projectSettings.validation.minRoleAudioLabel",
  allowSelfValidationAudio: "projectSettings.validation.allowSelfAudioLabel",
  validationNamedUsersAudio: "projectSettings.validation.namedValidatorsAudioLabel",
  harmonize_min_role: "projectSettings.harmonization.minRoleLabel",
  timingLocked: "projectSettings.timeline.lockLabel",
  allowTrackEditing: "projectSettings.timeline.trackEditingLabel",
  // AQU-1758: dev's Film and sources setting, beside track editing.
  filmAndSources: "projectSettings.timeline.filmAndSourcesLabel",
  draftContext: "projectSettings.draftContext.precedingCellsLabel",
  termMatching: "projectSettings.termMatching.title",
  projectLeadsManageVoices: "projectSettings.voice.leadsManageLabel",
  countStructuralCells: "projectSettings.structuralCells.label",
  autoPropagateRepetitions: "projectSettings.autoPropagateRepetitions.label",
  rosterViewMinRole: "projectSettings.visibility.rosterLabel",
  memberProgressViewMinRole: "projectSettings.visibility.progressLabel",
  autopilotEnabled: "autopilot.settings.autopilotLabel",
  smartExtensionsEnabled: "extensions.flag.label",
  languageProfile: "bibleData.profile.title",
  projectFacts: "projectDecisions.title",
  inheritedFromLink: "projectSettings.section.sourceLink",
}

/** A setting's name, or the page's own name when it has none listed. */
export function sharedSettingLabel(key: string): MessageKey {
  return SHARED_SETTING_LABELS[key] ?? "projectSettings.pageTitle"
}

export const DRAFTING_FIELD_LABELS = {
  provider: "projectSettings.advancedLlm.providerLabel",
  endpoint: "projectSettings.advancedLlm.endpointLabel",
  model: "projectSettings.advancedLlm.modelLabel",
  maxTokens: "projectSettings.advancedLlm.maxTokensLabel",
  temperature: "projectSettings.advancedLlm.temperatureName",
  top_k: "projectSettings.ai.topKLabel",
  contextSize: "projectSettings.ai.contextWindowLabel",
  main_chat_language: "projectSettings.ai.assistantLanguageName",
  fewShotExampleFormat: "projectSettings.ai.referenceExampleFormatLabel",
  completionBatchSize: "projectSettings.ai.completionBatchSizeLabel",
  validationBatchSize: "projectSettings.ai.validationBatchSizeLabel",
} as const satisfies Record<string, MessageKey>
export type DraftingField = keyof typeof DRAFTING_FIELD_LABELS

export const DEVICE_SETTING_LABELS: Record<DeviceSettingKey, MessageKey> = {
  audioMediaStrategy: "projectSettings.audioMedia.title",
  syncSettings: "projectSettings.gitSync.autoSyncSwitch",
  decaySettings: "projectSettings.decay.summary",
}
