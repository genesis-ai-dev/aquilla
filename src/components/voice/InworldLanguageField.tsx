// Shown on the New Voice dialog when no project lane maps onto an Inworld
// language code. The chosen BCP-47 tag is stored on the Voice and used for
// catalog fetch + synthesize. "Other" opens a raw code field for tags that
// are not in the shortlist.

import { useMemo, useState } from "react"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import {
  INWORLD_LANGUAGE_CODES,
  INWORLD_LANGUAGE_OTHER,
  formatInworldLanguageLabel,
  isListedInworldLanguage,
  toInworldLanguage,
} from "@/lib/audio/inworld-languages"

export function InworldLanguageField({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (language: string) => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const selected = toInworldLanguage(value)
  const listed = isListedInworldLanguage(value)
  const [otherPicked, setOtherPicked] = useState(() => Boolean(value) && !listed)
  const other = otherPicked || Boolean(value && !listed)
  const options = useMemo(
    () => [...INWORLD_LANGUAGE_CODES]
      .map((code) => ({ code, label: formatInworldLanguageLabel(code, locale) }))
      .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [locale],
  )

  return (
    <>
      <Field>
        <FieldLabel htmlFor="inworld-language">{t("audio.newVoice.inworldLanguageLabel")}</FieldLabel>
        <Select
          value={other ? INWORLD_LANGUAGE_OTHER : (selected ?? null)}
          onValueChange={(next) => {
            if (next === INWORLD_LANGUAGE_OTHER) {
              setOtherPicked(true)
              if (listed) onChange("")
              return
            }
            if (typeof next === "string" && next) {
              setOtherPicked(false)
              onChange(next)
            }
          }}
        >
          <SelectTrigger id="inworld-language" className="h-10">
            <SelectValue placeholder={t("audio.newVoice.inworldLanguagePlaceholder")}>
              {other
                ? t("audio.newVoice.inworldLanguageOther")
                : selected
                  ? formatInworldLanguageLabel(selected, locale)
                  : null}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            side="bottom"
            align="start"
            alignItemWithTrigger={false}
            collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
            className="max-h-40"
          >
            <SelectGroup>
              {options.map((row) => (
                <SelectItem key={row.code} value={row.code}>
                  {row.label}
                </SelectItem>
              ))}
              <SelectItem value={INWORLD_LANGUAGE_OTHER}>
                {t("audio.newVoice.inworldLanguageOther")}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("audio.newVoice.inworldLanguageHint")}</p>
      </Field>
      {other && (
        <Field>
          <FieldLabel htmlFor="inworld-language-code">{t("audio.newVoice.inworldLanguageCodeLabel")}</FieldLabel>
          <Input
            id="inworld-language-code"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value.replace(/\s+/g, "").replace(/_/g, "-"))}
            // i18n-exempt: BCP-47 example (Swedish), not translatable prose
            placeholder="sv-SE"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="inworld-language-code-hint"
          />
          <p id="inworld-language-code-hint" className="text-[11px] text-muted-foreground">
            {t("audio.newVoice.inworldLanguageCodeHint")}
          </p>
        </Field>
      )}
    </>
  )
}
