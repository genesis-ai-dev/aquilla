import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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

  // FRO-253: org export floor setting
  const {
    exportMinRole,
    patch: patchOrgSettings,
  } = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const [exportRoleBusy, setExportRoleBusy] = useState(false)
  const [exportRoleError, setExportRoleError] = useState<string | null>(null)

  // exportMinRole is an owner-only permission-policy key (FRO-253).
  // Maintainers can edit org rules and other settings, but only owners
  // should change the export floor (see EXPORT_FLOOR_WRITE_MIN_ROLE in auth-worker).
  const canEditExportFloor = (activeOrg?.role.level ?? 0) >= ROLE.OWNER

  async function handleExportRoleChange(newLevel: number) {
    setExportRoleBusy(true)
    setExportRoleError(null)
    const result = await patchOrgSettings({ exportMinRole: newLevel })
    if (result.kind === "error") {
      // Surface server validation errors (including the new 400 for invalid floor values)
      // and 403 for insufficient role.
      setExportRoleError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setExportRoleError("Only org owners can change the export permission policy.")
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
        <div className="h-full overflow-y-auto">
          <div className="p-6">
            <h1 className="mb-1 text-xl font-semibold">Organization settings</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              Manage this organization. Personal preferences moved to{" "}
              <Link to="/preferences" className="underline underline-offset-4">Preferences</Link>.
            </p>

            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : !activeOrg ? (
              <p className="text-sm text-muted-foreground">No active organization.</p>
            ) : (
              <div className="space-y-6">
                {/* Identity */}
                <section className="rounded-lg border bg-card p-4">
                  <h2 className="text-base font-semibold">Identity</h2>
                  {editing ? (
                    <div className="mt-3 space-y-2">
                      <Label htmlFor="org-name" className="text-xs">Organization name</Label>
                      <Input
                        id="org-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={busy}
                      />
                      {error && <p className="text-xs text-destructive">{error}</p>}
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSave} disabled={busy || !name.trim()}>Save</Button>
                        <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-lg font-medium">{activeOrg.name ?? "Untitled organization"}</p>
                        <p className="text-xs text-muted-foreground">Your role: {activeOrg.role.name}</p>
                      </div>
                      {canRename && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setName(activeOrg.name ?? ""); setEditing(true) }}
                        >
                          Rename
                        </Button>
                      )}
                    </div>
                  )}
                </section>

                {/* Facts */}
                <section className="grid grid-cols-2 gap-4">
                  <div className="rounded-lg border p-4 text-center">
                    <p className="text-2xl font-bold">{members.length}</p>
                    <p className="text-sm text-muted-foreground">Members</p>
                  </div>
                  <div className="rounded-lg border p-4 text-center">
                    <p className="text-2xl font-bold">{projectCount ?? "—"}</p>
                    <p className="text-sm text-muted-foreground">Projects</p>
                  </div>
                </section>

                {/* FRO-253: Export permissions */}
                <section className="rounded-lg border bg-card p-4">
                  <h2 className="text-base font-semibold">Export permissions</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Minimum role required to download project deliverables (USFM export, project zip).
                    Default is <strong>Maintainer</strong>. Lower the floor to let translators export their
                    own work; raise it to restrict deliverable access to leads only.
                    Client-side formats (TSV, CSV, etc.) operate on already-fetched cells and cannot
                    be fully enforced here; this gate applies to server-rendered deliverables only.
                  </p>
                  <div className="mt-3 space-y-2">
                    <Label htmlFor="export-min-role" className="text-xs">Who can export</Label>
                    <select
                      id="export-min-role"
                      value={displayedExportMinRole}
                      onChange={(e) => { void handleExportRoleChange(Number(e.target.value)) }}
                      disabled={!canEditExportFloor || exportRoleBusy}
                      className="block w-full max-w-xs rounded-md border border-input bg-background px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      {exportRoleOptions.map((opt) => (
                        <option key={opt.level} value={opt.level}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    {!canEditExportFloor && (
                      <p className="text-xs text-muted-foreground">Only org owners can change the export permission policy.</p>
                    )}
                    {exportRoleError && (
                      <p className="text-xs text-destructive">{exportRoleError}</p>
                    )}
                  </div>
                </section>

                <div className="flex flex-wrap gap-2 text-sm">
                  <Link to="/members" className="rounded-md border px-3 py-1.5 hover:bg-accent/40">Members</Link>
                  <Link to="/teams" className="rounded-md border px-3 py-1.5 hover:bg-accent/40">Teams</Link>
                  <Link to="/projects/archived" className="rounded-md border px-3 py-1.5 hover:bg-accent/40">Archived</Link>
                </div>
              </div>
            )}
          </div>
        </div>
      }
    />
  )
}
