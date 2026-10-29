// AQU-2263: the language the person uses Aquilla in, by its English name. The
// agent answers in it only when neither the person nor the project chose one
// and the latest message's language can't be told
// (auth-worker/src/lib/agent/answer-language.ts).
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
