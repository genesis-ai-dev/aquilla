import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { AlertTriangle, Building2, Check, ChevronDown, Plus, SearchIcon, X } from "lucide-react"
import { useActiveOrg, type GuestOrg } from "@/context/OrgContext"
import { isOrgScopedRoute } from "./org-route-scope"
import { OrgCreateDialog } from "./OrgCreateDialog"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { RoleLabel } from "@/components/RoleLabel"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  ALL_ORGS_PARAM,
  orgHomePath,
  swapOrgInPath,
} from "@/lib/navigation/org-paths"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useT } from "@/lib/i18n/I18nProvider"

const ORG_MENU_ITEM_CLASS =
  // hover: only — Base UI highlight-on-hover would steal focus from the search input.
  "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-0 gap-x-2 px-2 py-1.5 hover:bg-accent"

/** Muted meta (role / "All projects") — `!` beats menu `focus:**:text-accent-foreground`. */
const ORG_MENU_META_CLASS = "text-xs text-muted-foreground!"

/** ~10 org rows (py-1.5 + text-sm ≈ 2rem each). */
const ORG_LIST_MAX_HEIGHT_CLASS = "max-h-80"

function orgMatchesSearch(name: string, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return name.toLocaleLowerCase().includes(normalized)
}

function byName(a: { name: string | null }, b: { name: string | null }) {
  return (a.name ?? "").localeCompare(b.name ?? "")
}

function OrgMark({
  name,
  allOrgs = false,
  create = false,
}: {
  name: string
  allOrgs?: boolean
  create?: boolean
}) {
  if (create) {
    return (
      <InitialsAvatar
        name={name}
        size="xs"
        shape="square"
        menuSafe
        menuSafeColor="var(--muted-foreground)"
        fallbackClassName="bg-muted"
      >
        <Plus className="size-3 text-muted-foreground!" aria-hidden />
      </InitialsAvatar>
    )
  }
  if (allOrgs) {
    return (
      <InitialsAvatar
        name={name}
        size="xs"
        shape="square"
        menuSafe
        menuSafeColor="#000"
        fallbackClassName="bg-primary"
      >
        {/* color on the SVG itself — menu `focus:**:text-accent-foreground` paints
            descendants light on press; parent color alone cannot beat that. */}
        <Building2 className="size-3 text-black!" color="#000" aria-hidden />
      </InitialsAvatar>
    )
  }
  return (
    <InitialsAvatar name={name} size="xs" shape="square" menuSafe />
  )
}

export function OrgSwitcher() {
  const {
    orgs, activeOrg, activeOrgId, activeGuestOrg, isAllOrgs, guestOrgs,
    setActiveOrg, setAllOrgs, refresh, error, retryOrgLoad,
    accessibleProjectsError, refreshAccessibleProjects,
  } = useActiveOrg()
  const t = useT()
  const location = useLocation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // AQU-759: keep both member and guest lists alphabetical regardless of the
  // order the backend returned them in (Joel: "Keep it alphabetical").
  const sortedOrgs = useMemo(() => [...orgs].sort(byName), [orgs])
  const sortedGuestOrgs = useMemo(() => [...guestOrgs].sort(byName), [guestOrgs])

  useEffect(() => {
    if (!open) return
    // Keep typing in the filter; menu open otherwise focuses the first item.
    queueMicrotask(() => searchInputRef.current?.focus())
  }, [open])

  // AQU-790: a guest org now uses the same path convention as an owned org
  // (`/orgs/<id>`). It still isn't a membership, so it never becomes `activeOrg`
  // (that would misrepresent the caller's role — AQU-473/AQU-624); instead the
  // context derives `activeGuestOrg` from the active id, which survives
  // reload/back-forward and drives the checkmark + trigger label below.
  const selectedGuest = activeGuestOrg
  const selectedGuestOrgId = activeGuestOrg?.id ?? null
  const guestSelected = selectedGuest != null

  const showAllOrgs = orgs.length > 1
  const title = guestSelected
    ? selectedGuest.name ?? `Org #${selectedGuest.id}`
    : isAllOrgs
      ? t("org.breadcrumb.allOrganizations")
      : activeOrg?.name ?? t("org.switcher.workspaceFallback")

  const filteredOrgs = useMemo(
    () => sortedOrgs.filter((o) => orgMatchesSearch(o.name ?? t("org.switcher.workspaceFallback"), search)),
    [sortedOrgs, search],
  )
  const filteredGuestOrgs = useMemo(
    () => sortedGuestOrgs.filter((g) => orgMatchesSearch(g.name ?? `Org #${g.id}`, search)),
    [sortedGuestOrgs, search],
  )
  const showAllOrgsRow = showAllOrgs && search.trim() === ""
  // AQU-883: the guest-org failure row below stands in for the guest section,
  // so the list isn't empty when it is showing.
  const listEmpty =
    !showAllOrgsRow && filteredOrgs.length === 0 && filteredGuestOrgs.length === 0
    && !accessibleProjectsError

  function retryProjectDirectory() {
    void refreshAccessibleProjects()
  }

  // AQU-882: a failed org load leaves no activeOrg, no all-orgs scope and no
  // guest orgs, so the check below used to unmount the switcher outright —
  // removing the only chrome the user could have recovered from and leaving a
  // full page reload as the sole way to re-issue the fetch. Hold the slot with
  // a retry affordance instead. Checked before the empty-membership case so a
  // failure never reads as "you have no organizations" — and before the
  // directory-failure case below, because retryOrgLoad re-issues both fetches.
  if (error) {
    return (
      <button
        type="button"
        data-testid="org-switcher-error"
        aria-label="Retry loading organizations"
        onClick={() => { void retryOrgLoad() }}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent"
      >
        <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Couldn’t load organizations
        </span>
        <span className="shrink-0 text-xs font-medium underline">Retry</span>
      </button>
    )
  }

  // AQU-883: guest orgs are derived entirely from the project directory, so a
  // failed directory fetch presents exactly like "you are a guest nowhere". For
  // a project-only invitee that also trips the unmount below, removing the last
  // affordance that could re-issue the fetch. Hold the slot with a retry
  // instead — checked before the unmount so a failure never reads as "no
  // organizations".
  if (accessibleProjectsError && !activeOrg && !isAllOrgs && guestOrgs.length === 0) {
    return (
      <button
        type="button"
        data-testid="org-switcher-projects-error"
        aria-label="Retry loading shared organizations"
        onClick={retryProjectDirectory}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent"
      >
        <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Couldn’t load shared organizations
        </span>
        <span className="shrink-0 text-xs font-medium underline">Retry</span>
      </button>
    )
  }

  // AQU-473: a project-only invitee has zero member orgs but may still have
  // guest orgs to switch into — don't hide the whole switcher for them.
  if (!activeOrg && !isAllOrgs && guestOrgs.length === 0) return null

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) setSearch("")
  }

  function handleAllOrgs() {
    setAllOrgs()
    setOpen(false)
    navigate(swapOrgInPath(location.pathname, ALL_ORGS_PARAM))
  }

  function handleActiveOrg(orgId: number) {
    setActiveOrg(orgId)
    setOpen(false)
    // A guest org overview (`/orgs/<guestId>`) is itself an org-scoped route, so
    // swapOrgInPath swaps to the picked member org's overview — symmetric with
    // picking a guest org, and no special-casing needed.
    if (isOrgScopedRoute(location.pathname) || location.pathname === "/") {
      navigate(swapOrgInPath(location.pathname, orgId))
    }
  }

  // AQU-790: guest orgs use the same path convention as owned orgs
  // (`/orgs/<id>`). Selecting one records it as the active scope (persisted for
  // reload, which drives `activeGuestOrg`) and navigates to that org's overview
  // — no longer the divergent `/shared?org=<id>` query param.
  function handleGuestOrg(org: GuestOrg) {
    setActiveOrg(org.id)
    setOpen(false)
    navigate(orgHomePath(org.id))
  }

  async function handleCreated(orgId: number) {
    await refresh()
    setActiveOrg(orgId)
    if (isOrgScopedRoute(location.pathname) || location.pathname === "/") {
      navigate(swapOrgInPath(location.pathname, orgId))
    } else {
      navigate(orgHomePath(orgId))
    }
  }

  function openCreateDialog() {
    setOpen(false)
    setCreateDialogOpen(true)
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange} highlightItemOnHover={false}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t("org.switcher.triggerAriaLabel", { org: title })}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent"
            />
          }
        >
          <OrgMark name={title} allOrgs={!guestSelected && isAllOrgs} />
          <span className="truncate">{title}</span>
          <ChevronDown className="ms-auto size-4 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-72 overflow-hidden rounded-lg p-0 flex flex-col"
          align="start"
          side="bottom"
          sideOffset={4}
        >
          {/* Icon column matches list rows: p-1 + px-2 inset, then 1.25rem avatar slot. */}
          <InputGroup className="h-10 w-auto rounded-none border-0 bg-transparent shadow-none outline-none dark:bg-transparent ring-0 hover:border-0! focus-within:border-0! has-[[data-slot=input-group-control]:focus-visible]:border-0! has-[[data-slot=input-group-control]:focus-visible]:ring-0!">
            <InputGroupAddon
              align="inline-start"
              className="ms-3 w-5 justify-center p-0!"
            >
              <SearchIcon className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchInputRef}
              placeholder={t("org.switcher.searchPlaceholder")}
              aria-label={t("org.switcher.searchAriaLabel")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  handleOpenChange(false)
                  return
                }
                e.stopPropagation()
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {search ? (
              <InputGroupAddon
                align="inline-end"
                // Match Create row inset (list `p-1` + item `px-2`); kill addon’s
                // default `has-[>button]:me-[-0.3rem]` that pulls the X flush.
                className="p-0! pe-2! has-[>button]:me-0!"
              >
                <InputGroupButton
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("org.switcher.clearSearchAriaLabel")}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSearch("")
                    searchInputRef.current?.focus()
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <DropdownMenuSeparator className="mx-0 my-0" />
          <div
            role="presentation"
            className={`${ORG_LIST_MAX_HEIGHT_CLASS} overflow-y-auto overscroll-contain p-1 scrollbar-thin flex-1 flex flex-col`}
          >
            {listEmpty ? (
              <Empty className="min-h-32 border-0 p-4 gap-2">
                <EmptyHeader>
                  <EmptyMedia
                    variant="icon"
                    className="mb-0 border border-border bg-transparent text-muted-foreground"
                  >
                    <SearchIcon />
                  </EmptyMedia>
                  <EmptyTitle className="text-muted-foreground font-normal">
                    {t("org.switcher.noOrganizationsFound")}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <DropdownMenuGroup>
                  {showAllOrgsRow && (
                    <DropdownMenuItem
                      className={`${ORG_MENU_ITEM_CLASS} focus:[&_[data-slot=avatar]_svg]:text-black! data-highlighted:[&_[data-slot=avatar]_svg]:text-black!`}
                      onClick={handleAllOrgs}
                    >
                      <OrgMark name={t("org.breadcrumb.allOrganizations")} allOrgs />
                      <span className="truncate">{t("org.breadcrumb.allOrganizations")}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className={ORG_MENU_META_CLASS}>{t("org.switcher.allProjects")}</span>
                        {!guestSelected && isAllOrgs && <Check className="size-4 opacity-60" />}
                      </span>
                    </DropdownMenuItem>
                  )}
                  {filteredOrgs.map((o) => {
                    const name = o.name ?? t("org.switcher.workspaceFallback")
                    const selected = !guestSelected && activeOrgId === o.id
                    return (
                      <DropdownMenuItem
                        key={o.id}
                        className={ORG_MENU_ITEM_CLASS}
                        onClick={() => handleActiveOrg(o.id)}
                      >
                        <OrgMark name={name} />
                        <span className="truncate">{name}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <RoleLabel name={o.role.name} className={ORG_MENU_META_CLASS} />
                          {selected && <Check className="size-4 opacity-60" />}
                        </span>
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuGroup>
                {/* AQU-883: the guest section is populated from the project
                    directory. When that fetch failed we don't know whether the
                    caller has guest orgs, so say so and offer a retry rather
                    than rendering the section as legitimately empty. A plain
                    button (not a DropdownMenuItem) keeps the menu open so the
                    recovered orgs appear in place. */}
                {accessibleProjectsError ? (
                  <>
                    <DropdownMenuSeparator className="mx-0 my-1" />
                    <div
                      role="presentation"
                      data-testid="guest-orgs-error"
                      className="px-2 py-2"
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          Couldn’t load shared organizations
                        </span>
                        <button
                          type="button"
                          aria-label="Retry loading shared organizations"
                          className="shrink-0 text-xs font-medium underline"
                          onClick={(e) => {
                            e.stopPropagation()
                            retryProjectDirectory()
                          }}
                        >
                          Retry
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}
                {filteredGuestOrgs.length > 0 && (
                  <>
                    <DropdownMenuSeparator className="mx-0 my-1" />
                    <DropdownMenuGroup data-testid="guest-orgs">
                      {filteredGuestOrgs.map((g) => (
                        <DropdownMenuItem
                          key={g.id}
                          className={ORG_MENU_ITEM_CLASS}
                          onClick={() => handleGuestOrg(g)}
                        >
                          <OrgMark name={g.name ?? `Org #${g.id}`} />
                          <span className="truncate">{g.name ?? `Org #${g.id}`}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <RoleLabel name="guest" className={ORG_MENU_META_CLASS} />
                            {selectedGuestOrgId === g.id && <Check className="size-4 opacity-60" />}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </>
                )}
              </>
            )}
          </div>
          <DropdownMenuSeparator className="mx-0 my-0" />
          <div role="presentation" className="p-1">
            <DropdownMenuItem className={ORG_MENU_ITEM_CLASS} onClick={openCreateDialog}>
              <OrgMark name={t("org.switcher.create")} create />
              <span className="truncate text-muted-foreground!">{t("org.switcher.create")}</span>
              <span aria-hidden />
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <OrgCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={(orgId) => void handleCreated(orgId)}
      />
    </>
  )
}
