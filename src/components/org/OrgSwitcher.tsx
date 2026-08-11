import { useMemo, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { Building2, Check, Plus, SearchIcon } from "lucide-react"
import { useActiveOrg, type GuestOrg } from "@/context/OrgContext"
import { isOrgScopedRoute } from "./org-route-scope"
import { OrgCreateDialog } from "./OrgCreateDialog"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { RoleLabel } from "@/components/RoleLabel"
import type { OrgSummary } from "@/lib/frontier/orgs"
import {
  ALL_ORGS_PARAM,
  orgHomePath,
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

// Trailing check is in-flow only on the selected row — do not reserve `pr-8`
// on every option (that left a blank gap beside unselected role labels).
const ORG_ITEM_CLASS =
  "grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-1.5"

/** Muted meta (role / "All projects") — `!` beats item `data-highlighted:**:text-accent-foreground`. */
const ORG_META_CLASS = "text-xs text-muted-foreground!"

type OrgSwitcherItem =
  | { kind: "all"; key: "all"; label: "All organizations" }
  | {
      kind: "member"
      key: `member:${number}`
      id: number
      label: string
      roleName: string
    }
  | {
      kind: "guest"
      key: `guest:${number}`
      id: number
      label: string
    }

const ALL_ORGS_ITEM: Extract<OrgSwitcherItem, { kind: "all" }> = {
  kind: "all",
  key: "all",
  label: "All organizations",
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
}: {
  guestSelected: boolean
  isAllOrgs: boolean
  activeOrgId: number | null
  selectedGuestOrgId: number | null
}) {
  const filtered = ComboboxPrimitive.useFilteredItems<OrgSwitcherItem>()
  const members = filtered.filter((item) => item.kind !== "guest")
  const guests = filtered.filter((item) => item.kind === "guest")

  return (
    <>
      {members.length > 0 && (
        <ComboboxGroup aria-label="Organizations">
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
      {guests.length > 0 && (
        <>
          {members.length > 0 && (
            <ComboboxSeparator
              className="mx-0 my-1"
              data-testid="guest-orgs-separator"
            />
          )}
          <ComboboxGroup aria-label="Guest organizations" data-testid="guest-orgs">
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
    </>
  )
}

function OrgSwitcherOption({
  item,
  selected,
}: {
  item: OrgSwitcherItem
  selected: boolean
}) {
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
          <span className={ORG_META_CLASS}>All projects</span>
        ) : item.kind === "member" ? (
          <RoleLabel name={item.roleName} className={ORG_META_CLASS} />
        ) : (
          <RoleLabel name="guest" className={ORG_META_CLASS} />
        )}
        {selected && (
          <Check className="size-4 shrink-0" aria-hidden />
        )}
      </span>
    </ComboboxItem>
  )
}

export function OrgSwitcher() {
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
  } = useActiveOrg()
  const location = useLocation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  // AQU-759: keep both member and guest lists alphabetical regardless of the
  // order the backend returned them in (Joel: "Keep it alphabetical").
  const sortedOrgs = useMemo(() => [...orgs].sort(byName), [orgs])
  const sortedGuestOrgs = useMemo(() => [...guestOrgs].sort(byName), [guestOrgs])

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
      ? "All organizations"
      : activeOrg?.name ?? "Workspace"

  const items = useMemo<OrgSwitcherItem[]>(() => {
    const next: OrgSwitcherItem[] = []
    if (showAllOrgs) next.push(ALL_ORGS_ITEM)
    for (const org of sortedOrgs) next.push(memberItem(org))
    for (const org of sortedGuestOrgs) next.push(guestItem(org))
    return next
  }, [showAllOrgs, sortedOrgs, sortedGuestOrgs])

  const selectedItem = useMemo((): OrgSwitcherItem | null => {
    if (guestSelected && selectedGuestOrgId != null) {
      return items.find((item) => item.kind === "guest" && item.id === selectedGuestOrgId) ?? null
    }
    if (isAllOrgs && showAllOrgs) {
      return items.find((item) => item.kind === "all") ?? null
    }
    if (activeOrgId != null) {
      return items.find((item) => item.kind === "member" && item.id === activeOrgId) ?? null
    }
    return null
  }, [items, guestSelected, selectedGuestOrgId, isAllOrgs, showAllOrgs, activeOrgId])

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
    // reload, which drives `activeGuestOrg`) and navigates to that org's overview
    // — no longer the divergent `/shared?org=<id>` query param.
    setActiveOrg(item.id)
    navigate(orgHomePath(item.id))
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
        filter={(item: OrgSwitcherItem, query: string) => {
          // All-orgs is a navigation shortcut, not a searchable org — hide while typing.
          if (item.kind === "all") return query.trim() === ""
          return orgMatchesSearch(item.label, query)
        }}
      >
        <ComboboxTrigger
          render={
            <button
              type="button"
              aria-label={`Organization switcher: ${title}`}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent [&>svg:last-child]:ml-auto [&>svg:last-child]:opacity-50"
            />
          }
        >
          <OrgMark name={title} allOrgs={!guestSelected && isAllOrgs} />
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
            // Gate on query text — Base UI Clear stays visible for any selection.
            showClear={inputValue !== ""}
            placeholder="Find an organization…"
            aria-label="Find an organization"
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
                  No organizations found.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          </ComboboxEmpty>
          <ComboboxList className="max-h-80 flex-1">
            <OrgSwitcherList
              guestSelected={guestSelected}
              isAllOrgs={isAllOrgs}
              activeOrgId={activeOrgId}
              selectedGuestOrgId={selectedGuestOrgId}
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
              <span className="truncate text-muted-foreground!">Create</span>
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
