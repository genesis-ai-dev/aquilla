import { useCallback } from "react"
import { useNavigate } from "react-router-dom"

import { EmptyState, NotFoundIcon } from "@/components/ui/empty"
import { useActiveOrg } from "@/context/OrgContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { ALL_ORGS_PARAM, orgHomePath } from "@/lib/navigation/org-paths"

/**
 * AQU-2452: the ONE screen every project access rejection lands on.
 *
 * A rejection is either "there is no such project" or "you may not have this
 * one", and the interface must not say which: telling them apart tells the
 * caller whether a project exists. It is also the only honest wording — the
 * old `forbidden` copy said "You no longer have access", which is wrong for
 * someone who never had any.
 *
 * Both project surfaces render this component, so the two cannot drift apart:
 * the workspace (`ProjectWorkspace`, 403/404 from the project resolve) and the
 * project overview (`ProjectOverview`, which until AQU-2452 silently replaced
 * the URL with the dashboard and showed nothing at all).
 */
export function ProjectNoAccess() {
  const t = useT()
  const navigate = useNavigate()
  const { activeOrgId, isAllOrgs } = useActiveOrg()
  // "Back to dashboard" goes to the dashboard the caller is actually on — the
  // org selected in the switcher, or the all-orgs view.
  const goToDashboard = useCallback(() => {
    navigate(
      isAllOrgs || activeOrgId == null ? orgHomePath(ALL_ORGS_PARAM) : orgHomePath(activeOrgId),
    )
  }, [activeOrgId, isAllOrgs, navigate])

  return (
    <div className="p-8" data-testid="project-no-access">
      <EmptyState
        icon={NotFoundIcon}
        title={
          <RichMessage
            k="workspace.status.noAccess"
            values={{
              backLink: (
                <button type="button" className="underline" onClick={goToDashboard}>
                  {t("workspace.backToDashboard")}
                </button>
              ),
            }}
          />
        }
      />
    </div>
  )
}
