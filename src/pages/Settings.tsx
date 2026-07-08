import { useEffect, useState, type ReactNode } from "react"
import { Link, Navigate, useParams } from "react-router-dom"
import { Archive, Building2, Check, Download, EyeOff, KeyRound, Users, UsersRound } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Page, PageHeader, Section, StatTile, EmptyState } from "@/components/ui/page"
import { NavList, NavRow, BackLink } from "@/components/ui/nav-list"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { OrgProviderSection } from "@/components/settings/OrgProviderSection"
import { RosterProgressSection } from "@/components/settings/RosterProgressSection"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOrgMembers } from "@/hooks/useOrg"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { renameOrg } from "@/lib/frontier/orgs"
import { getPortfolio } from "@/lib/frontier/portfolio"
import { ROLE } from "@/lib/frontier/roles"

/**
 * Org-level settings — the manager's home for the organization itself. The old
 * /settings page was admin-gated but personal-only; those personal prefs moved
 * to /preferences (reachable by everyone via the AccountSwitcher). This page is
 * the org surface: identity + rename (maintainer+), and at-a-glance facts.
 *
 * Rather than stacking every form onto one page, `/settings` is an index of
 * at-a-glance facts + navigation rows (each hinting its current value); each
 * row opens a focused detail sub-page at `/settings/:section`. Both routes
 * render this same component — it branches on the `section` param, so the org
 * settings hooks are fetched once and shared across index and detail.
 */

/** Short role labels for the export-floor hint on the index row. */
const FLOOR_LABEL: Record<number, string> = {
  [ROLE.VIEWER]: "Viewer",
  [ROLE.CONTRIBUTOR]: "Contributor",
  [ROLE.PROJECT_LEAD]: "Project lead",
  [ROLE.MAINTAINER]: "Maintainer",
  [ROLE.OWNER]: "Owner",
}

/** Detail sub-pages hosted directly under /settings (vs. rows that link out). */
const DETAIL_TITLES: Record<string, string> = {
  identity: "Identity",
  export: "Export permissions",
  roster: "Roster & progress visibility",
  providers: "AI provider keys",
}

export function Settings() {
  const { section } = useParams<{ section?: string }>()
  const { activeOrg, activeOrgId, isLoading, refresh } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const canRename = (activeOrg?.role.level ?? 0) >= 600
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { members } = useOrgMembers(activeOrgId)
  const [projectCount, setProjectCount] = useState<number | null>(null)
  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    getPortfolio(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setProjectCount(list.length) })
      .catch(() => { if (!cancelled) setProjectCount(null) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  // FRO-253/FRO-433: org settings (export floor + provider keys)
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const {
    exportMinRole,
    patch: patchOrgSettings,
  } = orgSettings
  const [exportRoleBusy, setExportRoleBusy] = useState(false)
  const [exportRoleError, setExportRoleError] = useState<string | null>(null)
  const [exportRoleSaved, setExportRoleSaved] = useState(false)

  // exportMinRole is an owner-only permission-policy key (FRO-253).
  // Maintainers can edit org rules and other settings, but only owners
  // should change the export floor (see EXPORT_FLOOR_WRITE_MIN_ROLE in auth-worker).
  const canEditExportFloor = (activeOrg?.role.level ?? 0) >= ROLE.OWNER

  // Auto-clear the "Saved" acknowledgment after a short delay.
  useEffect(() => {
    if (!exportRoleSaved) return
    const t = setTimeout(() => setExportRoleSaved(false), 2500)
    return () => clearTimeout(t)
  }, [exportRoleSaved])

  async function handleExportRoleChange(newLevel: number) {
    setExportRoleBusy(true)
    setExportRoleError(null)
    setExportRoleSaved(false)
    const result = await patchOrgSettings({ exportMinRole: newLevel })
    if (result.kind === "error") {
      // Surface server validation errors (including the new 400 for invalid floor values)
      // and 403 for insufficient role.
      setExportRoleError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setExportRoleError("Only org owners can change the export permission policy.")
    } else {
      setExportRoleSaved(true)
    }
    setExportRoleBusy(false)
  }

  // Only show roles that make sense as an export floor (viewer → owner).
  // We include all org role options plus VIEWER since viewer is a valid lower bound.
  const exportRoleOptions = [
    { level: ROLE.VIEWER, label: "Viewer (100) — anyone with project access" },
    { level: ROLE.CONTRIBUTOR, label: "Contributor (400)" },
    { level: ROLE.PROJECT_LEAD, label: "Project lead (500)" },
    { level: ROLE.MAINTAINER, label: "Maintainer (600) — default" },
    { level: ROLE.OWNER, label: "Owner (700) — most restrictive" },
  ]

  // AQU-485: roster + member-progress visibility floors. Owner-only edit gate,
  // same rationale as exportMinRole (a permission-policy key, stricter than the
  // general MAINTAINER settings-write gate). UI lives in RosterProgressSection.
  const { rosterViewMinRole } = orgSettings
  const canEditRosterProgress = canEditRosterProgressFloor(activeOrg?.role?.level)

  // Show the effective floor: null means "not set → server default (Maintainer)".
  const displayedExportMinRole = exportMinRole ?? ROLE.MAINTAINER

  async function handleSave() {
    if (!jwt || activeOrgId == null) return
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await renameOrg(jwt, activeOrgId, trimmed)
      await refresh()
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const activeTitle = section ? DETAIL_TITLES[section] : undefined
  const header = activeTitle ? (
    <OrgBreadcrumb parent={{ label: "Settings", to: "/settings" }} section={activeTitle} />
  ) : (
    <OrgBreadcrumb section="Settings" />
  )

  // --- Detail bodies (rendered on /settings/:section) -----------------------

  const identityBody = (
    <Section
      title="Identity"
      description="The organization's display name, shown across the workspace."
      action={
        !editing && canRename ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setName(activeOrg?.name ?? ""); setEditing(true) }}
          >
            Rename
          </Button>
        ) : null
      }
    >
      {editing ? (
        <Field>
          <FieldLabel htmlFor="org-name" className="text-sm font-medium">Organization name</FieldLabel>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus
          />
          {error && <FieldError className="text-xs">{error}</FieldError>}
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={handleSave} disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
          </div>
        </Field>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium text-foreground">{activeOrg?.name ?? "Untitled organization"}</span>
          <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
            Your role: {activeOrg?.role.name}
          </span>
        </div>
      )}
    </Section>
  )

  const exportBody = (
    <Section
      title="Export permissions"
      description="Minimum role required to download project deliverables — USFM export and project zip. Defaults to Maintainer."
    >
      <Field>
        <FieldLabel htmlFor="export-min-role" className="text-sm font-medium">Who can export</FieldLabel>
        <Select
          items={exportRoleOptions.map((opt) => ({ value: String(opt.level), label: opt.label }))}
          value={String(displayedExportMinRole)}
          onValueChange={(v) => { if (v) void handleExportRoleChange(Number(v)) }}
          disabled={!canEditExportFloor || exportRoleBusy}
        >
          <SelectTrigger id="export-min-role" className="w-full max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {exportRoleOptions.map((opt) => (
                <SelectItem key={opt.level} value={String(opt.level)}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          Lower the floor to let translators export their own work; raise it to keep deliverables
          with leads. Client-side formats (CSV, TSV) operate on already-loaded cells and can't be
          enforced here.
        </FieldDescription>
        {!canEditExportFloor && (
          <FieldDescription>Only org owners can change the export permission policy.</FieldDescription>
        )}
        {exportRoleError && (
          <FieldError className="text-xs">{exportRoleError}</FieldError>
        )}
        {exportRoleSaved && (
          <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400" role="status" data-testid="export-role-saved">
            <Check className="size-3.5" /> Saved
          </p>
        )}
      </Field>
    </Section>
  )

  // --- Index (rendered on /settings) ----------------------------------------

  const indexBody = (
    <>
      <PageHeader
        title="Organization settings"
        description={
          <>
            Manage this organization. Personal preferences moved to{" "}
            <Link to="/preferences" className="font-medium text-foreground underline underline-offset-4">
              Preferences
            </Link>
            .
          </>
        }
      />
      <div className="space-y-6">
        {/* Facts */}
        <div className="grid grid-cols-2 gap-4">
          {/* AQU-485: the settings owner (maintainer+ per canRename) may still be
              below the configured rosterViewMinRole floor in theory, but in
              practice canEdit here requires MAINTAINER — same as the default
              roster floor — so this stat tile stays visible to the audience
              that can already reach this page. Hide it defensively anyway so
              a future floor above MAINTAINER doesn't leak the count here. */}
          {orgSettings.canViewRoster ? (
            <StatTile label="Members" value={members.length} />
          ) : (
            <StatTile label="Members" value="—" />
          )}
          <StatTile label="Projects" value={projectCount ?? "—"} />
        </div>

        <NavList label="Organization">
          <NavRow to="/settings/identity" icon={Building2} title="Identity" hint={activeOrg?.name ?? "Untitled"} />
          <NavRow to="/settings/export" icon={Download} title="Export permissions" hint={FLOOR_LABEL[displayedExportMinRole] ?? "Maintainer"} />
          <NavRow to="/settings/roster" icon={EyeOff} title="Roster & progress visibility" hint={FLOOR_LABEL[rosterViewMinRole] ?? "Maintainer"} />
          <NavRow to="/settings/providers" icon={KeyRound} title="AI provider keys" hint="Org keys" />
        </NavList>

        <NavList label="People & Projects">
          <NavRow to="/members" icon={Users} title="Members" hint="Roles & invites" />
          <NavRow to="/teams" icon={UsersRound} title="Teams" hint="Groups" />
          <NavRow to="/projects/archived" icon={Archive} title="Archived projects" hint="Restore" />
        </NavList>
      </div>
    </>
  )

  // --- Body selection -------------------------------------------------------

  let body: ReactNode
  if (isLoading) {
    body = (
      <div className="space-y-6">
        <div className="h-28 animate-pulse rounded-2xl border bg-card" />
        <div className="grid grid-cols-2 gap-4">
          <div className="h-24 animate-pulse rounded-2xl border bg-card" />
          <div className="h-24 animate-pulse rounded-2xl border bg-card" />
        </div>
      </div>
    )
  } else if (!activeOrg) {
    body = (
      <EmptyState
        title="Select an organization"
        description="Organization settings are managed within a single organization. Choose one from the switcher to continue."
      />
    )
  } else if (section && !activeTitle) {
    // Unknown detail slug — bounce back to the index.
    body = <Navigate to="/settings" replace />
  } else if (activeTitle) {
    // Detail sub-page: a back link to the general settings sits at the top-left,
    // above the section's own titled card.
    const detail =
      section === "identity" ? identityBody
      : section === "export" ? exportBody
      : section === "roster" ? <RosterProgressSection orgSettings={orgSettings} canEdit={canEditRosterProgress} />
      : <OrgProviderSection orgSettings={orgSettings} />
    body = (
      <div className="space-y-4">
        <BackLink to="/settings" label="Settings" />
        {detail}
      </div>
    )
  } else {
    body = indexBody
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={header}
      statusBar={null}
      main={<Page>{body}</Page>}
    />
  )
}
