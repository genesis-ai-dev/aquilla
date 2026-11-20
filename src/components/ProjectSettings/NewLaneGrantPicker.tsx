// AQU-2355 — "Who else gets this language lane", inside the Add a language form.
//
// A lane grant grants only the lanes it lists (AQU-2351 rule 2), so a new lane
// reaches nobody below Maintainer on its own. This lists the people and teams
// already on the project's other lanes, each with the role they hold there,
// all UNTICKED, plus Select all. What is ticked rides along on the create
// request; the server checks it against the same list and gives each pick the
// role it already holds — so ticking a Contributor makes them Contributor on
// the new lane and nothing else.
//
// Mounted only while the add form is open (closed is unmounted), and it reads
// the list once per mount. A list that cannot be read shows nothing: the lane
// can still be created, and people can be added to it afterwards.

import { useEffect, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { roleLabel } from "@/components/access/labels"
import { useT } from "@/lib/i18n/I18nProvider"
import type { NewLaneGrantCandidates, NewLaneGrantPicks } from "@/lib/sync/project-settings"

export interface NewLaneGrantPickerProps {
  load: () => Promise<NewLaneGrantCandidates | null>
  value: NewLaneGrantPicks
  onChange: (next: NewLaneGrantPicks) => void
  disabled?: boolean
}

function toggle(list: readonly number[] | undefined, id: number, on: boolean): number[] {
  const set = new Set(list ?? [])
  if (on) set.add(id)
  else set.delete(id)
  return [...set]
}

export function NewLaneGrantPicker({ load, value, onChange, disabled }: NewLaneGrantPickerProps) {
  const t = useT()
  const [candidates, setCandidates] = useState<NewLaneGrantCandidates | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void load().then((result) => {
      if (alive) setCandidates(result)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per mount
  }, [])

  if (candidates === undefined) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="add-lane-grants-loading">
        <Spinner className="size-3" />
        {t("projectSettings.languages.grantLoading")}
      </p>
    )
  }
  if (!candidates || (candidates.people.length === 0 && candidates.teams.length === 0)) return null

  const people = value.userIds ?? []
  const teams = value.teamIds ?? []
  const total = candidates.people.length + candidates.teams.length
  const ticked = people.length + teams.length
  const allTicked = ticked === total

  return (
    <fieldset className="flex flex-col gap-2" data-testid="add-lane-grants">
      <legend className="text-sm font-medium">{t("projectSettings.languages.grantLegend")}</legend>
      <p className="text-xs text-muted-foreground">{t("projectSettings.languages.grantHint")}</p>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={allTicked}
          indeterminate={ticked > 0 && !allTicked}
          disabled={disabled}
          data-testid="add-lane-grants-select-all"
          onCheckedChange={(on) =>
            onChange(
              on
                ? {
                    userIds: candidates.people.map((p) => p.userId),
                    teamIds: candidates.teams.map((team) => team.groupId),
                  }
                : { userIds: [], teamIds: [] },
            )
          }
        />
        {t("projectSettings.languages.grantSelectAll")}
      </label>
      <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {candidates.teams.map((team) => (
          <li key={`team:${team.groupId}`}>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={teams.includes(team.groupId)}
                disabled={disabled}
                data-testid={`add-lane-grant-team-${team.groupId}`}
                onCheckedChange={(on) => onChange({ ...value, teamIds: toggle(teams, team.groupId, on) })}
              />
              <span className="flex flex-col">
                <span>{team.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t("projectSettings.languages.grantTeamLine", {
                    role: roleLabel(t, team.roleLevel),
                    count: team.memberCount,
                    lanes: team.laneNames.join(", "),
                  })}
                </span>
              </span>
            </label>
          </li>
        ))}
        {candidates.people.map((person) => (
          <li key={`user:${person.userId}`}>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={people.includes(person.userId)}
                disabled={disabled}
                data-testid={`add-lane-grant-user-${person.userId}`}
                onCheckedChange={(on) => onChange({ ...value, userIds: toggle(people, person.userId, on) })}
              />
              <span className="flex flex-col">
                <span>{person.displayName || person.username}</span>
                <span className="text-xs text-muted-foreground">
                  {t("projectSettings.languages.grantPersonLine", {
                    role: roleLabel(t, person.roleLevel),
                    lanes: person.laneNames.join(", "),
                  })}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  )
}
