import { ChevronRight, UserPlus } from "lucide-react"
import { useSearchParams } from "react-router-dom"

import { MemberInspectorTrigger } from "@/components/access/MemberInspectorTrigger"
import { PLACE_ICON } from "@/components/access/place-icons"
import { RoleBadge } from "@/components/access/RoleBadge"
import { ScopeBreadcrumb } from "@/components/access/ScopeBreadcrumb"
import { UserChip } from "@/components/UserChip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { filterPlaceTree, placeParam, placeRowCounts } from "@/lib/access/place-lens"
import type { GrantOrigin, ScopeRef } from "@/lib/access/types"
import type { AccessFromScope } from "@/lib/sync/access-read"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

import { accessNodeId } from "./access-anchors"
import type { AccessTreeNode, DirectGrantee, InheritedSource } from "./org-access-data"

const PLACE_KIND = {
  org: "org.access.places.kindOrg",
  team: "org.access.scope.team",
  project: "org.access.scope.project",
  lane: "org.access.scope.lane",
} as const

/**
 * AQU-2318: the Places lens. The tree is every place the server says this
 * person can see; the detail is the grants at the selected place and the
 * ancestor grants that resolve to it. Nothing here edits a grant.
 */
export function PlacesLens({ tree, query }: { tree: AccessTreeNode[]; query: string }) {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const filtered = filterPlaceTree(tree, query)
  const selected = locate(tree, params.get("place")) ?? locate(tree, tree[0] ? placeParam(tree[0].scope) : null)

  const select = (scope: { type: string; id: string }) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("place", placeParam(scope))
      return next
    })
  }

  return (
    <div
      data-testid="places-lens"
      className="flex min-w-0 flex-col gap-4 overflow-x-hidden md:flex-row md:items-start"
    >
      <div className="flex w-full min-w-0 flex-col gap-2 md:w-72 md:shrink-0">
        {filtered.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">{t("org.access.places.noMatches")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5" data-testid="access-tree">
            {filtered.map((node) => (
              <PlaceBranch
                key={placeParam(node.scope)}
                node={node}
                depth={0}
                selectedKey={selected ? placeParam(selected.node.scope) : null}
                onSelect={select}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {selected && <PlaceDetail node={selected.node} path={selected.path} onSelect={select} tree={tree} />}
      </div>
    </div>
  )
}

function PlaceBranch({
  node,
  depth,
  selectedKey,
  onSelect,
}: {
  node: AccessTreeNode
  depth: number
  selectedKey: string | null
  onSelect: (scope: ScopeRef) => void
}) {
  const Icon = PLACE_ICON[node.scope.type]
  const key = placeParam(node.scope)
  const selected = key === selectedKey
  const count = placeRowCounts(node).total
  return (
    <li
      id={accessNodeId(node.scope)}
      data-testid={accessNodeId(node.scope)}
      className="min-w-0 scroll-mt-16"
      style={{ paddingInlineStart: depth === 0 ? undefined : "0.75rem" }}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(node.scope)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden data-place-icon={node.scope.type} />
        <span className="min-w-0 flex-1 truncate">{node.scope.name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="mt-0.5 flex min-w-0 flex-col gap-0.5 border-s border-border">
          {node.children.map((child) => (
            <PlaceBranch
              key={placeParam(child.scope)}
              node={child}
              depth={depth + 1}
              selectedKey={selectedKey}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function PlaceDetail({
  node,
  path,
  tree,
  onSelect,
}: {
  node: AccessTreeNode
  path: ScopeRef[]
  tree: AccessTreeNode[]
  onSelect: (scope: ScopeRef) => void
}) {
  const t = useT()
  const counts = placeRowCounts(node)
  const org = path.find((scope) => scope.type === "org" && !scope.hidden && scope.name)
  const from = org
    ? t("org.access.places.reachesFrom", { name: org.name })
    : t("org.access.places.reachesFromAbove")
  const inherited = node.inherited ?? []
  // A team is not a crumb beside an organization (AQU-2361). On its own page
  // the path is only the team, so the header still names the place you selected.
  const headerPath = node.scope.type === "team" ? [node.scope] : path
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <ScopeBreadcrumb path={headerPath} icons className="min-w-0" />
        <AppTooltip content={t("org.access.places.giveAccessSoon")}>
          <Button type="button" size="sm" disabled>
            <UserPlus aria-hidden />
            {t("org.access.places.giveAccess")}
          </Button>
        </AppTooltip>
      </div>
      <p data-testid="place-summary" className="text-sm">
        {t("org.access.places.openPeople", { count: counts.total, place: t(PLACE_KIND[node.scope.type]) })}{" "}
        {t("org.access.places.grantedCount", { count: counts.granted })}
        {"; "}
        {t("org.access.places.reachesCount", { count: counts.reaches, from })}
        .
      </p>
      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="granted-here-heading">
        <h2 id="granted-here-heading" className="text-sm font-medium">{t("org.access.places.grantedHere")}</h2>
        {node.directGrantees.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("org.access.page.noDirect")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {node.directGrantees.map((person) => (
              <GrantedRow key={person.userId} person={person} path={path} />
            ))}
          </ul>
        )}
      </section>
      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="reaches-here-heading">
        <h2 id="reaches-here-heading" className="text-sm font-medium">{t("org.access.places.reachesHere")}</h2>
        {inherited.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("org.access.places.noReaches")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {inherited.map((source, i) => (
              <ReachesRow
                key={`${source.kind}:${source.userId ?? source.from.id}:${i}`}
                source={source}
                path={path}
                canOpen={locate(tree, placeParam(source.from)) != null}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function GrantedRow({ person, path }: { person: DirectGrantee; path: ScopeRef[] }) {
  const t = useT()
  const origin: GrantOrigin = person.source === "creator" ? { kind: "creator" } : { kind: "direct" }
  const secondary = person.pendingInvite
    ? inviteStatus(t, person.pendingInvite.expiresAt)
    : person.email && person.email !== person.displayName
      ? person.email
      : null
  return (
    <li data-testid="granted-here-row" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-card px-3 py-2">
      <PersonName person={person} path={path} />
      {secondary && <span className="min-w-0 truncate text-sm text-muted-foreground">{secondary}</span>}
      {person.isGuest && <Badge variant="outline" data-testid="guest-badge">{t("org.access.inspector.guest")}</Badge>}
      <span className="ms-auto">
        <RoleBadge roleLevel={person.roleLevel} origin={origin} />
      </span>
    </li>
  )
}

function ReachesRow({
  source,
  path,
  canOpen,
  onSelect,
}: {
  source: InheritedSource
  path: ScopeRef[]
  canOpen: boolean
  onSelect: (scope: ScopeRef) => void
}) {
  const t = useT()
  return (
    <li
      data-testid="reaches-here-row"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed px-3 py-2"
    >
      {source.kind === "team" ? (
        <TeamMark name={source.from.name} memberCount={source.memberCount ?? 0} />
      ) : (
        <PersonName
          person={{
            userId: source.userId ?? source.from.id,
            displayName: source.displayName ?? source.from.name,
            roleLevel: source.roleLevel,
            email: source.email,
            isGuest: source.isGuest,
          }}
          path={path}
        />
      )}
      <span data-testid="reaches-reason" className="min-w-0 text-sm text-muted-foreground">{reasonFor(t, source.from)}</span>
      {source.isGuest && source.kind === "person" && (
        <Badge variant="outline" data-testid="guest-badge">{t("org.access.inspector.guest")}</Badge>
      )}
      <span className="ms-auto inline-flex items-center gap-1">
        <RoleBadge roleLevel={source.roleLevel} origin={{ kind: "inherited", from: [source.from] }} />
        {canOpen && (
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("org.access.places.openPlaceAriaLabel", { name: source.from.name })}
            onClick={() => onSelect(source.from)}
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        )}
      </span>
    </li>
  )
}

function TeamMark({ name, memberCount }: { name: string; memberCount: number }) {
  const t = useT()
  const Icon = PLACE_ICON.team
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden data-place-icon="team" />
      <span className="truncate">{name}</span>
      <span className="font-normal text-muted-foreground">{t("org.teamsList.memberCount", { count: memberCount })}</span>
    </span>
  )
}

function PersonName({ person, path }: { person: DirectGrantee; path: ScopeRef[] }) {
  const chip = (
    <UserChip userId={person.userId} username={person.displayName} size="xs" nameClassName="text-sm font-normal" />
  )
  if (person.source === "invite" || person.userId.startsWith("invite:")) return chip
  return (
    <MemberInspectorTrigger userId={person.userId} username={person.displayName} from={inspectorFrom(path)} herePath={path}>
      {chip}
    </MemberInspectorTrigger>
  )
}

function inspectorFrom(path: ScopeRef[]): AccessFromScope {
  for (let i = path.length - 1; i >= 0; i--) {
    const scope = path[i]
    if (scope.type === "org" || scope.type === "team" || scope.type === "project") return { type: scope.type, id: scope.id }
  }
  return { type: "org", id: path[0]?.id ?? "" }
}

function reasonFor(t: TFunction, from: ScopeRef): string {
  if (from.type === "project") return t("org.access.places.viaProject", { name: from.name })
  if (from.type === "team") return t("org.access.places.fromTeam", { name: from.name })
  if (from.type === "org") return t("org.access.places.fromOrg", { name: from.name })
  return t("org.access.places.fromPlace", { name: from.name })
}

function inviteStatus(t: TFunction, expiresAt: string | null): string {
  const pending = t("org.access.places.invitePending")
  if (!expiresAt) return pending
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return t("org.membersPage.orgPage.expired")
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${pending}, ${t("org.membersPage.orgPage.expiresInMinutes", { count: minutes })}`
  const hours = Math.max(1, Math.round(ms / 3_600_000))
  if (hours < 48) return `${pending}, ${t("org.membersPage.orgPage.expiresInHours", { count: hours })}`
  return `${pending}, ${t("org.membersPage.orgPage.expiresInDays", { count: Math.max(1, Math.round(ms / 86_400_000)) })}`
}

function locate(
  nodes: AccessTreeNode[],
  key: string | null,
  path: ScopeRef[] = [],
): { node: AccessTreeNode; path: ScopeRef[] } | null {
  if (!key) return null
  for (const node of nodes) {
    const here = [...path, node.scope]
    if (placeParam(node.scope) === key) return { node, path: here }
    const child = locate(node.children, key, here)
    if (child) return child
  }
  return null
}
