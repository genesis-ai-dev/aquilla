import { Fragment, useEffect, useMemo, useState } from "react"
import { ChevronDownIcon } from "lucide-react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { VoiceInfoTip } from "@/components/voice/VoiceInfoTip"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import {
  accentLabelForRow,
  canonicalizeDesignLocale,
  defaultCodeForFamily,
  designAccentsForFamily,
  designLanguageFamilies,
  familyCodeOf,
  isFamilyDefaultAccent,
  regionFlagEmoji,
  regionOf,
  localeRowsForPicker,
  rowForDesignCode,
} from "@/lib/audio/inworld-design-locales"
import { useInworldSupportedLanguages } from "@/lib/audio/inworld-voices"
import type { FrontierSession } from "@/lib/frontier/types"
import { cn } from "@/lib/utils"

type LocaleOption = { value: string; label: string }

function AccentFlag({ region }: { region: string | undefined }) {
  const flag = regionFlagEmoji(region)
  if (!flag) return null
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full text-[12px] leading-none"
      aria-hidden
    >
      {flag}
    </span>
  )
}

function DesignLanguageCombobox({
  id,
  value,
  options,
  onValueChange,
  searchPlaceholder,
  searchAriaLabel,
  emptyText,
}: {
  id: string
  value: string
  options: readonly LocaleOption[]
  onValueChange: (value: string) => void
  searchPlaceholder: string
  searchAriaLabel: string
  emptyText: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selected = options.find((row) => row.value === value) ?? null

  return (
    <ComboboxPrimitive.Root
      className="w-full"
      items={[...options]}
      value={selected}
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
      inputValue={query}
      onInputValueChange={(next: string) => setQuery(next)}
      autoHighlight
      onValueChange={(row: LocaleOption | null) => {
        if (row) onValueChange(row.value)
      }}
      itemToStringLabel={(row: LocaleOption) => row.label}
      itemToStringValue={(row: LocaleOption) => row.value}
      isItemEqualToValue={(a: LocaleOption, b: LocaleOption) => a.value === b.value}
      filter={(row: LocaleOption, q: string) => {
        const needle = q.trim().toLowerCase()
        if (!needle) return true
        return row.label.toLowerCase().includes(needle) || row.value.toLowerCase().includes(needle)
      }}
    >
      <ComboboxPrimitive.Trigger
        id={id}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pe-2 ps-2.5 text-sm text-foreground outline-none select-none",
          "hover:bg-accent/40 focus-visible:border-ring dark:bg-input/30",
        )}
      >
        <span className="min-w-0 truncate text-start">{selected?.label}</span>
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="flex w-(--anchor-width) min-w-56 flex-col p-0 *:data-[slot=input-group]:mx-0! *:data-[slot=input-group]:my-0! *:data-[slot=input-group]:h-8 *:data-[slot=input-group]:rounded-none *:data-[slot=input-group]:border-0! *:data-[slot=input-group]:bg-transparent! *:data-[slot=input-group]:shadow-none!"
      >
        <ComboboxInput
          showTrigger={false}
          showSearchIcon
          showClear={query !== ""}
          placeholder={searchPlaceholder}
          aria-label={searchAriaLabel}
          className="w-auto rounded-none border-0 bg-transparent shadow-none outline-none ring-0 hover:border-0! focus-within:border-0! has-[[data-slot=input-group-control]:focus-visible]:border-0! has-[[data-slot=input-group-control]:focus-visible]:ring-0! *:data-[slot=input-group-addon]:py-0 *:data-[slot=input-group-addon][data-align=inline-start]:pl-3 *:data-[slot=input-group-addon][data-align=inline-end]:pe-3 *:data-[slot=input-group-addon][data-align=inline-end]:has-[>button]:me-0"
        />
        <ComboboxSeparator className="mx-0 my-0" />
        <ComboboxEmpty className="flex-col items-center px-3 py-4 text-xs text-balance">{emptyText}</ComboboxEmpty>
        <ComboboxList className="max-h-80 flex-1">
          {(row: LocaleOption) => (
            <ComboboxItem key={row.value} value={row} className="min-w-0">
              <span className="min-w-0 truncate">{row.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  )
}

export function InworldDesignLocaleFields({
  language,
  onLanguageChange,
  projectId,
  fileId,
  session,
  copy = "design",
  voicesOnly = false,
}: {
  language?: string
  onLanguageChange: (language: string) => void
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  /** Voice Design vs prebuilt/clone catalog — same picker, different hints. */
  copy?: "design" | "catalog"
  /** Prebuilt: only languages Inworld already has SYSTEM speakers for. */
  voicesOnly?: boolean
}) {
  const t = useT()
  const { locale } = useI18n()
  const { languages: catalog } = useInworldSupportedLanguages({
    enabled: true,
    projectId,
    fileId,
    session,
  })
  const rows = useMemo(
    () => localeRowsForPicker(catalog, language, voicesOnly),
    [catalog, language, voicesOnly],
  )
  const selected = canonicalizeDesignLocale(language, rows)
  const selectedLanguage = familyCodeOf(selected, rows)
  const languageOptions = useMemo<LocaleOption[]>(() => {
    return designLanguageFamilies(rows)
      .map((family) => ({ value: family.familyCode, label: family.familyDisplayName }))
      .sort((a, b) => a.label.localeCompare(b.label, locale))
  }, [rows, locale])
  const accents = designAccentsForFamily(selectedLanguage, rows)
  const namedAccent = (region: "US" | "GB" | "MX" | "BR") => {
    if (region === "US") return t("audio.newVoice.designAccentUS")
    if (region === "GB") return t("audio.newVoice.designAccentGB")
    if (region === "MX") return t("audio.newVoice.designAccentMX")
    return t("audio.newVoice.designAccentBR")
  }
  const standard = t("audio.newVoice.designAccentStandard")
  const familyDefault = t("audio.newVoice.designAccentDefault")
  const accentLabel = (code: string) => {
    const row = rowForDesignCode(code, rows)
      ?? accents.find((entry) => entry.code.toLowerCase() === code.trim().toLowerCase())
    if (!row || isFamilyDefaultAccent(row)) return familyDefault
    return accentLabelForRow(row, locale, namedAccent, standard)
  }

  useEffect(() => {
    if (selected !== language) onLanguageChange(selected)
  }, [selected, language, onLanguageChange])

  const missingLanguageHint = t("audio.newVoice.catalogMissingLanguageHint")

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-3">
      <Field className="min-w-0">
        <div className="flex items-center gap-1.5">
          <FieldLabel htmlFor="inworld-design-language">{t("audio.newVoice.inworldLanguageLabel")}</FieldLabel>
          <VoiceInfoTip
            content={copy === "catalog"
              ? t("audio.newVoice.catalogLanguageHint")
              : t("audio.newVoice.designLanguageHint")}
            label={t("audio.newVoice.designLanguageHelpAria")}
          />
        </div>
        <DesignLanguageCombobox
          id="inworld-design-language"
          value={selectedLanguage}
          options={languageOptions}
          onValueChange={(next) => onLanguageChange(defaultCodeForFamily(next, rows))}
          searchPlaceholder={t("audio.newVoice.designLanguageSearch")}
          searchAriaLabel={t("audio.newVoice.designLanguageSearchAria")}
          emptyText={t("common.noMatches")}
        />
      </Field>

      <Field className="min-w-0">
        <div className="flex items-center gap-1.5">
          <FieldLabel htmlFor="inworld-design-accent">{t("audio.newVoice.designAccentLabel")}</FieldLabel>
          <VoiceInfoTip
            content={copy === "catalog"
              ? t("audio.newVoice.catalogAccentHint")
              : t("audio.newVoice.designAccentHint")}
            label={t("audio.newVoice.designAccentHelpAria")}
          />
        </div>
        <Select
          value={selected}
          onValueChange={(next) => {
            if (typeof next === "string" && next) onLanguageChange(next)
          }}
        >
          <SelectTrigger id="inworld-design-accent" className="w-full!">
            <SelectValue>
              <span className="flex min-w-0 items-center gap-2">
                <AccentFlag region={regionOf(selected)} />
                <span className="truncate">{accentLabel(selected)}</span>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            side="bottom"
            align="start"
            alignItemWithTrigger={false}
            collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
            className="max-h-80"
          >
            <SelectGroup>
              {accents.map((row, index) => (
                <Fragment key={row.code}>
                  {index === 1 ? <SelectSeparator /> : null}
                  <SelectItem value={row.code}>
                    <span className="flex min-w-0 items-center gap-2">
                      <AccentFlag region={regionOf(row.code)} />
                      <span className="truncate">{accentLabel(row.code)}</span>
                    </span>
                  </SelectItem>
                </Fragment>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      </div>
      {voicesOnly && (
        <p className="text-[11px] text-muted-foreground">{missingLanguageHint}</p>
      )}
    </div>
  )
}
