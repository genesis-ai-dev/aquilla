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
    label: "Purpose / skopos",
    group: "purpose",
    helperText:
      "Why this translation exists and its intended function(s): e.g. evangelistic, liturgical, study, devotional, first Scripture in this language, or a revision.",
  },
  {
    id: "audience",
    label: "Audience / addressees",
    group: "purpose",
    helperText:
      "Who will use it — age range, literacy level, churched vs. unchurched, and whether they are bilingual with a language of wider communication.",
  },
  {
    id: "useAndMedium",
    label: "Intended use & medium",
    group: "purpose",
    helperText:
      "How it will be encountered: read aloud, personal study, liturgy, audio/oral, print, or app. The medium shapes sentence length and naturalness.",
  },
  {
    id: "motiveSponsor",
    label: "Motive & sponsor",
    group: "purpose",
    helperText:
      "Who commissioned the work and the denominational or institutional context behind it. Records the brief's 'motive' in skopos terms.",
  },
  {
    id: "sourceTexts",
    label: "Source & base texts",
    group: "standards",
    helperText:
      "The original-language editions and any front/model translations the team works from.",
  },
  {
    id: "targetVariety",
    label: "Target language & variety",
    group: "standards",
    helperText:
      "The specific dialect/variety and any orthography decisions (spelling system, script, punctuation conventions).",
  },
  {
    id: "registerNaturalness",
    label: "Register & naturalness",
    group: "standards",
    helperText:
      "Formal vs. informal register, and how strongly the team prefers natural target-language phrasing over concordance with the source.",
  },
  {
    id: "literalness",
    label: "Level of literalness",
    group: "standards",
    helperText:
      "Where the translation sits on the formal ↔ functional equivalence spectrum, and when adaptation is acceptable.",
  },
  {
    id: "keyTerms",
    label: "Key terms & theological tradition",
    group: "standards",
    helperText:
      "Key-term strategy, denominational constraints, and whether to transliterate or use indigenous terms for difficult concepts.",
  },
  {
    id: "constraints",
    label: "Constraints & sensitivities",
    group: "standards",
    helperText:
      "Cultural, political, or religious taboos and any renderings that must be avoided.",
  },
  {
    id: "qualityBar",
    label: "Quality bar",
    group: "standards",
    helperText:
      "What 'good' and 'done' mean for this project — the standard a draft must meet before it is acceptable.",
  },
]
