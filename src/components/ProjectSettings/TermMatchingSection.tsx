// TermMatchingSection — AQU-1271 "Project settings: affix inventory editor".
//
// Editor for the project-wide `TermMatchingSettings` affix inventory:
// prefixes/suffixes tag lists, a max-chained-affixes cap, and a default for
// whether matching ignores vowel marks/accents. Purely controlled — the
// parent (ProjectSettings.tsx) owns the value and diffs it against the
// baseline on save, same as every other shared-settings section on the page.
import { useState, type KeyboardEvent } from "react"
import { X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { useT } from "@/lib/i18n/I18nProvider"
import { AFFIX_PRESETS } from "@/lib/terminology/affix-presets"
import type { TermMatchingSettings } from "@/lib/terminology/types"

interface Props {
  value: TermMatchingSettings
  onChange: (next: TermMatchingSettings) => void
  disabled: boolean
}

function clampMaxAffixes(raw: string): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return 1
  if (n < 1) return 1
  if (n > 4) return 4
  return n
}

function AffixTagInput({
  label,
  values,
  disabled,
  placeholder,
  removeLabel,
  onAdd,
  onRemove,
}: {
  label: string
  values: string[]
  disabled: boolean
  placeholder: string
  removeLabel: (affix: string) => string
  onAdd: (value: string) => void
  onRemove: (value: string) => void
}) {
  const [draft, setDraft] = useState("")

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return
    e.preventDefault()
    const trimmed = draft.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setDraft("")
  }

  return (
    <div className="space-y-2">
      <Input
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        className="bg-background"
      />
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((affix) => (
            <Badge key={affix} variant="outline" className="gap-1 pr-1">
              {affix}
              <button
                type="button"
                disabled={disabled}
                aria-label={removeLabel(affix)}
                onClick={() => onRemove(affix)}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

export function TermMatchingSection({ value, onChange, disabled }: Props) {
  const t = useT()

  function addAffix(side: "prefixes" | "suffixes", affix: string) {
    if (value[side].includes(affix)) return
    onChange({ ...value, [side]: [...value[side], affix] })
  }

  function removeAffix(side: "prefixes" | "suffixes", affix: string) {
    onChange({ ...value, [side]: value[side].filter((a) => a !== affix) })
  }

  function loadPreset(preset: (typeof AFFIX_PRESETS)[number]) {
    onChange({ ...value, prefixes: preset.prefixes, suffixes: preset.suffixes })
  }

  return (
    <SettingsGroup label={t("projectSettings.termMatching.title")} description={t("projectSettings.termMatching.description")}>
      <SettingsRow
        label={t("projectSettings.termMatching.loadPreset")}
        control={
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" disabled={disabled}>
                  {t("projectSettings.termMatching.loadPreset")}
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {AFFIX_PRESETS.map((preset) => (
                <DropdownMenuItem key={preset.id} onClick={() => loadPreset(preset)}>
                  {t(preset.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <SettingsRow label={t("projectSettings.termMatching.prefixes")} block>
        <AffixTagInput
          label={t("projectSettings.termMatching.prefixes")}
          values={value.prefixes}
          disabled={disabled}
          placeholder={t("projectSettings.termMatching.addAffixPlaceholder")}
          removeLabel={(affix) => t("projectSettings.termMatching.remove", { affix })}
          onAdd={(affix) => addAffix("prefixes", affix)}
          onRemove={(affix) => removeAffix("prefixes", affix)}
        />
      </SettingsRow>
      <SettingsRow label={t("projectSettings.termMatching.suffixes")} block>
        <AffixTagInput
          label={t("projectSettings.termMatching.suffixes")}
          values={value.suffixes}
          disabled={disabled}
          placeholder={t("projectSettings.termMatching.addAffixPlaceholder")}
          removeLabel={(affix) => t("projectSettings.termMatching.remove", { affix })}
          onAdd={(affix) => addAffix("suffixes", affix)}
          onRemove={(affix) => removeAffix("suffixes", affix)}
        />
      </SettingsRow>
      <SettingsRow
        label={<label htmlFor="term-matching-max-affixes">{t("projectSettings.termMatching.maxAffixes")}</label>}
        control={
          <Input
            id="term-matching-max-affixes"
            type="number"
            min={1}
            max={4}
            disabled={disabled}
            value={value.maxAffixes ?? 2}
            onChange={(e) => onChange({ ...value, maxAffixes: clampMaxAffixes(e.target.value) })}
            className="w-24 bg-background"
            aria-label={t("projectSettings.termMatching.maxAffixes")}
          />
        }
      />
      <SettingsRow
        label={<label htmlFor="term-matching-fold-marks">{t("projectSettings.termMatching.foldMarksDefault")}</label>}
        control={
          <Switch
            id="term-matching-fold-marks"
            disabled={disabled}
            checked={value.foldMarksDefault ?? false}
            onCheckedChange={(checked) => onChange({ ...value, foldMarksDefault: checked })}
            aria-label={t("projectSettings.termMatching.foldMarksDefault")}
          />
        }
      />
    </SettingsGroup>
  )
}
