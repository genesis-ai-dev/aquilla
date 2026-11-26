/**
 * AQU-2323: the person inspector, /orgs/:orgId/access/people/:userId. Reached
 * from any name on the Places and People lenses. One read
 * (usePersonAccess) feeds the page; the Give access and Remove dialogs are
 * the lenses' own, opened pre-filled. After a write the page re-reads in
 * place, so a granted place moves out of No access without a reload.
 */
import { useState } from "react"
import { ArrowLeft, UserMinus, UserPlus } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { AppShell } from "@/components/AppShell"
import { UserChip } from "@/components/UserChip"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { GiveAccessDialog } from "@/components/org/access/GiveAccessDialog"
import { PersonGrantCards, PersonHistory } from "@/components/org/access/PersonGrantCards"
import { PersonPlacesTree } from "@/components/org/access/PersonPlacesTree"
import { RemoveAccessDialog } from "@/components/org/access/RemoveAccessDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { Page } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOrgAccess } from "@/hooks/useOrgAccess"
import { usePersonAccess } from "@/hooks/usePersonAccess"
import type { GrantRef } from "@/lib/access/edit-access"
import type { ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { orgPath } from "@/lib/navigation/org-paths"
import { formatRelativeTime } from "@/lib/time/relative"

type Giving = { place?: { type: ScopeRef["type"]; id: string } }
type Removing = { grants: GrantRef[]; all: boolean }

export function OrgAccessPersonPage() {
  const t = useT()
  const navigate = useNavigate()
  const { userId } = useParams<{ userId: string }>()
  const { activeOrg } = useActiveOrg()
  const orgId = activeOrg?.id ?? null
  const state = usePersonAccess(orgId, userId)
  const lens = useOrgAccess()
  const { session } = useFrontierSession()
  const [giving, setGiving] = useState<Giving | null>(null)
  const [removing, setRemoving] = useState<Removing | null>(null)
  const accessPath = orgId != null ? orgPath(orgId, "/access") : "/"
  const pageTitle = t("org.access.page.title")

  const main = (() => {
    if (state.status === "loading") return <LoadingPanel label={t("common.loading")} />
    if (state.status === "error" || orgId == null) {
      return <p role="alert" className="text-sm text-muted-foreground">{t("org.access.page.loadError")}</p>
    }
    const { data, reload } = state
    const { person } = data
    const payload = lens.status === "ready" ? lens.data : null
    const canGive = payload != null && Object.values(payload.grantable ?? {}).some((g) => g.ok)
    const reloadBoth = () => {
      reload()
      if (lens.status === "ready") lens.reload()
    }
    const removable = data.grants.filter((g) => g.source === "direct").map((g) => g.grant)
    const lastActive = formatRelativeTime(person.lastActiveAt)
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <header
          aria-label={t("org.access.person.title", { name: person.displayName })}
          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
          data-testid="person-header"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="min-w-0">
              <UserChip userId={person.userId} username={person.displayName} size="lg" nameClassName="text-lg font-medium" />
            </h1>
            {person.email && person.email !== person.displayName && (
              <p className="truncate text-sm text-muted-foreground">{person.email}</p>
            )}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <Badge variant="outline" data-testid="person-status">
                {person.isGuest ? t("org.access.inspector.guest") : t("org.teamsList.memberBadge")}
              </Badge>
              <span>{lastActive ? t("org.access.person.lastActive", { time: lastActive }) : t("org.access.people.noActivity")}</span>
              <span data-testid="person-counts">
                {t("org.access.person.grantCount", { count: data.counts.grants })} · {t("org.access.person.reachesProjects", { count: data.counts.projects })}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!canGive} onClick={() => setGiving({})} data-testid="person-give">
              <UserPlus aria-hidden />
              {t("org.access.give.title")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={removable.length === 0}
              onClick={() => setRemoving({ grants: removable, all: true })}
              data-testid="person-remove-all"
            >
              <UserMinus aria-hidden />
              {t("org.access.person.removeAll")}
            </Button>
          </div>
        </header>
        <PersonPlacesTree
          data={data}
          accessPath={accessPath}
          onGiveAt={canGive ? (place) => setGiving({ place: { type: place.type, id: place.id } }) : undefined}
        />
        <PersonGrantCards
          data={data}
          editing={{
            orgId,
            grantable: payload?.grantable,
            isSelf: person.username != null && person.username === session?.username,
            onChanged: reloadBoth,
            onRemove: (grants) => setRemoving({ grants, all: false }),
          }}
        />
        <PersonHistory history={data.history} />
        {payload && (
          <GiveAccessDialog
            open={giving != null}
            onOpenChange={(open) => { if (!open) setGiving(null) }}
            orgId={orgId}
            payload={payload}
            initialPerson={{ userId: person.userId }}
            initialPlace={giving?.place}
            onGranted={reloadBoth}
          />
        )}
        {removing && (
          <RemoveAccessDialog
            open
            onOpenChange={(open) => { if (!open) setRemoving(null) }}
            orgId={orgId}
            person={{ userId: person.userId, displayName: person.displayName }}
            grants={removing.grants}
            onRemoved={removing.all ? () => navigate(`${accessPath}?lens=people`) : reloadBoth}
          />
        )}
      </div>
    )
  })()

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={pageTitle} />}
      statusBar={null}
      main={
        <Page size="full">
          <div className="flex min-w-0 flex-col gap-4">
            <Link to={`${accessPath}?lens=people`} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:underline">
              <ArrowLeft className="size-4" aria-hidden />
              {t("org.access.person.back")}
            </Link>
            {main}
          </div>
        </Page>
      }
    />
  )
}
