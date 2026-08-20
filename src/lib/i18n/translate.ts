/**
 * Pure translation lookup + interpolation (AQU-511).
 *
 * `translate` resolves a key against a locale catalog and falls back to the
 * English base when the catalog omits it, so an untranslated key renders real
 * English text — never a raw key (AQU-511 acceptance criterion). `{name}`
 * placeholders are filled from `vars`; unknown placeholders are left intact.
 *
 * Count-governed keys (`plural({ one, other, … })` in the base catalog) resolve
 * through `Intl.PluralRules` for `locale`, which is why `translate` takes a
 * locale and not just a catalog: Arabic selects one of six categories where
 * English has two, so the *catalog* cannot be the only locale-aware input. See
 * `plurals.ts` for the fallback chain.
 */

import { en, type Catalog, type MessageKey } from "./messages/en"
import { DEFAULT_LOCALE } from "./locales"
import { isPluralMessage, selectPluralForm } from "./plurals"

export type TVars = Record<string, string | number>

export function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

/**
 * The string a key resolves to for `locale` **before** interpolation: the plural
 * form `vars` selects, with every `{placeholder}` still intact.
 *
 * `translate()` is this followed by `interpolate()`. `<RichMessage>` needs the
 * two steps apart, because selection vars and interpolation vars are not the
 * same set: a counted sentence whose NUMBER carries markup ("**3** endorsements
 * · support **72**%") has to choose its plural form from that number while
 * leaving `{count}` in the template for the markup to be substituted into.
 * Interpolating it there would render the digits as bare text and there would be
 * nothing left to wrap.
 */
export function selectTemplate(
  catalog: Catalog | undefined,
  key: MessageKey,
  vars?: TVars,
  locale: string = DEFAULT_LOCALE,
): string {
  const base = en[key]
  const localized = catalog?.[key]
  if (isPluralMessage(base)) {
    return selectPluralForm(localized, base, locale, vars)
  }
  // A locale that supplied plural forms for a key English keeps as one string:
  // honour the forms rather than dropping them, treating `other` as the base.
  if (isPluralMessage(localized)) {
    return selectPluralForm(
      localized,
      { forms: { other: base }, countVar: "count" },
      locale,
      vars,
    )
  }
  return localized ?? base
}

export function translate(
  catalog: Catalog | undefined,
  key: MessageKey,
  vars?: TVars,
  locale: string = DEFAULT_LOCALE,
): string {
  return interpolate(selectTemplate(catalog, key, vars, locale), vars)
}
