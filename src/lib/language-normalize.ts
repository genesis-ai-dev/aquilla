/**
 * AQU-1597: there is exactly one answer to "are these the same language?",
 * and it lives in `db/shared/language-normalize.ts` so the SPA, auth-worker
 * and sync-worker all ask it the same way. This module is the SPA's import
 * path for it (`@/lib/language-normalize`) and adds nothing of its own.
 *
 * "Same lane?" is NOT a language question — compare lane ids, or match the
 * stored `legacy_tag` byte-exactly when replaying events.
 */

export {
  normalizeLanguageTag,
  languagesEqual,
  languageSurfaceForms,
  languageTagKey,
  sameLanguageTag,
  matchLanguageTag,
} from "../../db/shared/language-normalize"
