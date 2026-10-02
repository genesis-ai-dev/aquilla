// AQU-1573: which Bible this project QUOTES FROM.
//
// It lives in the Bible-resources card but is NOT behind that card's switch, and
// that is the whole point of the setting. `bibleResourcesEnabled` turns on an
// Aquifer verse lookup for projects whose cells ARE Scripture — English only, no
// version choice. The projects that need a reference Bible are the opposite
// kind: sermons, devotionals, curriculum, books, whose cells are prose that
// QUOTES verses. Those projects keep Aquifer lookup off (it drives the agent to
// hunt Scripture references through non-Bible files) and still need every
// quotation to carry the Bible their readers already know, rather than a fresh
// rendering of the English the model invents.
//
// So: a short, closed list of versions, picked per project, with no dependence on
// the switch above and no dependence on the project having scripture files.
//
// The list is closed on purpose. Every entry is a version whose text we hold and
// whose licence allows it (see db/shared/reference-bibles.ts) — a free-text box
// would let a project name a Bible nothing can supply, and the drafting path
// would then silently inject nothing on every cell.

import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { SettingsRow } from "@/components/ui/page"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  MAX_REFERENCE_BIBLE_VERSIONS,
  REFERENCE_BIBLE_VERSIONS,
} from "../../../db/shared/reference-bibles"
import type { ReactNode } from "react"

interface Props {
  /** The project's chosen version ids, in registry order once saved. */
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  disabledTooltip?: ReactNode
}

export function ReferenceBibleSection({ value, onChange, disabled, disabledTooltip }: Props) {
  const t = useT()
  const selected = new Set(value)
  const atCap = selected.size >= MAX_REFERENCE_BIBLE_VERSIONS

  // Toggling rebuilds the list in REGISTRY order rather than click order, so the
  // stored value — and therefore the order verses appear in a prompt — does not
  // depend on which box someone happened to tick first.
  function toggle(id: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    onChange(REFERENCE_BIBLE_VERSIONS.filter((v) => next.has(v.id)).map((v) => v.id))
  }

  return (
    <SettingsRow
      label={<span>{t("projectSettings.referenceBible.label")}</span>}
      description={
        <>
          {t("projectSettings.referenceBible.description")}
          <span className="mt-1 block">{t("projectSettings.referenceBible.independentHint")}</span>
        </>
      }
      control={
        <DisabledFieldTooltip disabled={Boolean(disabled)} tooltip={disabledTooltip ?? null}>
          <div
            className="flex flex-col gap-2"
            data-testid="settings-reference-bible-versions"
            role="group"
            aria-label={t("projectSettings.referenceBible.label")}
          >
            {REFERENCE_BIBLE_VERSIONS.map((version) => {
              const checked = selected.has(version.id)
              return (
                <div key={version.id} className="flex items-start gap-2">
                  <Checkbox
                    id={`reference-bible-${version.id}`}
                    data-testid={`settings-reference-bible-${version.id}`}
                    checked={checked}
                    // At the cap, the ticked boxes stay operable so a project can
                    // swap one version for another without first clearing all.
                    disabled={disabled || (!checked && atCap)}
                    onCheckedChange={(next) => toggle(version.id, Boolean(next))}
                  />
                  <label htmlFor={`reference-bible-${version.id}`} className="text-sm">
                    {version.languageLabel} — {version.label}
                    <p className="mt-0.5 text-xs text-muted-foreground">{version.licence}</p>
                  </label>
                </div>
              )
            })}
            {atCap ? (
              <p className="text-xs text-muted-foreground">
                {t("projectSettings.referenceBible.capHint")}
              </p>
            ) : null}
          </div>
        </DisabledFieldTooltip>
      }
    />
  )
}
