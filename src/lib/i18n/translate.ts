/**
 * Pure translation lookup + interpolation (AQU-511).
 *
 * `translate` resolves a key against a locale catalog and falls back to the
 * English base when the catalog omits it, so an untranslated key renders real
 * English text — never a raw key (AQU-511 acceptance criterion). `{name}`
 * placeholders are filled from `vars`; unknown placeholders are left intact.
 */

import { en, type Catalog, type MessageKey } from "./messages/en"

export type TVars = Record<string, string | number>

export function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

export function translate(catalog: Catalog | undefined, key: MessageKey, vars?: TVars): string {
  const template = catalog?.[key] ?? en[key]
  return interpolate(template, vars)
}
