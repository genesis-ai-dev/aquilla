import { Link } from "react-router-dom"

import { RoleBadge } from "@/components/access/RoleBadge"
import { ScopeBreadcrumb } from "@/components/access/ScopeBreadcrumb"
import { roleLabel } from "@/components/access/labels"
import { UserChip } from "@/components/UserChip"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { OrgAccessPerson } from "@/components/org/access/org-access-data"
import {
  PEOPLE_FILTERS,
  formatReach,
  grantedAtPlaces,
  highestRoleLevel,
  personReach,
  type PeopleFilter,
  type PlaceCounts,
} from "@/lib/access/people-lens"
import { scopePathKey } from "@/lib/access/scope-path"
import { membersPath } from "@/lib/navigation/org-paths"
import { formatRelativeTime } from "@/lib/time/relative"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

const FILTER_LABEL = {
  everyone: "org.access.people.filterEveryone",
  members: "org.access.people.filterMembers",
  guests: "org.access.people.filterGuests",
  invites: "org.access.people.filterInvites",
  granters: "org.access.people.filterGranters",
  inactive: "org.access.people.filterInactive",
} as const

/**
 * AQU-2319: one roster. A name links to the member list. The person inspector
 * is a later slice.
 */
export function PeopleLens({
  people,
  placeCounts,
  filter,
  filterCounts,
  onFilter,
  orgId,
}: {
  people: OrgAccessPerson[]
  placeCounts: PlaceCounts
  filter: PeopleFilter
  filterCounts: Record<PeopleFilter, number>
  onFilter: (filter: PeopleFilter) => void
  orgId: number | null
}) {
  const t = useT()
  return (
    <div data-testid="people-lens" className="flex min-w-0 flex-col gap-3">
      <div role="group" aria-label={t("org.access.people.filtersAriaLabel")} className="flex flex-wrap gap-1.5">
        {PEOPLE_FILTERS.map((id) => {
          const on = id === filter
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              data-testid={`people-filter-${id}`}
              onClick={() => onFilter(id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm",
                on ? "border-transparent bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
            >
              {t(FILTER_LABEL[id])}
              <span className="tabular-nums text-muted-foreground">{filterCounts[id]}</span>
            </button>
          )
        })}
      </div>
      {people.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("org.access.people.noMatches")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("org.access.people.person")}</TableHead>
              <TableHead>{t("org.access.people.highestRole")}</TableHead>
              <TableHead>{t("org.access.people.grantedAt")}</TableHead>
              <TableHead>{t("org.access.people.reaches")}</TableHead>
              <TableHead>{t("org.access.people.lastActive")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((person) => (
              <PersonRow key={person.userId} person={person} placeCounts={placeCounts} orgId={orgId} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

export function PeoplePrintReport({
  people,
  placeCounts,
  orgName,
  filterLabel,
}: {
  people: OrgAccessPerson[]
  placeCounts: PlaceCounts
  orgName: string
  filterLabel: string
}) {
  const t = useT()
  return (
    <section className="people-print-report" data-testid="people-print-report">
      <h1 className="text-lg font-medium">{t("org.access.page.title")}</h1>
      <p className="text-sm">{orgName} · {filterLabel}</p>
      {people.map((person) => (
        <article key={person.userId} className="people-print-person mt-4">
          <h2 className="text-sm font-medium">{person.displayName}</h2>
          {person.email && person.email !== person.displayName && (
            <p className="text-sm text-muted-foreground">{person.email}</p>
          )}
          <p className="text-sm">{formatReach(t, personReach(person, placeCounts))}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {person.grants.map((grant, index) => (
              <li key={`${scopePathKey(grant.scopePath)}:${index}`} className="flex flex-wrap items-center gap-2 text-sm">
                <ScopeBreadcrumb path={grant.scopePath} />
                <span>{roleLabel(t, grant.roleLevel)}</span>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  )
}

function PersonRow({
  person,
  placeCounts,
  orgId,
}: {
  person: OrgAccessPerson
  placeCounts: PlaceCounts
  orgId: number | null
}) {
  const t = useT()
  const level = highestRoleLevel(person)
  const granted = grantedAtPlaces(person)
  const href = orgId != null && !person.pendingInvite ? `${membersPath(orgId)}#member-${person.userId}` : null
  const expiry = person.pendingInvite ? inviteExpiry(t, person.pendingInvite.expiresAt) : null
  const email = person.email && person.email !== person.displayName ? person.email : null
  const chip = person.pendingInvite ? (
    <UserChip distinguishId={person.userId} visibleLabel={person.displayName} size="xs" nameClassName="text-sm font-normal" />
  ) : (
    <UserChip userId={person.userId} username={person.displayName} size="xs" nameClassName="text-sm font-normal" />
  )
  return (
    <TableRow data-testid="people-row" data-person={person.displayName}>
      <TableCell>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {href ? (
              <Link
                to={href}
                aria-label={t("org.access.people.openPersonAriaLabel", { name: person.displayName })}
                className="inline-flex min-w-0 rounded hover:underline"
              >
                {chip}
              </Link>
            ) : (
              chip
            )}
            {person.isGuest && !person.pendingInvite && (
              <Badge variant="outline" data-testid="guest-badge">{t("org.access.inspector.guest")}</Badge>
            )}
            {person.pendingInvite && (
              <Badge variant="outline" data-testid="invited-badge">{t("org.access.people.invited")}</Badge>
            )}
          </span>
          {(expiry || email) && <span className="text-xs text-muted-foreground">{expiry ?? email}</span>}
        </div>
      </TableCell>
      <TableCell>
        {level == null ? (
          <Badge variant="soft" data-testid="role-badge" data-origin="none" className="rounded-full">
            {t("org.access.people.noAccessYet")}
          </Badge>
        ) : (
          <RoleBadge roleLevel={level} origin={{ kind: "direct" }} />
        )}
      </TableCell>
      <TableCell>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {granted.shown.map((path) => (
            <ScopeBreadcrumb key={scopePathKey(path)} path={path} />
          ))}
          {granted.extra > 0 && (
            <span data-testid="granted-at-more">{t("org.access.people.extraGrants", { count: granted.extra })}</span>
          )}
        </span>
      </TableCell>
      <TableCell data-testid="people-reaches">{formatReach(t, personReach(person, placeCounts))}</TableCell>
      <TableCell data-testid="people-last-active" className="whitespace-nowrap text-muted-foreground">
        {formatRelativeTime(person.lastActiveAt) ?? t("org.access.people.noActivity")}
      </TableCell>
    </TableRow>
  )
}

function inviteExpiry(t: TFunction, expiresAt: string | null): string | null {
  if (!expiresAt) return null
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return t("org.membersPage.orgPage.expired")
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return t("org.membersPage.orgPage.expiresInMinutes", { count: minutes })
  const hours = Math.max(1, Math.round(ms / 3_600_000))
  if (hours < 48) return t("org.membersPage.orgPage.expiresInHours", { count: hours })
  return t("org.membersPage.orgPage.expiresInDays", { count: Math.max(1, Math.round(ms / 86_400_000)) })
}
