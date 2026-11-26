/**
 * The avatars beside a folder in the People & access tree: the people added
 * at that place, three at most and then "+n". Hovering or focusing the stack
 * spreads it out and opens a list: the people added here, each with a role
 * dropdown and a remove button where the viewer may change them, and then
 * everyone who reaches the place from a folder above, read-only, with the
 * folder it comes from. The viewer is marked "You" in both lists.
 */
import { useState } from "react"
import { UserMinus } from "lucide-react"
import { Link } from "react-router-dom"

import { PLACE_ICON } from "@/components/access/place-icons"
import { RoleBadge } from "@/components/access/RoleBadge"
import { UserChip } from "@/components/UserChip"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { inviteRowId, rowEdit, rowGrant, rowRemoval } from "@/lib/access/edit-access"
import { accessPersonPath } from "@/lib/navigation/org-paths"
import type { PlaceGrantability } from "@/lib/access/grant-rules"
import type { GrantOrigin, ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

import { editDeniedText } from "./edit-access-text"
import { inheritedAccess, type FolderNode } from "./folder-tree"
import type { DirectGrantee } from "./org-access-data"
import type { RemoveAccessDialogProps } from "./RemoveAccessDialog"
import { RoleDropdown } from "./RoleDropdown"

const STACK_MAX = 3
// Inherited style without the pill naming the place: the line under the name already says where it comes from.
const INHERITED: GrantOrigin = { kind: "inherited", from: [] }

export type Removing = Pick<RemoveAccessDialogProps, "person" | "grants">

/** What the stack needs to show and edit the grants at one place. */
export interface FolderEditing {
  orgId: number
  grantable: Record<string, PlaceGrantability> | undefined
  /** Account id → username, for the avatar marks and to tell the viewer's own rows apart. */
  usernames: ReadonlyMap<string, string | null>
  viewerUsername: string | null
  onChanged: () => void
  onRemove: (removing: Removing) => void
}

export function FolderPeopleStack({ folder, editing }: { folder: FolderNode; editing: FolderEditing }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const direct = folder.node.directGrantees
  const { people: inherited, teams } = inheritedAccess(direct, folder.node.inherited ?? [])
  if (direct.length === 0 && inherited.length === 0 && teams.length === 0) return null

  const shown = open ? direct : direct.slice(0, STACK_MAX)
  const extra = open ? 0 : direct.length - shown.length
  const isViewer = (userId: string) => {
    const username = editing.usernames.get(userId)
    return username != null && username === editing.viewerUsername
  }
  const name = folder.node.scope.name
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={200}
        aria-label={t("org.access.tree.peopleAt", { count: direct.length, place: name })}
        data-testid="folder-people"
        className="flex min-h-8 items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {direct.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("org.access.tree.nobodyHere")}</span>
        ) : (
          <AvatarGroup className={cn("transition-[gap]", open ? "gap-1 space-x-0" : "-space-x-1.5")}>
            {shown.map((person) => (
              <UserChip
                key={person.userId}
                userId={person.userId}
                username={editing.usernames.get(person.userId) ?? person.displayName}
                size="sm"
                avatarOnly
              />
            ))}
            {extra > 0 && (
              <AvatarGroupCount className="size-6 text-[10px] font-semibold" data-testid="folder-people-more">+{extra}</AvatarGroupCount>
            )}
          </AvatarGroup>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(28rem,70vh)] w-80 overflow-y-auto p-2" data-testid="folder-people-list">
        <p className="px-1.5 pt-0.5 text-xs font-medium text-muted-foreground">
          {t("org.access.tree.addedHere", { count: direct.length })}
        </p>
        {direct.length === 0 ? (
          <p className="px-1.5 text-sm text-muted-foreground">{t("org.access.page.noDirect")}</p>
        ) : (
          <ul className="flex flex-col">
            {direct.map((person) => (
              <DirectRow key={person.userId} person={person} path={folder.path} editing={editing} isYou={isViewer(person.userId)} />
            ))}
          </ul>
        )}
        {(inherited.length > 0 || teams.length > 0) && (
          <>
            <p className="mt-1 border-t px-1.5 pt-2 text-xs font-medium text-muted-foreground">
              {t("org.access.tree.fromAbove", { count: inherited.length + teams.length })}
            </p>
            <ul className="flex flex-col" data-testid="folder-people-inherited">
              {teams.map((team) => (
                <TeamRow key={`team:${team.team.id}`} team={team.team} roleLevel={team.roleLevel} memberCount={team.memberCount} />
              ))}
              {inherited.map((person) => (
                <li key={person.userId} data-testid="inherited-person" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
                  <UserChip userId={person.userId} username={editing.usernames.get(person.userId) ?? person.displayName} size="xs" avatarOnly />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm">
                      <PersonName orgId={editing.orgId} userId={person.userId} name={person.displayName} />
                      {isViewer(person.userId) && <YouTag />}
                      {person.isGuest && <Badge variant="outline">{t("org.access.inspector.guest")}</Badge>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{t("org.access.tree.from", { name: person.from.name })}</span>
                  </span>
                  <RoleBadge roleLevel={person.roleLevel} origin={INHERITED} />
                </li>
              ))}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A name opens that person's page on People & access: everywhere they can go, and why. */
function PersonName({ orgId, userId, name }: { orgId: number; userId: string; name: string }) {
  const t = useT()
  return (
    <Link
      to={accessPersonPath(orgId, userId)}
      aria-label={t("org.access.people.openPersonAriaLabel", { name })}
      className="min-w-0 truncate rounded hover:underline"
    >
      {name}
    </Link>
  )
}

function YouTag() {
  const t = useT()
  return (
    <span data-testid="you-tag" className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
      {t("org.access.tree.you")}
    </span>
  )
}

function TeamRow({ team, roleLevel, memberCount }: { team: ScopeRef; roleLevel: number; memberCount: number }) {
  const t = useT()
  const Icon = PLACE_ICON.team
  return (
    <li data-testid="inherited-team" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{t("org.access.places.fromTeam", { name: team.name })}</span>
        <span className="text-xs text-muted-foreground">{t("org.teamsList.memberCount", { count: memberCount })}</span>
      </span>
      <RoleBadge roleLevel={roleLevel} origin={INHERITED} />
    </li>
  )
}

/** One person added at this place: their role as a dropdown where it may change, and a remove button. */
function DirectRow({ person, path, editing, isYou }: { person: DirectGrantee; path: ScopeRef[]; editing: FolderEditing; isYou: boolean }) {
  const t = useT()
  const place = path[path.length - 1]
  const username = editing.usernames.get(person.userId) ?? null
  const origin: GrantOrigin = person.source === "creator" ? { kind: "creator" } : { kind: "direct" }
  const edit = rowEdit(place, person, editing.grantable, isYou)
  const removal = rowRemoval(place, path, person, editing.grantable, isYou)
  const inviteId = person.source === "invite" ? inviteRowId(place, path, person.userId) : null
  const grant = person.source === "invite" ? null : rowGrant(place)
  const canRemove = removal.ok && (inviteId != null || grant != null)
  const denied = removal.ok ? null : editDeniedText(t, removal.reason, removal.cap)
  const label = person.source === "invite"
    ? t("org.access.edit.cancelInvite", { email: person.email ?? person.displayName })
    : t("org.access.edit.remove", { name: person.displayName })
  const remove = () => {
    if (inviteId) editing.onRemove({ person: { inviteId, email: person.email ?? person.displayName }, grants: [] })
    else if (grant) editing.onRemove({ person: { userId: person.userId, displayName: person.displayName }, grants: [grant] })
  }
  const button = (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled={!canRemove} onClick={remove} data-testid="remove-grant">
      <UserMinus aria-hidden />
    </Button>
  )
  return (
    <li data-testid="direct-person" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
      <UserChip userId={person.userId} username={username ?? person.displayName} size="xs" avatarOnly />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {person.source === "invite" || person.userId.startsWith("invite:")
          ? <span className="truncate">{person.email ?? person.displayName}</span>
          : <PersonName orgId={editing.orgId} userId={person.userId} name={person.displayName} />}
        {isYou && <YouTag />}
        {person.isGuest && <Badge variant="outline">{t("org.access.inspector.guest")}</Badge>}
        {person.pendingInvite && <Badge variant="outline">{t("org.access.places.invitePending")}</Badge>}
      </span>
      <RoleDropdown
        orgId={editing.orgId}
        place={place}
        path={path}
        person={{ userId: person.userId, displayName: person.displayName, username }}
        roleLevel={person.roleLevel}
        origin={origin}
        lanes={person.lanes?.map((l) => l.name)}
        edit={edit}
        onChanged={editing.onChanged}
      />
      {canRemove || !denied ? button : <AppTooltip content={denied}>{button}</AppTooltip>}
    </li>
  )
}
