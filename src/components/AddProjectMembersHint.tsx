// AQU-2194: the line under an assignee picker that holds no linguist. Only
// people on the project can be given work (AQU-676), so it says that, and how
// to get someone onto it. A maintainer gets a link to the project's Members
// settings. Below that, the Members pane is hidden by the org's default
// roster floor (Maintainer, AQU-485) and Staff… can't search the org's member
// list, so a link would dead-end: the line says to ask a maintainer instead.
import { Link, useInRouterContext } from "react-router-dom"
import { FieldDescription } from "@/components/ui/field"
import { useT } from "@/lib/i18n/I18nProvider"

export function AddProjectMembersHint({
  projectId,
  testId,
  canAddPeople,
}: {
  projectId: string
  testId: string
  /** The caller is a maintainer or above, so the Members settings are theirs to open. */
  canAddPeople: boolean
}) {
  const t = useT()
  const inRouter = useInRouterContext()
  const href = `/project/${encodeURIComponent(projectId)}/settings/members`
  const label = t("dialog.assign.addPeopleLink")
  const className = "font-medium text-foreground underline underline-offset-2"
  if (!canAddPeople) {
    return (
      <FieldDescription data-testid={testId}>
        {t("dialog.assign.onlyProjectMembersHint")} {t("dialog.assign.askMaintainerToAdd")}
      </FieldDescription>
    )
  }
  return (
    <FieldDescription data-testid={testId}>
      {t("dialog.assign.onlyProjectMembersHint")}{" "}
      {inRouter ? (
        <Link to={href} className={className}>{label}</Link>
      ) : (
        <a href={href} className={className}>{label}</a>
      )}
    </FieldDescription>
  )
}
