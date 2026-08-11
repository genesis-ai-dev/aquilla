/**
 * LanguageSwitcher (AQU-511).
 *
 * Minimal, dependency-free control that changes the active UI locale. Uses a
 * native `<select>` (keyboard/screen-reader accessible out of the box) listing
 * each locale by its endonym. Exported for placement in the app chrome
 * (nav/settings) as part of the AQU-511 follow-up; the plumbing it drives —
 * provider, persistence, `<html dir>` mirroring — is live today.
 *
 * Two copies of this control are mounted at once (AppShell's chrome switcher
 * and the Preferences settings row) — see AQU-511 finding 8. A screen reader
 * announcing "Language, combo box" twice with no way to tell them apart is a
 * real defect, so callers that mount alongside another instance MUST pass
 * `ariaLabel` with a distinguishable, already-translated string. The default
 * (`language.label`) is only safe when a single instance is on the page.
 */

import { useI18n } from "./I18nProvider"

export function LanguageSwitcher({
  className,
  ariaLabel,
}: {
  className?: string
  /** Already-translated accessible name. Defaults to `t("language.label")`. */
  ariaLabel?: string
}) {
  const { locale, locales, setLocale, t } = useI18n()
  return (
    <select
      className={className}
      aria-label={ariaLabel ?? t("language.label")}
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
