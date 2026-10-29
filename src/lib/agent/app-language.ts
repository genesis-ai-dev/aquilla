// AQU-2263: the language the person uses Aquilla in, by its English name, for
// the agent's last answer-language step (auth-worker/src/lib/agent/answer-language.ts).
// Read the way I18nProvider seeds itself: the stored choice, else the browser's.

import { LOCALES } from "@/lib/i18n/locales"
import { detectInitialLocale, readStoredLocale } from "@/lib/i18n/store"

export function appLanguageName(): string {
  const code = detectInitialLocale(
    readStoredLocale(),
    typeof navigator !== "undefined" ? navigator.language : null,
  )
  return LOCALES.find((locale) => locale.code === code)?.englishName ?? "English"
}
