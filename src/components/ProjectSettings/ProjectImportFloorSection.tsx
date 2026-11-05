// AQU-2305: who can bring a NEW source file into THIS project, in Project
// settings → Import. The organization sets the floor (Settings → Security,
// AQU-2304) and a project may only make it STRICTER, so this row is the
// "Organization default (…) / Set for this project" pair Project Settings
// already uses for an org default with a project value (OrgDefaultSource),
// beside the role select itself.
//
// The rules are the server's (importFloorWriteRefusal in
// auth-worker/src/routes/project-settings.ts): a stored value is only honoured
// when it is stricter than the organization's, choosing the organization's own
// level removes the project's value, and a value below the organization's floor
// is refused outright. The picker disables what the server would refuse and
// says why, so the UI never offers that choice.
//
// Two rungs, as on the org's own control: anything below Project lead would
// hand imports to translators, which `file.create`'s own static floor refuses
// whatever this says (src/lib/sync/role-policy.ts).
//
// The write itself keeps the ordinary MAINTAINER gate on shared project
// settings — that is the whole protection the decision asked for, since a
// project lead must not be able to raise or lower their own import floor.

import { useState, type ReactNode } from "react"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { OrgDefaultSource, SELECT_LIST_BELOW } from "./OrgDefaultSource"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { ROLE } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import { FLOOR_LABEL } from "@/pages/settings/constants"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { VisibilityFloorView } from "@/lib/sync/project-org-policy"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

const LEVELS = [ROLE.PROJECT_LEAD, ROLE.MAINTAINER] as const

const SOURCE_ID = "project-import-floor-source"
const ROLE_ID = "project-import-floor"

interface Props {
  /** The org's floor, this project's own where stricter, and the one enforced. */
  floor: VisibilityFloorView
  /** The project settings write gate (Maintainer). */
  canEdit: boolean
  /** Why it is locked, shown like every other locked project setting. */
  disabledTooltip?: ReactNode
  onPatch: (updates: ProjectWideSettings) => Promise<PatchOutcome>
}

export function ProjectImportFloorSection({ floor, canEdit, disabledTooltip, onPatch }: Props) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // OrgDefaultSource's contract: "Set for this project" starts from the value
  // in force and changes nothing until the role select is edited. So it opens
  // the role select locally rather than writing a value equal to the org's,
  // which the server would store and then read back as inert anyway.
  const [customising, setCustomising] = useState(false)
  const inherited = floor.project == null && !customising

  const options = LEVELS.map((level) => ({
    value: String(level),
    // A rung below the organization's floor is offered but refused, with the
    // reason on the option itself — the same stricter-only shape the Team card
    // uses for who sees the member list.
    label: level < floor.org
      ? `${FLOOR_LABEL[level]} — ${t("projectSettings.importFloor.stricterOnly")}`
      : FLOOR_LABEL[level] ?? String(level),
    disabled: level < floor.org,
  }))

  async function patch(updates: ProjectWideSettings) {
    setBusy(true)
    setError(null)
    const outcome = await onPatch(updates)
    setBusy(false)
    const why = refusal(outcome, t)
    if (why) setError(why)
    return outcome
  }

  async function chooseSource(inherit: boolean) {
    if (inherit) {
      setCustomising(false)
      // Nothing of its own to clear: it was only opened locally.
      if (floor.project == null) return
      await patch({ importMinRole: undefined })
      return
    }
    setCustomising(true)
  }

  async function chooseRole(raw: string | null) {
    const level = Number(raw)
    if (!Number.isFinite(level) || level === floor.effective) return
    // The organization's own level means "follow the organization".
    const own = level > floor.org ? level : undefined
    const outcome = await patch({ importMinRole: own })
    if (outcome.kind === "ok" && own === undefined) setCustomising(false)
  }

  return (
    <SettingsRow
      label={<label htmlFor={ROLE_ID}>{t("projectSettings.importFloor.label")}</label>}
      description={t("projectSettings.importFloor.description")}
      control={
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip ?? null}>
              <OrgDefaultSource
                id={SOURCE_ID}
                settingLabel={t("projectSettings.importFloor.label")}
                inherited={inherited}
                orgOptionLabel={t("projectSettings.mediaDefaults.orgValue", {
                  value: FLOOR_LABEL[floor.org] ?? String(floor.org),
                })}
                disabled={!canEdit || busy}
                onChange={(inherit) => void chooseSource(inherit)}
              />
            </DisabledFieldTooltip>
            {/* Stays on screen either way and shows the value in force, so
                nobody has to open the menu to learn what "Organization
                default" means today. */}
            <Select
              items={options.map(({ value, label }) => ({ value, label }))}
              value={String(floor.effective)}
              disabled={!canEdit || busy || inherited}
              onValueChange={(v) => void chooseRole(v)}
            >
              <SelectTrigger
                id={ROLE_ID}
                data-testid={ROLE_ID}
                className="w-44 bg-background"
                aria-label={t("projectSettings.importFloor.label")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent {...SELECT_LIST_BELOW}>
                <SelectGroup>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value} disabled={o.disabled}>{o.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}

/** Why a save did not land, in the words the other floor rows use. */
function refusal(outcome: PatchOutcome, t: ReturnType<typeof useT>): string | null {
  switch (outcome.kind) {
    case "ok":
      return null
    case "conflict":
      return t("org.sync.versionConflictError")
    case "blocked":
      return outcome.reason === "offline"
        ? t("org.projectOverview.visibilitySaveOffline")
        : t("org.projectOverview.visibilitySaveForbidden")
    case "error":
      return outcome.message || t("org.projectOverview.visibilitySaveFailed")
  }
}
