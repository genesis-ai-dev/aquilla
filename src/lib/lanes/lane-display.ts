/**
 * AQU-1592 — the only sanctioned way to read a lane's display name and its
 * language code.
 *
 * The lane row stores ONLY what the user typed:
 *
 *   * `language` — required (freeform: "Spanish", "Yooper English", "Potato").
 *     Never derived. This is what the AI is told and what every "same
 *     language?" comparison reads.
 *   * `name` — optional display override. Display is `name` when set, else
 *     `language`.
 *   * `langCode` — optional override of the code derived from `language`. An
 *     advanced setting, hidden unless the user asks for it. Blank means derive
 *     from `language` at READ time; the derived value is never written back.
 *
 * Deriving at write time is what AQU-1585 is: a `lang_code` captured when the
 * lane was created keeps claiming the old language after someone edits the
 * label. Nothing can drift if nothing derived is stored — so the derivation
 * lives here, on the read path, and every reader goes through it.
 *
 * MIGRATION FALLBACK: rows that predate migration 0152 carry their label in
 * `name` and a write-time-derived code in `langCode`, with `language` NULL.
 * `laneLanguage` therefore falls back to `name`, and a stored `langCode` is
 * honoured as an override. The batch backfill (AQU-1616) is what fills
 * `language` and clears the names and codes that were derived; until it runs,
 * these fallbacks are what make an un-backfilled row read correctly.
 */

import { BLANK_LANE_PLACEHOLDER, codeForLanguageLabel, SOURCE_LANE_PLACEHOLDER } from "./backfill-plan"
import { isLaneId } from "./lane-id"

/**
 * The identity fields of a lane row, as every representation of one carries
 * them (`ProjectLaneRecord`, `ProjectLaneView`, a raw SQL row mapped to camel
 * case). Every field is optional so a caller holding a partial row — or a row
 * from a server that predates 0152 — can still ask.
 */
export interface LaneIdentity {
  role?: "source" | "target"
  language?: string | null
  name?: string | null
  langCode?: string | null
}

/**
 * Project settings, consulted only by the migration fallback inside
 * {@link laneLanguage}. Callers pass the object; they do not read the keys.
 */
export interface LaneLanguageSettings {
  sourceLanguage?: unknown
  targetLanguage?: unknown
}

/**
 * Optional context for {@link laneLanguage}. Existing callers that only have
 * a lane row keep compiling; every consumer that needs a language passes this
 * so the migration fallback and the tag can run.
 */
export interface LaneLanguageContext {
  settings?: LaneLanguageSettings | null
  /** Used when the lane object itself has no role. */
  role?: "source" | "target"
  /**
   * The lane's `legacy_tag`. `''` is the former default lane. `null` is the
   * source lane's tag and must not be treated as the default lane.
   */
  legacyTag?: string | null
}

/** A language string, or null when it is blank or an opaque 8-hex lane id. */
function usableLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || isLaneId(trimmed)) return null
  return trimmed
}

/**
 * The language this lane translates into, as the user typed it.
 *
 * A typed `language` wins, and the migration fallback never overrides it.
 * When `language` is null the source lane and the `legacy_tag ''` lane may
 * still answer from project settings, then the name → tag → code chain. An
 * 8-hex lane id is never a language. Returns "" when nothing names one.
 *
 * Without `context`, this is the name fallback alone (display and code
 * derivation). Tag and code are consulted only when the caller passed a
 * context, because that is what distinguishes "the row's name" from "resolve
 * the language a consumer should be told".
 */
export function laneLanguage(lane: LaneIdentity, context?: LaneLanguageContext): string {
  const typed = usableLanguage(lane.language)
  if (typed) return typed

  const role = lane.role ?? context?.role
  const legacyTag = context?.legacyTag

  // MIGRATION FALLBACK (AQU-1616 / removed by AQU-1595): an unbackfilled row
  // has `language` NULL. Until the backfill runs, the source lane still
  // answers with settings.sourceLanguage and the former default lane
  // (legacy_tag '') still answers with settings.targetLanguage. AQU-1595
  // deletes this branch. It runs before the name → tag → code chain, and it
  // does not apply to any other lane.
  if (role === "source") {
    const fromSettings = usableLanguage(context?.settings?.sourceLanguage)
    if (fromSettings) return fromSettings
  } else if (legacyTag === "") {
    const fromSettings = usableLanguage(context?.settings?.targetLanguage)
    if (fromSettings) return fromSettings
  }

  const name = usableLanguage(lane.name)
  if (name) return name
  if (context) {
    const tag = usableLanguage(legacyTag)
    if (tag) return tag
    const code = usableLanguage(lane.langCode)
    if (code) return code
  }
  return ""
}

/**
 * What the screen shows for this lane: the name when the user gave one, else
 * the language, else the role's placeholder.
 *
 * The placeholder is DERIVED here rather than stored, which is the point: a
 * lane that shows "Untitled lane" has an empty language, not a name of
 * "Untitled lane" that would then survive the language being filled in.
 */
export function laneDisplayName(lane: LaneIdentity): string {
  const name = (lane.name ?? "").trim()
  if (name) return name
  const language = (lane.language ?? "").trim()
  if (language) return language
  return lane.role === "source" ? SOURCE_LANE_PLACEHOLDER : BLANK_LANE_PLACEHOLDER
}

/**
 * The lane's language code: the override when the user set one, else the code
 * derived from the language, else null (honest for a freeform label like
 * "Grade 7 English" that no catalog entry matches).
 *
 * A stored override is canonicalized for case/format when it is a well-formed
 * BCP 47 tag, and returned as stored when it is not — a reader reports what
 * the row holds; rejecting malformed input is the write path's job
 * ({@link canonicalLanguageCodeOverride}).
 */
export function laneLanguageCode(lane: LaneIdentity, context?: LaneLanguageContext): string | null {
  const override = (lane.langCode ?? "").trim()
  if (override && !isLaneId(override)) return canonicalizeBcp47(override) ?? override
  return codeForLanguageLabel(laneLanguage({ ...lane, langCode: null }, context))
}

/** The code the "Advanced" disclosure shows as its placeholder. */
export function derivedLaneLanguageCode(lane: LaneIdentity, context?: LaneLanguageContext): string | null {
  return codeForLanguageLabel(laneLanguage({ ...lane, langCode: null }, context))
}

/** True when this lane carries an explicit code override rather than deriving one. */
export function hasLaneCodeOverride(lane: LaneIdentity): boolean {
  return (lane.langCode ?? "").trim().length > 0
}

/**
 * Canonical form of a BCP 47 tag, or null when the tag is malformed.
 * `Intl.getCanonicalLocales` throws a RangeError on a malformed tag and fixes
 * the case of a well-formed one ("ES-mx" → "es-MX").
 */
function canonicalizeBcp47(tag: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag)
    return canonical ?? null
  } catch {
    return null
  }
}

export type CodeOverrideResult =
  | { ok: true; code: string | null }
  | { ok: false; problem: "malformed" }

/**
 * Validate and canonicalize a code override on the way IN.
 *
 * Blank is valid and means "no override — derive from the language", so it
 * stores NULL. Anything else must be a well-formed BCP 47 tag; it is stored in
 * canonical case so two spellings of one tag cannot disagree.
 */
export function canonicalLanguageCodeOverride(
  raw: string | null | undefined,
): CodeOverrideResult {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return { ok: true, code: null }
  const canonical = canonicalizeBcp47(trimmed)
  if (!canonical) return { ok: false, problem: "malformed" }
  return { ok: true, code: canonical }
}
