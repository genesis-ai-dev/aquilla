/**
 * CLDR plural categories for the message catalog (AQU-511 / AQU-832).
 *
 * English has two plural forms, so the first pass at this catalog shipped every
 * counted message as a hardcoded pair of keys picked with `count === 1` at the
 * call site. **Arabic has six** (zero/one/two/few/many/other) and Thai, Burmese
 * and Malay have one. A two-form key therefore cannot be made grammatical in
 * Arabic by any translator, however good — it is a correctness ceiling in the
 * catalog's shape, not a quality problem in the translation. Arabic ships, so
 * the shape had to change.
 *
 * The authoring shape is one key whose value is a record of CLDR category →
 * string:
 *
 * ```ts
 * "search.resultCount": plural({ one: "{count} result", other: "{count} results" }),
 * ```
 *
 * The English catalog only supplies the categories English actually uses (`one`
 * and `other`); every other locale supplies the categories *its* language needs,
 * and `catalog-export.ts` tells each translator which those are. `other` is
 * always required in English because it is the last-resort form every fallback
 * chain ends at.
 *
 * This module is a leaf — it imports nothing, so `namespaces/types.ts` can
 * re-export `plural()` without closing an import cycle back through the
 * catalog barrels.
 */

/** CLDR plural categories, in CLDR's canonical order. */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number]

/**
 * Placeholder whose value governs plural selection unless a key names another.
 * `{count}` is the convention across the catalog; `plural(forms, "total")` opts
 * a key out where the noun agrees with a different number in the sentence.
 */
export const DEFAULT_PLURAL_VAR = "count"

/** A count-governed message: one string per plural category the locale needs. */
export interface PluralMessage {
  /**
   * Category → string. English must define `other`; other categories are
   * present only where the language uses them. Partial by design: a translator
   * who filled two of Arabic's six forms still ships, falling back per form.
   */
  readonly forms: Readonly<Partial<Record<PluralCategory, string>>>
  /** Name of the `{placeholder}` whose numeric value selects the category. */
  readonly countVar: string
}

/** A catalog value: a plain string, or a count-governed set of forms. */
export type MessageValue = string | PluralMessage

/**
 * Author a count-governed message. `countVar` names the placeholder that
 * governs selection — pass it only when the counted noun agrees with something
 * other than `{count}` (e.g. `"{failed} of {total} cells failed."` agrees with
 * `{total}`).
 */
export function plural(
  forms: Readonly<Partial<Record<PluralCategory, string>>>,
  countVar: string = DEFAULT_PLURAL_VAR,
): PluralMessage {
  return { forms, countVar }
}

export function isPluralMessage(value: MessageValue | undefined): value is PluralMessage {
  return typeof value === "object" && value !== null && "forms" in value
}

/**
 * Locales whose plural rules `Intl.PluralRules` does not know, mapped to the
 * categories CLDR actually gives them.
 *
 * `Intl.PluralRules("mfa")` does not throw — `mfa` is a well-formed language
 * subtag — it silently falls back to the runtime default locale's rules, which
 * would tell a Patani Malay translator they need an `one` form. Malay has a
 * single form, so that would be asking for work that cannot be used.
 */
const CATEGORY_OVERRIDES: Record<string, readonly PluralCategory[]> = {
  // Patani Malay, like Malay/Indonesian: no grammatical plural.
  mfa: ["other"],
}

/**
 * Locales whose categories are decided here rather than by CLDR. Exported so a
 * test can assert that every locale in `LOCALES` is either covered by CLDR or
 * listed here — otherwise adding an uncovered locale silently serves it English's
 * categories, and nothing fails until translations come back unusable.
 */
export const PLURAL_CATEGORY_OVERRIDE_LOCALES: readonly string[] =
  Object.keys(CATEGORY_OVERRIDES)

const rulesCache = new Map<string, Intl.PluralRules>()

function rulesFor(locale: string): Intl.PluralRules {
  const cached = rulesCache.get(locale)
  if (cached) return cached
  let rules: Intl.PluralRules
  try {
    rules = new Intl.PluralRules(locale)
  } catch {
    // Malformed tag — English rules are the documented base-locale behaviour.
    rules = new Intl.PluralRules("en")
  }
  rulesCache.set(locale, rules)
  return rules
}

function isPluralCategory(value: string): value is PluralCategory {
  return (PLURAL_CATEGORIES as readonly string[]).includes(value)
}

/**
 * The CLDR category `count` falls into for `locale`. Non-finite counts resolve
 * to `other`, which is the form every locale defines, so a bad number degrades
 * to readable text rather than to a missing string.
 */
export function pluralCategory(locale: string, count: number): PluralCategory {
  if (!Number.isFinite(count)) return "other"
  const selected = rulesFor(locale).select(count)
  const category = isPluralCategory(selected) ? selected : "other"
  const allowed = CATEGORY_OVERRIDES[locale]
  if (allowed && !allowed.includes(category)) return "other"
  return category
}

/**
 * Every category `locale` uses, in CLDR order — what a translator for that
 * locale must fill in. This is the list `catalog-export.ts` puts in front of
 * them, and the set of leaves it exports for their catalog.
 */
export function pluralCategoriesFor(locale: string): PluralCategory[] {
  const override = CATEGORY_OVERRIDES[locale]
  const used: readonly string[] =
    override ?? rulesFor(locale).resolvedOptions().pluralCategories
  return PLURAL_CATEGORIES.filter((c) => used.includes(c))
}

/**
 * The number governing a plural selection, read out of a call's vars.
 *
 * Call sites sometimes pass an already-formatted count (`(1234).toLocaleString()`
 * → `"1,234"`), because the grouping separators belong in the rendered string.
 * Selection needs the magnitude, so a string value is reduced to its digits.
 * Counted things are non-negative integers, so this is lossless for every value
 * the catalog actually counts; anything unparseable yields `undefined` and the
 * caller falls back to `other`.
 */
export function pluralCountFrom(
  vars: Record<string, string | number> | undefined,
  countVar: string,
): number | undefined {
  const raw = vars?.[countVar]
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === "string") {
    const digits = raw.replace(/[^0-9]/g, "")
    return digits.length > 0 ? Number(digits) : undefined
  }
  return undefined
}

/**
 * Resolve a count-governed message to one string.
 *
 * The fallback chain is: the locale's form for the selected category → the
 * locale's `other` → English's form for the selected category → English's
 * `other` → any English form. It never yields `undefined` or a raw key, so a
 * locale that filled only `other` (Thai, Burmese) renders, and a locale missing
 * the exact category Arabic selected for this count still renders real text.
 */
export function selectPluralForm(
  localized: MessageValue | undefined,
  base: PluralMessage,
  locale: string,
  vars: Record<string, string | number> | undefined,
): string {
  const count = pluralCountFrom(vars, base.countVar)
  const category = count === undefined ? "other" : pluralCategory(locale, count)
  const localForms = isPluralMessage(localized)
    ? localized.forms
    : typeof localized === "string"
      ? { other: localized }
      : undefined
  return (
    localForms?.[category] ??
    localForms?.other ??
    base.forms[category] ??
    base.forms.other ??
    Object.values(base.forms).find((form) => form.length > 0) ??
    ""
  )
}
