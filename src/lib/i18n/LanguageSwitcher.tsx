/**
 * LanguageSwitcher (AQU-511).
 *
 * A globe icon that opens the UI-language picker. Built on the shared shadcn
 * dropdown-menu so it matches the rest of the app chrome, rather than the native
 * `<select>` this started as — a bare select looked foreign next to every other
 * control and could not show which locale was active without opening it.
 *
 * Each locale is listed by its ENDONYM: a Burmese speaker scans for မြန်မာ, not
 * for the English word "Burmese". The active one is a checked radio item, so the
 * current language is visible in the menu and announced by screen readers.
 *
 * Two copies of this control can be mounted at once (AppShell's chrome switcher
 * and the Preferences settings row) — see AQU-511 finding 8. A screen reader
 * announcing the same name twice with no way to tell them apart is a real defect,
 * so callers that mount alongside another instance MUST pass `ariaLabel` with a
 * distinguishable, already-translated string. The default (`language.label`) is
 * only safe when a single instance is on the page.
 */

import { Globe } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={className}
            aria-label={ariaLabel ?? t("language.label")}
          >
            <Globe className="h-4 w-4" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuRadioGroup value={locale} onValueChange={setLocale}>
          {locales.map((l) => (
            <DropdownMenuRadioItem
              key={l.code}
              value={l.code}
              // Sighted users get the endonym alone, which is all they need next
              // to a globe. A screen reader gets the full action, because "ไทย"
              // announced on its own does not say what selecting it will do.
              aria-label={t("language.switchTo", { language: l.nativeName })}
              // Tag each row with its own language so the browser picks the right
              // font and shaping for the script, and RTL endonyms lay out correctly
              // inside an otherwise LTR menu.
              lang={l.code}
              dir={l.dir}
            >
              {l.nativeName}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
