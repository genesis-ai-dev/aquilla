/**
 * AQU-1240 (v2) slice 4 — pure lane-derivation logic for the backfill.
 *
 * Given a project's language settings and the distinct target_lang values that
 * actually appear in its data, decide the set of `lanes` rows to create. Kept
 * DB-free so it can be unit-tested exhaustively; the daemon
 * (scripts/neon-backfill-lanes.ts) does the I/O and idempotent writes.
 *
 * Model reminder (old -> new):
 *   * The DEFAULT lane is stored in row data as target_lang = '' but is *named*
 *     by project_settings.targetLanguage. Its `legacy_tag` is therefore ''
 *     (what the rows carry), while name/lang_code come from targetLanguage.
 *   * Every project gets exactly one source lane (legacy_tag = null) and always
 *     a '' default target lane, so the replay shim can resolve legacy '' events
 *     for any project — even an empty or BLANK one.
 *   * Additional target lanes come from (a) distinct target_lang values seen in
 *     the data and (b) the targetLanes registry (declared-but-empty lanes).
 *   * name is the human label (usually already an English name like "Spanish");
 *     lang_code is the ISO 639-1 code when we can confidently map the label,
 *     else null (honest for freeform labels like "Grade 7 English" or BLANK).
 */

import { LANGUAGES } from '../languages/catalog'
import { normalizeLanguageTag } from '../language-normalize'

/** Placeholder name for a default lane on a BLANK project (no targetLanguage). */
export const BLANK_LANE_PLACEHOLDER = 'Untitled lane'

/** Placeholder name for the source lane when sourceLanguage is unset. */
export const SOURCE_LANE_PLACEHOLDER = 'Source'

export type LaneRolePlan = {
  role: 'source' | 'target'
  /** '' for the default target lane; the tag for other target lanes; null for source. */
  legacyTag: string | null
  name: string
  langCode: string | null
}

export type ProjectLaneInputs = {
  /** project_settings.sourceLanguage (may be null/empty). */
  sourceLanguage: string | null
  /** project_settings.targetLanguage — names the '' default lane (may be null/empty). */
  targetLanguage: string | null
  /** project_settings.targetLanes registry (may include the primary; may be empty). */
  registryTargetLanes: string[]
  /** distinct target_lang values found in the data, target side (may include ''). */
  dataTargetTags: string[]
}

/** ISO 639-1 code for a stored language label (English name or code), else null. */
export function codeForLanguageLabel(label: string | null | undefined): string | null {
  const s = (label ?? '').trim()
  if (!s) return null
  const lc = s.toLowerCase()
  const byName = LANGUAGES.find((e) => e.name.toLowerCase() === lc)
  if (byName) return byName.code
  const byCode = LANGUAGES.find((e) => e.code.toLowerCase() === lc)
  if (byCode) return byCode.code
  return null
}

/**
 * Derive the full set of lanes for a project. The first element is always the
 * source lane; the rest are target lanes, deduped by legacy_tag, with the ''
 * default lane always present.
 */
export function planLanesForProject(input: ProjectLaneInputs): LaneRolePlan[] {
  const plans: LaneRolePlan[] = []

  // --- Source lane: always exactly one. --------------------------------------
  const srcLabel = (input.sourceLanguage ?? '').trim()
  plans.push({
    role: 'source',
    legacyTag: null,
    name: srcLabel || SOURCE_LANE_PLACEHOLDER,
    langCode: codeForLanguageLabel(srcLabel),
  })

  // --- Target lanes ----------------------------------------------------------
  // Collect legacy tags: always '' (default), plus every distinct data tag.
  const tags = new Set<string>([''])
  for (const t of input.dataTargetTags) tags.add(t)

  // Registry-only lanes: declared in targetLanes but not present in data. The
  // primary entry (== targetLanguage) is the '' default lane, so never spawn a
  // duplicate for it.
  const primaryNorm = normalizeLanguageTag(input.targetLanguage)
  for (const raw of input.registryTargetLanes) {
    const r = (raw ?? '').trim()
    if (!r) continue
    if (primaryNorm && normalizeLanguageTag(r) === primaryNorm) continue // == default lane
    tags.add(r)
  }

  const primaryLabel = (input.targetLanguage ?? '').trim()
  // Stable order: '' default first, then the rest in first-seen order.
  const ordered = ['', ...[...tags].filter((t) => t !== '')]
  for (const tag of ordered) {
    if (tag === '') {
      plans.push({
        role: 'target',
        legacyTag: '',
        name: primaryLabel || BLANK_LANE_PLACEHOLDER,
        langCode: codeForLanguageLabel(primaryLabel),
      })
    } else {
      plans.push({
        role: 'target',
        legacyTag: tag,
        name: tag, // tags are usually already display names
        langCode: codeForLanguageLabel(tag),
      })
    }
  }

  return plans
}
