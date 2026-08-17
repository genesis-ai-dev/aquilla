import type { BriefField } from "./types"

/** Max L1 length in characters (~250 words). Enforced at generation so the
 *  always-injected summary cannot blow the per-completion token budget. */
export const L1_MAX_CHARS = 1600

/**
 * The code-owned interview schema. Order is the interview order. Field ids are
 * stable storage keys (never rename — they key TranslationBrief.parameters).
 * Group A = skopos/Nord purpose dimensions; Group B = Paratext project standards.
 */
export const BRIEF_FIELDS: BriefField[] = [
  {
    id: "purpose",
    labelKey: "agent.brief.field.purpose.label",
    group: "purpose",
    helperTextKey: "agent.brief.field.purpose.helperText",
  },
  {
    id: "audience",
    labelKey: "agent.brief.field.audience.label",
    group: "purpose",
    helperTextKey: "agent.brief.field.audience.helperText",
  },
  {
    id: "useAndMedium",
    labelKey: "agent.brief.field.useAndMedium.label",
    group: "purpose",
    helperTextKey: "agent.brief.field.useAndMedium.helperText",
  },
  {
    id: "motiveSponsor",
    labelKey: "agent.brief.field.motiveSponsor.label",
    group: "purpose",
    helperTextKey: "agent.brief.field.motiveSponsor.helperText",
  },
  {
    id: "sourceTexts",
    labelKey: "agent.brief.field.sourceTexts.label",
    group: "standards",
    helperTextKey: "agent.brief.field.sourceTexts.helperText",
  },
  {
    id: "targetVariety",
    labelKey: "agent.brief.field.targetVariety.label",
    group: "standards",
    helperTextKey: "agent.brief.field.targetVariety.helperText",
  },
  {
    id: "registerNaturalness",
    labelKey: "agent.brief.field.registerNaturalness.label",
    group: "standards",
    helperTextKey: "agent.brief.field.registerNaturalness.helperText",
  },
  {
    id: "literalness",
    labelKey: "agent.brief.field.literalness.label",
    group: "standards",
    helperTextKey: "agent.brief.field.literalness.helperText",
  },
  {
    id: "keyTerms",
    labelKey: "agent.brief.field.keyTerms.label",
    group: "standards",
    helperTextKey: "agent.brief.field.keyTerms.helperText",
  },
  {
    id: "constraints",
    labelKey: "agent.brief.field.constraints.label",
    group: "standards",
    helperTextKey: "agent.brief.field.constraints.helperText",
  },
  {
    id: "qualityBar",
    labelKey: "agent.brief.field.qualityBar.label",
    group: "standards",
    helperTextKey: "agent.brief.field.qualityBar.helperText",
  },
]
