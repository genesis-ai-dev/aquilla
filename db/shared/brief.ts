// Translation-brief contract (AQU-1227) — dependency-free, importable by BOTH
// workers. The brief is stored as the `translationBrief` key of the project
// settings blob (project_settings.settings), i.e. exactly where the in-app
// brief builder writes it: an API-set brief and a hand-typed one are the same
// row, so every reader (the brief builder, the autopilot brief gate, the
// agent's prompt augmentation) sees them identically with no extra wiring.
//
// The SPA counterpart is `src/lib/brief/schema.ts` + `src/lib/brief/brief.ts`,
// which key their labels off i18n. Field IDS are the storage contract and must
// match; `src/lib/brief/schema.shared-parity.test.ts` fails the root suite if
// they ever drift. The headings below are the English fallback used when the
// brief is assembled server-side, where there is no viewer locale.

export type BriefFieldGroup = 'purpose' | 'standards'

export interface BriefFieldSpec {
  /** Stable storage key — NEVER rename; it keys TranslationBrief.parameters. */
  id: string
  group: BriefFieldGroup
  /** English heading used for server-side L2 assembly (mirrors the en labels
   *  in src/lib/i18n/namespaces/agent.ts). */
  heading: string
}

/** Interview order — the same order the in-app builder walks. */
export const BRIEF_FIELD_SPECS: readonly BriefFieldSpec[] = [
  { id: 'purpose', group: 'purpose', heading: 'Purpose / skopos' },
  { id: 'audience', group: 'purpose', heading: 'Audience / addressees' },
  { id: 'useAndMedium', group: 'purpose', heading: 'Intended use & medium' },
  { id: 'motiveSponsor', group: 'purpose', heading: 'Motive & sponsor' },
  { id: 'sourceTexts', group: 'standards', heading: 'Source & base texts' },
  { id: 'targetVariety', group: 'standards', heading: 'Target language & variety' },
  { id: 'registerNaturalness', group: 'standards', heading: 'Register & naturalness' },
  { id: 'literalness', group: 'standards', heading: 'Level of literalness' },
  { id: 'keyTerms', group: 'standards', heading: 'Key terms & theological tradition' },
  { id: 'constraints', group: 'standards', heading: 'Constraints & sensitivities' },
  { id: 'qualityBar', group: 'standards', heading: 'Quality bar' },
]

export const BRIEF_FIELD_IDS: readonly string[] = BRIEF_FIELD_SPECS.map((f) => f.id)

const BRIEF_FIELD_ID_SET = new Set(BRIEF_FIELD_IDS)

export function isBriefFieldId(id: string): boolean {
  return BRIEF_FIELD_ID_SET.has(id)
}

/** The settings key the brief lives under. */
export const BRIEF_SETTINGS_KEY = 'translationBrief'

/** Structural mirror of the SPA's `TranslationBrief` (src/lib/brief/types.ts).
 *  Declared here rather than imported so this module stays dependency-free. */
export interface TranslationBriefRecord {
  version: number
  updatedAt: string
  updatedBy: string
  parameters: Record<string, string>
  freeformNotes: string
  l2Markdown: string
  l1Summary: string | null
  l1GeneratedAt: string | null
  l1ModelId: string | null
}

/** A blank brief. version 0 mirrors the project_settings "no server row" floor
 *  (same contract as the SPA's emptyBrief). */
export function emptyBriefRecord(author: string, now: string): TranslationBriefRecord {
  return {
    version: 0,
    updatedAt: now,
    updatedBy: author,
    parameters: {},
    freeformNotes: '',
    l2Markdown: '',
    l1Summary: null,
    l1GeneratedAt: null,
    l1ModelId: null,
  }
}

const GROUP_HEADINGS: Record<BriefFieldGroup, string> = {
  purpose: 'Purpose & audience',
  standards: 'Standards',
}

/**
 * Render the brief as markdown from its filled parameters and freeform notes.
 * Empty fields are omitted (not stubbed) so a partial brief still reads
 * cleanly. Mirrors the SPA's assembleL2Markdown; the SPA resolves headings
 * through i18n for the viewer's locale, this one is English because a
 * server-side write has no viewer.
 */
export function assembleBriefL2Markdown(brief: TranslationBriefRecord): string {
  const parts: string[] = ['# Translation Brief']
  for (const group of ['purpose', 'standards'] as BriefFieldGroup[]) {
    const fields = BRIEF_FIELD_SPECS.filter(
      (f) => f.group === group && (brief.parameters[f.id] ?? '').trim(),
    )
    if (!fields.length) continue
    parts.push(`## ${GROUP_HEADINGS[group]}`)
    for (const f of fields) {
      parts.push(`### ${f.heading}\n${brief.parameters[f.id].trim()}`)
    }
  }
  if (brief.freeformNotes.trim()) {
    parts.push(`## Additional notes\n${brief.freeformNotes.trim()}`)
  }
  return parts.join('\n\n')
}

/** Read the stored brief out of a settings blob. Anything that isn't a plain
 *  object (absent key, a legacy string, a hand-edited array) reads as "no
 *  brief yet" rather than throwing — the caller then starts from empty. */
export function readBriefFromSettings(
  settings: Record<string, unknown>,
): TranslationBriefRecord | null {
  const raw = settings[BRIEF_SETTINGS_KEY]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const parameters: Record<string, string> = {}
  if (typeof r.parameters === 'object' && r.parameters !== null && !Array.isArray(r.parameters)) {
    for (const [k, v] of Object.entries(r.parameters as Record<string, unknown>)) {
      if (typeof v === 'string') parameters[k] = v
    }
  }
  return {
    version: typeof r.version === 'number' && Number.isInteger(r.version) && r.version >= 0 ? r.version : 0,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : '',
    parameters,
    freeformNotes: typeof r.freeformNotes === 'string' ? r.freeformNotes : '',
    l2Markdown: typeof r.l2Markdown === 'string' ? r.l2Markdown : '',
    l1Summary: typeof r.l1Summary === 'string' ? r.l1Summary : null,
    l1GeneratedAt: typeof r.l1GeneratedAt === 'string' ? r.l1GeneratedAt : null,
    l1ModelId: typeof r.l1ModelId === 'string' ? r.l1ModelId : null,
  }
}

/** The content half of a brief write — what a caller may set. */
export interface BriefPatch {
  /** Field id → answer. Only the named fields are replaced; every other field
   *  keeps its live value (partial update). */
  parameters?: Record<string, string>
  /** Replaces the freeform notes block. Omit to leave it untouched. */
  freeformNotes?: string
}

/**
 * Pure merge producing the next persisted brief: named parameters replaced,
 * unnamed ones carried over, version bumped, L2 reassembled.
 *
 * The generated L1 summary is deliberately carried over rather than cleared —
 * clearing it would erase work, while keeping it lets the SPA's `isL1Stale()`
 * (updatedAt > l1GeneratedAt) mark it stale so the builder offers "Regenerate
 * summary". That matches exactly what an in-app content edit does.
 */
export function applyBriefPatch(
  prev: TranslationBriefRecord,
  patch: BriefPatch,
  author: string,
  now: string,
): TranslationBriefRecord {
  const next: TranslationBriefRecord = {
    ...prev,
    version: prev.version + 1,
    updatedAt: now,
    updatedBy: author,
    parameters: { ...prev.parameters, ...(patch.parameters ?? {}) },
    freeformNotes: patch.freeformNotes ?? prev.freeformNotes,
    l2Markdown: '',
  }
  next.l2Markdown = assembleBriefL2Markdown(next)
  return next
}

/**
 * Is the patch's intent already live? Compares only the CONTENT the patch
 * names — version/updatedAt/updatedBy always differ on a write, so including
 * them would make every plan look unsatisfied.
 */
export function isBriefPatchSatisfied(
  live: TranslationBriefRecord | null,
  patch: BriefPatch,
): boolean {
  if (!live) return false
  for (const [id, value] of Object.entries(patch.parameters ?? {})) {
    if ((live.parameters[id] ?? '') !== value) return false
  }
  if (patch.freeformNotes !== undefined && live.freeformNotes !== patch.freeformNotes) return false
  return true
}
