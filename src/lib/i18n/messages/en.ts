/**
 * English base catalog (AQU-511) — the source of truth for message keys.
 *
 * `MessageKey` is derived from this object, so every `t(key)` call is
 * type-checked and other locales are `Partial` catalogs that fall back here.
 * Keep keys namespaced (`area.thing`) and values English; translated catalogs
 * live alongside in `messages/` and only override the keys they cover.
 */

export const en = {
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.delete": "Delete",
  "common.dismiss": "Dismiss",
  "common.retry": "Retry",
  "common.loading": "Loading…",
  "nav.projects": "Projects",
  "nav.settings": "Settings",
  "nav.search": "Search",
  "error.generic.title": "Something went wrong",
  "language.label": "Language",
  "language.switchTo": "Switch language to {language}",
} as const

export type MessageKey = keyof typeof en

/** A translated catalog: any subset of the base keys; missing keys fall back. */
export type Catalog = Partial<Record<MessageKey, string>>
