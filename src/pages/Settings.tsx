import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Check } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Page, PageHeader, Section, StatTile, EmptyState } from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { OrgProviderSection } from "@/components/settings/OrgProviderSection"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOrgMembers } from "@/hooks/useOrg"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { renameOrg } from "@/lib/frontier/orgs"
import { getPortfolio } from "@/lib/frontier/portfolio"
import { ROLE } from "@/lib/frontier/roles"

/**
 * Org-level settings — the manager's home for the organization itself. The old
 * /settings page was admin-gated but personal-only; those personal prefs moved
 * to /preferences (reachable by everyone via the AccountSwitcher). This page is
 * the org surface: identity + rename (maintainer+), and at-a-glance facts.
 */
export function Settings() {
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

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Settings" />}
      statusBar={null}
      main={
        <Page>
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

          {isLoading ? (
            <div className="space-y-6">
              <div className="h-28 animate-pulse rounded-2xl border bg-card" />
              <div className="grid grid-cols-2 gap-4">
                <div className="h-24 animate-pulse rounded-2xl border bg-card" />
                <div className="h-24 animate-pulse rounded-2xl border bg-card" />
              </div>
            </div>
          ) : !activeOrg ? (
            <EmptyState
              title="Select an organization"
              description="Organization settings are managed within a single organization. Choose one from the switcher to continue."
            />
          ) : (
            <div className="space-y-6">
              {/* Identity */}
              <Section
                title="Identity"
                description="The organization's display name, shown across the workspace."
                action={
                  !editing && canRename ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setName(activeOrg.name ?? ""); setEditing(true) }}
                    >
                      Rename
                    </Button>
                  ) : null
                }
              >
                {editing ? (
                  <div className="space-y-2">
                    <Label htmlFor="org-name" className="text-sm font-medium">Organization name</Label>
                    <Input
                      id="org-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={busy}
                      autoFocus
                    />
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" onClick={handleSave} disabled={busy || !name.trim()}>
                        {busy ? "Saving…" : "Save"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-medium text-foreground">{activeOrg.name ?? "Untitled organization"}</span>
                    <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                      Your role: {activeOrg.role.name}
                    </span>
                  </div>
                )}
              </Section>

              {/* Facts */}
              <div className="grid grid-cols-2 gap-4">
                <StatTile label="Members" value={members.length} />
                <StatTile label="Projects" value={projectCount ?? "—"} />
              </div>

              {/* FRO-253: Export permissions */}
              <Section
                title="Export permissions"
                description="Minimum role required to download project deliverables — USFM export and project zip. Defaults to Maintainer."
              >
                <div className="space-y-2">
                  <Label htmlFor="export-min-role" className="text-sm font-medium">Who can export</Label>
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
                  <p className="text-xs text-muted-foreground">
                    Lower the floor to let translators export their own work; raise it to keep deliverables
                    with leads. Client-side formats (CSV, TSV) operate on already-loaded cells and can't be
                    enforced here.
                  </p>
                  {!canEditExportFloor && (
                    <p className="text-xs text-muted-foreground">Only org owners can change the export permission policy.</p>
                  )}
                  {exportRoleError && (
                    <p className="text-xs text-destructive">{exportRoleError}</p>
                  )}
                  {exportRoleSaved && (
                    <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400" role="status" data-testid="export-role-saved">
                      <Check className="size-3.5" /> Saved
                    </p>
                  )}
                </div>
              </Section>

              {/* FRO-433: Org-level provider API keys */}
              <OrgProviderSection orgSettings={orgSettings} />

              {/* Related org surfaces */}
              <div className="space-y-2">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Manage</p>
                <div className="flex flex-wrap gap-2 text-sm">
                  <Link to="/members" className="rounded-lg border px-3 py-1.5 transition-colors hover:bg-accent/40">Members</Link>
                  <Link to="/teams" className="rounded-lg border px-3 py-1.5 transition-colors hover:bg-accent/40">Teams</Link>
                  <Link to="/projects/archived" className="rounded-lg border px-3 py-1.5 transition-colors hover:bg-accent/40">Archived</Link>
                </div>
              </div>
            </div>
          )}
        </Page>
      }
    />
  )
}
