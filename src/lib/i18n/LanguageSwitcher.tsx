/**
 * LanguageSwitcher (AQU-511).
 *
 * Minimal control that changes the active UI locale. Uses the shared shadcn
 * Select listing each locale by its endonym. Exported for placement in the
 * app chrome (nav/settings) as part of the AQU-511 follow-up; the plumbing it
 * drives — provider, persistence, `<html dir>` mirroring — is live today.
 */

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useI18n } from "./I18nProvider"

export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, locales, setLocale, t } = useI18n()
  const items = locales.map((l) => ({ value: l.code, label: l.nativeName }))
  return (
    <Select
      items={items}
      value={locale}
      onValueChange={(v) => {
        if (v) setLocale(v)
      }}
    >
      <SelectTrigger className={className} aria-label={t("language.label")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
