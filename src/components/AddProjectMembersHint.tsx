// AQU-2194: the line under an assignee picker that holds no linguist. Only
// people on the project can be given work (AQU-676), so it says that and links
// to where people are added to the project: the project's Members settings,
// which work for anyone allowed to assign, whether or not the organisation
// lets them see its member list (Staff… on a language searches that list).
import { Link, useInRouterContext } from "react-router-dom"
import { FieldDescription } from "@/components/ui/field"
import { useT } from "@/lib/i18n/I18nProvider"

export function AddProjectMembersHint({ projectId, testId }: { projectId: string; testId: string }) {
  const t = useT()
  const inRouter = useInRouterContext()
  const href = `/project/${encodeURIComponent(projectId)}/settings/members`
  const label = t("dialog.assign.addPeopleLink")
  const className = "font-medium text-foreground underline underline-offset-2"
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
