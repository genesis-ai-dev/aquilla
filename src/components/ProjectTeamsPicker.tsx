/**
 * AQU-1352 P2 (spec §3.5, D4) — "which teams own this project?"
 *
 * Rendered under ProjectDestinationPicker. Lists the teams the caller may
 * create into for the chosen org (create-targets). When the caller's org role
 * is below Maintainer, a team they lead is required: that is the only way an
 * org Guest who runs a team (Tim) can create in the org.
 */
import { useMemo } from "react"
import {
  MultiSelectCombobox,
  MultiSelectComboboxContent,
  MultiSelectComboboxEmpty,
  MultiSelectComboboxList,
  MultiSelectComboboxOption,
  MultiSelectComboboxSearch,
  MultiSelectComboboxTrigger,
  MultiSelectComboboxValue,
} from "@/components/ui/multi-select-combobox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { useT } from "@/lib/i18n/I18nProvider"
import type { CreateTeamTarget } from "@/lib/sync/create-targets"

const MAINTAINER = 600

/** True when POST /projects into this org needs at least one team. */
export function teamsRequired(role: number | undefined, orgId: number | undefined): boolean {
  return orgId != null && (role ?? 0) < MAINTAINER
}

interface ProjectTeamsPickerProps {
  teams: CreateTeamTarget[]
  required: boolean
  value: number[]
  onValueChange: (teamIds: number[]) => void
  showRequiredError?: boolean
}

export function ProjectTeamsPicker({
  teams,
  required,
  value,
  onValueChange,
  showRequiredError = false,
}: ProjectTeamsPickerProps) {
  const t = useT()
  // Team names are unique per org (groups UNIQUE(org_id, name)), so the name
  // is the combobox item and search text; ids travel in the payload.
  const idByName = useMemo(() => new Map(teams.map((x) => [x.name, x.teamId])), [teams])
  const names = useMemo(() => teams.map((x) => x.name), [teams])
  const selectedNames = teams.filter((x) => value.includes(x.teamId)).map((x) => x.name)

  if (teams.length === 0) return null

  return (
    <Field>
      <FieldLabel htmlFor="project-create-teams">{t("projectSettings.create.teamsLabel")}</FieldLabel>
      <MultiSelectCombobox
        items={names}
        value={selectedNames}
        onValueChange={(next: string[]) =>
          onValueChange(next.map((n) => idByName.get(n)).filter((id): id is number => id != null))
        }
      >
        <MultiSelectComboboxTrigger id="project-create-teams" data-testid="project-create-teams">
          <MultiSelectComboboxValue placeholder={t("projectSettings.create.teamsPlaceholder")}>
            {(chosen: string[]) => <span className="truncate">{chosen.join(", ")}</span>}
          </MultiSelectComboboxValue>
        </MultiSelectComboboxTrigger>
        <MultiSelectComboboxContent>
          <MultiSelectComboboxSearch
            placeholder={t("projectSettings.create.teamsSearch")}
            aria-label={t("projectSettings.create.teamsSearch")}
          />
          <MultiSelectComboboxEmpty>{t("projectSettings.create.teamsEmpty")}</MultiSelectComboboxEmpty>
          <MultiSelectComboboxList>
            {(name: string) => (
              <MultiSelectComboboxOption key={name} value={name}>
                {name}
              </MultiSelectComboboxOption>
            )}
          </MultiSelectComboboxList>
        </MultiSelectComboboxContent>
      </MultiSelectCombobox>
      {required && (
        <FieldDescription
          data-testid="project-create-teams-hint"
          className={showRequiredError && value.length === 0 ? "text-destructive" : undefined}
        >
          {t("projectSettings.create.teamsRequiredHint")}
        </FieldDescription>
      )}
    </Field>
  )
}
