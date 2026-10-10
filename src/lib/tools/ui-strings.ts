/**
 * apiRev 3 `aquilla.ui.strings(keys)`: the app's own UI strings, in the
 * user's language, for an extension that mirrors app UI (the first-party
 * editor uses the editor's catalog so it reads exactly like the built-in, in
 * every locale, RTL included). Plain keys come back as templates with their
 * `{placeholders}` intact; count-governed keys as `{ forms, countVar }` for the
 * frame to select with Intl.PluralRules. Only public UI namespaces.
 */

import { CATALOGS } from "@/lib/i18n/messages"
import { DEFAULT_LOCALE, directionFor } from "@/lib/i18n/locales"

export const UI_STRING_PREFIXES = ["editor.", "common.", "extensions.", "comments.", "workspace.", "agentWorkspace.", "search.", "autopilot."] as const
export const MAX_UI_STRING_KEYS = 600

export type UiStringValue = string | { forms: Record<string, string>; countVar: string }

export interface UiStrings {
  locale: string
  dir: "ltr" | "rtl"
  strings: Record<string, UiStringValue>
}

export function uiStrings(locale: string, keys: readonly string[]): UiStrings {
  const catalog = (CATALOGS[locale] ?? {}) as Record<string, unknown>
  const en = CATALOGS[DEFAULT_LOCALE] as Record<string, unknown>
  const strings: Record<string, UiStringValue> = {}
  for (const key of keys.slice(0, MAX_UI_STRING_KEYS)) {
    if (!UI_STRING_PREFIXES.some((p) => key.startsWith(p))) continue
    const value = catalog[key] ?? en[key]
    if (typeof value === "string") strings[key] = value
    else if (value && typeof value === "object" && "forms" in value) {
      const v = value as { forms: Record<string, string>; countVar: string }
      const fallback = en[key] as { forms: Record<string, string> } | undefined
      strings[key] = { forms: { ...(fallback?.forms ?? {}), ...v.forms }, countVar: v.countVar }
    }
  }
  return { locale, dir: directionFor(locale), strings }
}
