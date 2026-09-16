import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { AlertTriangle, Building2, Check, Plus, SearchIcon } from "lucide-react"
import { useActiveOrg, type GuestOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin"
import { useOrgSwitcherCatalog } from "@/hooks/useOrgSwitcherCatalog"
import { Spinner } from "@/components/ui/spinner"
import { isOrgScopedRoute } from "./org-route-scope"
import { OrgCreateDialog } from "./OrgCreateDialog"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { RoleLabel } from "@/components/RoleLabel"
import type { OrgSummary } from "@/lib/frontier/orgs"
import {
  ALL_ORGS_PARAM,
  orgHomePath,
  orgProjectsPath,
  parseOrgPath,
  swapOrgInPath,
} from "@/lib/navigation/org-paths"
import { cn } from "@/lib/utils"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useI18n } from "@/lib/i18n/I18nProvider"

// Trailing check is in-flow only on the selected row — do not reserve `pr-8`
// on every option (that left a blank gap beside unselected role labels).
const ORG_ITEM_CLASS =
  "grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-1.5"

/** Muted meta (role / "All projects") — `!` beats item `data-highlighted:**:text-accent-foreground`. */
const ORG_META_CLASS = "text-xs text-muted-foreground!"

type OrgSwitcherItem =
  | { kind: "all"; key: "all"; label: string }
  | {
      kind: "member"
      key: `member:${number}`
      id: number
      label: string
      roleName: string
      /** Cross-tenant visibility via ADMIN_EMAILS — not a ladder role. */
      viaPlatformAdmin?: boolean
    }
  | {
      kind: "guest"
      key: `guest:${number}`
      id: number
      label: string
    }

function orgMatchesSearch(name: string, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return name.toLocaleLowerCase().includes(normalized)
}

function byName(a: { name: string | null }, b: { name: string | null }) {
  return (a.name ?? "").localeCompare(b.name ?? "")
}

function memberItem(org: OrgSummary): OrgSwitcherItem {
  return {
    kind: "member",
    key: `member:${org.id}`,
    id: org.id,
    label: org.name ?? "Workspace",
    roleName: org.role.name,
    viaPlatformAdmin: org.viaPlatformAdmin,
  }
}

function guestItem(org: GuestOrg): OrgSwitcherItem {
  return {
    kind: "guest",
    key: `guest:${org.id}`,
    id: org.id,
    label: org.name ?? `Org #${org.id}`,
  }
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
        {/* color on the SVG itself — item `data-highlighted:**:text-accent-foreground`
            paints descendants light; parent color alone cannot beat that. */}
        <Building2 className="size-3 text-black!" color="#000" aria-hidden />
      </InitialsAvatar>
    )
  }
  return (
    <InitialsAvatar name={name} size="xs" shape="square" menuSafe />
  )
}

function OrgSwitcherList({
  guestSelected,
  isAllOrgs,
  activeOrgId,
  selectedGuestOrgId,
  directoryError,
  onRetryDirectory,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  guestSelected: boolean
  isAllOrgs: boolean
  activeOrgId: number | null
  selectedGuestOrgId: number | null
  directoryError: string | null
  onRetryDirectory: () => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}) {
  const { t } = useI18n()
  const filtered = ComboboxPrimitive.useFilteredItems<OrgSwitcherItem>()
  const members = filtered.filter((item) => item.kind !== "guest")
  const guests = filtered.filter((item) => item.kind === "guest")

  return (
    <>
      {members.length > 0 && (
        <ComboboxGroup aria-label={t("org.orgHome.organizations")}>
          {members.map((item) => (
            <OrgSwitcherOption
              key={item.key}
              item={item}
              selected={
                item.kind === "all"
                  ? !guestSelected && isAllOrgs
                  : !guestSelected && activeOrgId === item.id
              }
            />
          ))}
        </ComboboxGroup>
      )}
      {/* AQU-883: the guest section is populated from the project
          directory. When that fetch failed we don't know whether the
          caller has guest orgs, so say so and offer a retry rather
          than rendering the section as legitimately empty. A plain
          button (not a ComboboxItem) keeps the menu open so the
          recovered orgs appear in place. */}
      {directoryError ? (
        <>
          {members.length > 0 && (
            <ComboboxSeparator className="mx-0 my-1" />
          )}
          <div
            role="presentation"
            data-testid="guest-orgs-error"
            className="px-2 py-2"
          >
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {t("org.switcher.couldNotLoadSharedOrganizations")}
              </span>
              <button
                type="button"
                aria-label={t("org.switcher.retrySharedOrganizationsAriaLabel")}
                className="shrink-0 text-xs font-medium underline"
                onPointerDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation()
                  onRetryDirectory()
                }}
              >
                {t("common.retry")}
              </button>
            </div>
          </div>
        </>
      ) : null}
      {guests.length > 0 && (
        <>
          {(members.length > 0 || directoryError) && (
            <ComboboxSeparator
              className="mx-0 my-1"
              data-testid="guest-orgs-separator"
            />
          )}
          <ComboboxGroup aria-label={t("org.switcher.guestOrganizationsGroupLabel")} data-testid="guest-orgs">
            {guests.map((item) => (
              <OrgSwitcherOption
                key={item.key}
                item={item}
                selected={selectedGuestOrgId === item.id}
              />
            ))}
          </ComboboxGroup>
        </>
      )}
      {(hasMore || loadingMore) && (
        <LoadMoreSentinel
          disabled={!hasMore || loadingMore}
          loading={loadingMore}
          onVisible={onLoadMore}
        />
      )}
    </>
  )
}

function LoadMoreSentinel({
  disabled,
  loading,
  onVisible,
}: {
  disabled: boolean
  loading: boolean
  onVisible: () => void
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (disabled) return
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisible()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [disabled, onVisible])

  return (
    <div
      ref={ref}
      role="status"
      data-testid="org-switcher-load-more"
      className="flex items-center justify-center gap-2 px-2 py-2 text-xs text-muted-foreground"
    >
      {loading ? (
        <>
          <Spinner />
          {t("common.loading")}
        </>
      ) : (
        <span className="sr-only">{t("common.loading")}</span>
      )}
    </div>
  )
}

function OrgSwitcherOption({
  item,
  selected,
}: {
  item: OrgSwitcherItem
  selected: boolean
}) {
  const { t } = useI18n()
  return (
    <ComboboxItem
      value={item}
      // Role + check share the trailing column; omit the absolute ItemIndicator
      // so unselected rows are not padded for an empty check slot.
      showIndicator={false}
      className={cn(
        ORG_ITEM_CLASS,
        item.kind === "all" &&
          "data-highlighted:[&_[data-slot=avatar]_svg]:text-black!",
      )}
      aria-selected={selected}
    >
      <OrgMark name={item.label} allOrgs={item.kind === "all"} />
      <span className="truncate">{item.label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {item.kind === "all" ? (
          <span className={ORG_META_CLASS}>{t("org.switcher.allProjects")}</span>
        ) : item.kind === "member" && (item.viaPlatformAdmin || item.roleName === "admin") ? (
          <span className={ORG_META_CLASS}>{t("org.orgSidebar.admin")}</span>
        ) : item.kind === "member" ? (
          <RoleLabel name={item.roleName} plain className={ORG_META_CLASS} />
        ) : (
          <span className={ORG_META_CLASS}>{t("org.switcher.guestRole")}</span>
        )}
        {selected && (
          <Check className="size-4 shrink-0" aria-hidden />
        )}
      </span>
    </ComboboxItem>
  )
}

export function OrgSwitcher() {
  const { t } = useI18n()
  const {
    orgs,
    activeOrg,
    activeOrgId,
    activeGuestOrg,
    isAllOrgs,
    guestOrgs,
    setActiveOrg,
    setAllOrgs,
    refresh,
    error,
    retryOrgLoad,
    accessibleProjectsError,
    refreshAccessibleProjects,
  } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { isAdmin: isPlatformAdmin, loading: platformAdminLoading } = usePlatformAdmin()
  const location = useLocation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const catalogEnabled = open && isPlatformAdmin && !platformAdminLoading
  const catalog = useOrgSwitcherCatalog({
    jwt,
    open,
    enabled: catalogEnabled,
    query: inputValue,
  })

  // AQU-759: keep both member and guest lists alphabetical regardless of the
  // order the backend returned them in (Joel: "Keep it alphabetical").
  const sortedOrgs = useMemo(() => {
    const source = catalogEnabled ? catalog.orgs : orgs
    return [...source].sort(byName)
  }, [catalogEnabled, catalog.orgs, orgs])
  const sortedGuestOrgs = useMemo(() => [...guestOrgs].sort(byName), [guestOrgs])

  // AQU-790: a guest org now uses the same path convention as an owned org
  // (`/orgs/<id>`). It still isn't a membership, so it never becomes `activeOrg`
  // (that would misrepresent the caller's role — AQU-473/AQU-624); instead the
  // context derives `activeGuestOrg` from the active id, which survives
  // reload/back-forward and drives the checkmark + trigger label below.
  const selectedGuest = activeGuestOrg
  const selectedGuestOrgId = activeGuestOrg?.id ?? null
  const guestSelected = selectedGuest != null

  const onAllOrgsPath = parseOrgPath(location.pathname)?.orgKey === ALL_ORGS_PARAM
  // All organizations is the home for foreign-org grants as well as 2+
  // memberships, so offer it whenever there's something to aggregate beyond
  // a single member org.
  const showAllOrgs = orgs.length > 1 || guestOrgs.length > 0
  const viewingAllOrgs = !guestSelected && (isAllOrgs || onAllOrgsPath)
  const title = guestSelected
    ? selectedGuest.name ?? `Org #${selectedGuest.id}`
    : viewingAllOrgs
      ? t("org.breadcrumb.allOrganizations")
      : activeOrg?.name ?? "Workspace"

  const items = useMemo<OrgSwitcherItem[]>(() => {
    const next: OrgSwitcherItem[] = []
    if (showAllOrgs) next.push({ kind: "all", key: "all", label: t("org.breadcrumb.allOrganizations") })
    const seen = new Set<number>()
    const guestIds = new Set(sortedGuestOrgs.map((org) => org.id))
    for (const org of sortedOrgs) {
      if (guestIds.has(org.id)) continue
      seen.add(org.id)
      next.push(memberItem(org))
    }
    // Keep the selected catalog org in `items` while a search page omits it
    // (Base UI needs the value in the known set to keep the trigger label).
    if (activeOrg && !seen.has(activeOrg.id) && !guestSelected) {
      next.push(memberItem(activeOrg))
    }
    for (const org of sortedGuestOrgs) next.push(guestItem(org))
    return next
  }, [showAllOrgs, sortedOrgs, sortedGuestOrgs, t, activeOrg, guestSelected])

  const visibleItems = useMemo<OrgSwitcherItem[]>(() => {
    if (!catalogEnabled) return items
    const query = inputValue.trim()
    return items.filter((item) => {
      if (item.kind === "all") return query === ""
      if (query !== "") return orgMatchesSearch(item.label, query)
      return true
    })
  }, [catalogEnabled, items, inputValue])

  const selectedItem = useMemo((): OrgSwitcherItem | null => {
    if (guestSelected && selectedGuestOrgId != null) {
      return items.find((item) => item.kind === "guest" && item.id === selectedGuestOrgId) ?? null
    }
    if (viewingAllOrgs && showAllOrgs) {
      return items.find((item) => item.kind === "all") ?? null
    }
    if (activeOrgId != null) {
      return items.find((item) => item.kind === "member" && item.id === activeOrgId) ?? null
    }
    return null
  }, [items, guestSelected, selectedGuestOrgId, viewingAllOrgs, showAllOrgs, activeOrgId])

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
        aria-label={t("org.switcher.retryOrganizationsAriaLabel")}
        onClick={() => { void retryOrgLoad() }}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent"
      >
        <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {t("org.routeGate.errorTitle")}
        </span>
        <span className="shrink-0 text-xs font-medium underline">{t("common.retry")}</span>
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
        aria-label={t("org.switcher.retrySharedOrganizationsAriaLabel")}
        onClick={retryProjectDirectory}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent"
      >
        <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {t("org.switcher.couldNotLoadSharedOrganizations")}
        </span>
        <span className="shrink-0 text-xs font-medium underline">{t("common.retry")}</span>
      </button>
    )
  }

  // AQU-473: a project-only invitee has zero member orgs but may still have
  // guest orgs to switch into — don't hide the whole switcher for them.
  if (!activeOrg && !isAllOrgs && guestOrgs.length === 0) return null

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) setInputValue("")
  }

  function handleSelect(item: OrgSwitcherItem | null) {
    if (!item) return

    if (item.kind === "all") {
      setAllOrgs()
      navigate(swapOrgInPath(location.pathname, ALL_ORGS_PARAM))
      return
    }

    if (item.kind === "member") {
      setActiveOrg(item.id)
      // A guest org overview (`/orgs/<guestId>`) is itself an org-scoped route, so
      // swapOrgInPath swaps to the picked member org's overview — symmetric with
      // picking a guest org (AQU-790), and no special-casing needed.
      if (isOrgScopedRoute(location.pathname) || location.pathname === "/") {
        navigate(swapOrgInPath(location.pathname, item.id))
      }
      return
    }

    // AQU-790: guest orgs use the same path convention as owned orgs
    // (`/orgs/<id>`). Selecting one records it as the active scope (persisted for
    // reload, which drives `activeGuestOrg`) and navigates to that org's
    // projects table — guests have no Overview, so `/projects` is the home.
    setActiveOrg(item.id)
    navigate(orgProjectsPath(item.id))
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
      <Combobox
        items={items}
        {...(catalogEnabled
          ? { filteredItems: visibleItems, filter: null as null }
          : {
              filter: (item: OrgSwitcherItem, query: string) => {
                // All-orgs is a navigation shortcut, not a searchable org — hide while typing.
                if (item.kind === "all") return query.trim() === ""
                return orgMatchesSearch(item.label, query)
              },
            })}
        value={selectedItem}
        onValueChange={(item) => handleSelect(item)}
        open={open}
        onOpenChange={handleOpenChange}
        inputValue={inputValue}
        onInputValueChange={setInputValue}
        autoHighlight
        itemToStringValue={(item: OrgSwitcherItem) => item.key}
        itemToStringLabel={(item: OrgSwitcherItem) => item.label}
        isItemEqualToValue={(a: OrgSwitcherItem, b: OrgSwitcherItem) => a.key === b.key}
      >
        <ComboboxTrigger
          render={
            <button
              type="button"
              aria-label={t("org.switcher.triggerAriaLabel", { org: title })}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent [&>svg:last-child]:ml-auto [&>svg:last-child]:opacity-50"
            />
          }
        >
          <OrgMark name={title} allOrgs={viewingAllOrgs} />
          <span className="truncate">{title}</span>
        </ComboboxTrigger>
        <ComboboxContent
          className="w-72 min-w-72 flex flex-col p-0 *:data-[slot=input-group]:mx-0! *:data-[slot=input-group]:my-0! *:data-[slot=input-group]:h-10 *:data-[slot=input-group]:rounded-none *:data-[slot=input-group]:border-0! *:data-[slot=input-group]:bg-transparent! *:data-[slot=input-group]:shadow-none!"
          align="start"
          side="bottom"
          sideOffset={4}
        >
          <ComboboxInput
            showTrigger={false}
            showSearchIcon
            loading={catalogEnabled && catalog.searching}
            // Gate on query text — Base UI Clear stays visible for any selection.
            showClear={inputValue !== ""}
            placeholder={t("org.switcher.searchPlaceholder")}
            aria-label={t("org.switcher.searchAriaLabel")}
            className="w-auto rounded-none border-0 bg-transparent shadow-none outline-none ring-0 hover:border-0! focus-within:border-0! has-[[data-slot=input-group-control]:focus-visible]:border-0! has-[[data-slot=input-group-control]:focus-visible]:ring-0! *:data-[slot=input-group-addon]:pl-3"
          />
          <ComboboxSeparator className="mx-0 my-0" />
          <ComboboxEmpty className="min-h-32 flex-col items-center justify-center border-0 p-4">
            <Empty className="min-h-0 border-0 p-0 gap-2">
              <EmptyHeader>
                <EmptyMedia
                  variant="icon"
                  className="mb-0 border border-border bg-transparent text-muted-foreground"
                >
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle className="text-muted-foreground font-normal">
                  {catalogEnabled && catalog.searching
                    ? t("common.searching")
                    : catalog.error
                      ? t("org.switcher.searchFailed")
                      : t("org.switcher.noOrganizationsFound")}
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          </ComboboxEmpty>
          <ComboboxList className="max-h-80 flex-1" aria-busy={catalog.searching || catalog.loadingMore || undefined}>
            <OrgSwitcherList
              guestSelected={guestSelected}
              isAllOrgs={viewingAllOrgs}
              activeOrgId={activeOrgId}
              selectedGuestOrgId={selectedGuestOrgId}
              directoryError={accessibleProjectsError}
              onRetryDirectory={retryProjectDirectory}
              hasMore={catalogEnabled && catalog.hasMore}
              loadingMore={catalog.loadingMore}
              onLoadMore={catalog.loadMore}
            />
          </ComboboxList>
          <ComboboxSeparator className="mx-0 my-0" />
          <div role="presentation" className="p-1">
            <button
              type="button"
              className="flex w-full items-center gap-x-2 rounded-md px-2 py-1.5 text-sm outline-hidden hover:bg-accent focus-visible:bg-accent"
              onClick={openCreateDialog}
            >
              <OrgMark name="Create" create />
              <span className="truncate text-muted-foreground!">{t("org.switcher.create")}</span>
            </button>
          </div>
        </ComboboxContent>
      </Combobox>

      <OrgCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={(orgId) => void handleCreated(orgId)}
      />
    </>
  )
}
