/**
 * LanguageSwitcher (AQU-511).
 *
 * Minimal, dependency-free control that changes the active UI locale. Uses a
 * native `<select>` (keyboard/screen-reader accessible out of the box) listing
 * each locale by its endonym. Exported for placement in the app chrome
 * (nav/settings) as part of the AQU-511 follow-up; the plumbing it drives —
 * provider, persistence, `<html dir>` mirroring — is live today.
 */

import { useI18n } from "./I18nProvider"

export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, locales, setLocale, t } = useI18n()
  return (
    <select
      className={className}
      aria-label={t("language.label")}
      value={locale}
      onChange={(e) => setLocale(e.target.value)}
    >
      {locales.map((l) => (
        <option key={l.code} value={l.code}>
          {l.nativeName}
        </option>
      ))}
    </select>
  )
}
