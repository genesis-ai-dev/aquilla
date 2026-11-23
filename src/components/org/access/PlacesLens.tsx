import { useMemo, useState } from "react"
import { UserMinus, UserPlus } from "lucide-react"
import { useSearchParams } from "react-router-dom"

import { MemberInspectorTrigger } from "@/components/access/MemberInspectorTrigger"
import { PLACE_ICON } from "@/components/access/place-icons"
import { RoleBadge } from "@/components/access/RoleBadge"
import { ScopeBreadcrumb } from "@/components/access/ScopeBreadcrumb"
import { UserChip } from "@/components/UserChip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { inviteRowId, rowEdit, rowGrant, rowRemoval } from "@/lib/access/edit-access"
import type { PlaceGrantability } from "@/lib/access/grant-rules"
import { filterPlaceTree, placeParam, placeRowCounts } from "@/lib/access/place-lens"
import { formatScopePath } from "@/lib/access/scope-path"
import type { GrantOrigin, ScopeRef } from "@/lib/access/types"
import type { AccessFromScope } from "@/lib/sync/access-read"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

import { accessNodeId } from "./access-anchors"
import type { AccessTreeNode, DirectGrantee, InheritedSource, OrgAccessPerson } from "./org-access-data"
import { RemoveAccessDialog, type RemoveAccessDialogProps } from "./RemoveAccessDialog"
import { editDeniedText } from "./edit-access-text"
import { RoleDropdown } from "./RoleDropdown"

/**
 * AQU-2321: what the lens needs to edit direct grants. Absent: the lens is
 * read-only (every pill a plain badge, no ×).
 */
export interface PlaceEditing {
  orgId: number
  grantable: Record<string, PlaceGrantability> | undefined
  people: OrgAccessPerson[]
  /** The signed-in viewer's username, to tell their own rows apart. */
  viewerUsername: string | null
  /** After a role change or a removal wrote something. The page re-reads the lens. */
  onChanged: () => void
}

type Removing = Pick<RemoveAccessDialogProps, "person" | "grants">
interface RowEditing extends PlaceEditing {
  usernames: ReadonlyMap<string, string | null>
  onRemove: (removing: Removing) => void
}

const PLACE_KIND = {
  org: "org.access.places.kindOrg",
  team: "org.access.scope.team",
  project: "org.access.scope.project",
  lane: "org.access.scope.lane",
} as const

/**
 * AQU-2318: the Places lens. The tree is every place the server says this
 * person can see; the detail is the grants at the selected place and the
 * ancestor grants that resolve to it. "Give access" hands the selected place
 * to `onGiveAccess` (AQU-2320), and is disabled when that is absent (the
 * viewer may grant nowhere). With `editing` (AQU-2321) a direct row's pill is
 * a role dropdown and its × opens the Remove dialog; inherited rows stay
 * read-only and point at the place they are set at.
 */
export function PlacesLens({
  tree,
  query,
  onGiveAccess,
  editing,
}: {
  tree: AccessTreeNode[]
  query: string
  onGiveAccess?: (place: ScopeRef) => void
  editing?: PlaceEditing
}) {
  const t = useT()
  const [params, setParams] = useSearchParams()
  // One Remove dialog for the whole lens, told which row it is for.
  const [removing, setRemoving] = useState<Removing | null>(null)
  const people = editing?.people
  const usernames = useMemo(() => new Map((people ?? []).map((p) => [p.userId, p.username ?? null])), [people])
  const rowEditing: RowEditing | undefined = editing ? { ...editing, usernames, onRemove: setRemoving } : undefined
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
        {selected && (
          <PlaceDetail node={selected.node} path={selected.path} onSelect={select} tree={tree} onGiveAccess={onGiveAccess} editing={rowEditing} />
        )}
      </div>
      {editing && removing && (
        <RemoveAccessDialog
          open
          onOpenChange={(open) => { if (!open) setRemoving(null) }}
          orgId={editing.orgId}
          person={removing.person}
          grants={removing.grants}
          onRemoved={editing.onChanged}
        />
      )}
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
  onGiveAccess,
  editing,
}: {
  node: AccessTreeNode
  path: ScopeRef[]
  tree: AccessTreeNode[]
  onSelect: (scope: ScopeRef) => void
  onGiveAccess?: (place: ScopeRef) => void
  editing?: RowEditing
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
        {/* AQU-2320: opens the Give access dialog with this place filled in. */}
        <Button type="button" size="sm" disabled={!onGiveAccess} onClick={() => onGiveAccess?.(node.scope)} data-testid="give-access-open">
          <UserPlus aria-hidden />
          {t("org.access.places.giveAccess")}
        </Button>
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
              <GrantedRow key={person.userId} person={person} path={path} editing={editing} />
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

function GrantedRow({ person, path, editing }: { person: DirectGrantee; path: ScopeRef[]; editing?: RowEditing }) {
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
      <span className="ms-auto inline-flex items-center gap-1">
        {editing ? <GrantedRowEdit person={person} path={path} origin={origin} editing={editing} /> : <RoleBadge roleLevel={person.roleLevel} origin={origin} />}
      </span>
    </li>
  )
}

/** The direct row's role dropdown and its ×. */
function GrantedRowEdit({ person, path, origin, editing }: { person: DirectGrantee; path: ScopeRef[]; origin: GrantOrigin; editing: RowEditing }) {
  const t = useT()
  const place = path[path.length - 1]
  const username = editing.usernames.get(person.userId) ?? null
  const isSelf = username != null && username === editing.viewerUsername
  const edit = rowEdit(place, person, editing.grantable, isSelf)
  const removal = rowRemoval(place, path, person, editing.grantable, isSelf)
  const inviteId = person.source === "invite" ? inviteRowId(place, path, person.userId) : null
  const grant = person.source === "invite" ? null : rowGrant(place)
  const canRemove = removal.ok && (inviteId != null || grant != null)
  const label = person.source === "invite"
    ? t("org.access.edit.cancelInvite", { email: person.email ?? person.displayName })
    : t("org.access.edit.remove", { name: person.displayName })
  const open = () => {
    if (inviteId) editing.onRemove({ person: { inviteId, email: person.email ?? person.displayName }, grants: [] })
    else if (grant) editing.onRemove({ person: { userId: person.userId, displayName: person.displayName }, grants: [grant] })
  }
  const button = (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled={!canRemove} onClick={open} data-testid="remove-grant">
      <UserMinus aria-hidden />
    </Button>
  )
  return (
    <>
      <RoleDropdown
        orgId={editing.orgId}
        place={place}
        path={path}
        person={{ userId: person.userId, displayName: person.displayName, username }}
        roleLevel={person.roleLevel}
        origin={origin}
        edit={edit}
        onChanged={editing.onChanged}
      />
      {canRemove ? button : (
        <AppTooltip content={removal.ok ? editDeniedText(t, "lane_needs_staffing", null) : editDeniedText(t, removal.reason, removal.cap)}>
          {button}
        </AppTooltip>
      )}
    </>
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
        {/* AQU-2321: never a dropdown. It names where the grant is set, and going there is how to change it. */}
        <AppTooltip content={t("org.access.inherited.tooltip", { path: formatScopePath([source.from]) })}>
          {canOpen ? (
            <button
              type="button"
              className="inline-flex rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label={t("org.access.places.openPlaceAriaLabel", { name: source.from.name })}
              data-testid="inherited-source"
              onClick={() => onSelect(source.from)}
            >
              <RoleBadge roleLevel={source.roleLevel} origin={{ kind: "inherited", from: [source.from] }} />
            </button>
          ) : (
            <span className="inline-flex" data-testid="inherited-source">
              <RoleBadge roleLevel={source.roleLevel} origin={{ kind: "inherited", from: [source.from] }} />
            </span>
          )}
        </AppTooltip>
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
