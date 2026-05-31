# Real Org Settings Page — Implementation Plan (org-manager-polish #1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Turn `/settings` from an admin-gated **personal** prefs page into a real **organization** settings surface a manager expects (org identity + rename + facts), and move the personal prefs to a **Preferences** surface every user can reach.

**Why:** `src/pages/Settings.tsx` is shown only to org admins (sidebar gates it at role ≥ 600) yet contains *only* personal/device prefs (analytics consent + personal AI key). So (a) there's no org-level settings page for a manager, and (b) non-admins have **no way to reach their own preferences**. Splitting fixes both.

**Architecture:** Pure client change — no new backend (`renameOrg` already exists). Two pages: **Settings** (`/settings`, org-level, stays in the admin sidebar slot) and **Preferences** (`/preferences`, personal, reached from the always-visible AccountSwitcher). Both reuse the AppShell + OrgSidebar chrome.

**Tech Stack:** React + react-router v7 + RTL. Reuses `useActiveOrg`, `renameOrg`, `useOrgMembers`, `getPortfolio`, `useAnalyticsConsent`, `PersonalProviderSection`.

**Out of scope (YAGNI):** org-wide default-invite-role (needs backend), org delete/transfer, billing/usage. Leave a one-line "more org controls coming" note at most.

---

### Task OS1: Preferences page + relocation

**Files:** create `src/pages/Preferences.tsx` (+ test); modify `src/App.tsx`, `src/components/AccountSwitcher.tsx`.

- [ ] **Step 1: create `src/pages/Preferences.tsx`** — lift the two personal sections out of the current Settings:

```tsx
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { PersonalProviderSection } from "@/components/settings/PersonalProviderSection"

export function Preferences() {
  const { enabled, setEnabled } = useAnalyticsConsent()
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Preferences" />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-2xl p-6">
            <h1 className="mb-1 text-xl font-semibold">Preferences</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              Personal preferences that apply to you across all projects on this device.
            </p>

            <section className="space-y-3">
              <div>
                <h2 className="text-base font-semibold">Privacy</h2>
                <p className="text-xs text-muted-foreground">
                  Control what's shared with us about how you use the app.
                </p>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="analytics-consent" className="text-sm font-medium">
                      Share anonymous usage data
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Events like project creation, exports, and AI translations. Never the contents of your
                      translations or files.
                    </p>
                  </div>
                  <Switch id="analytics-consent" checked={enabled} onCheckedChange={setEnabled} />
                </div>
                {!enabled && (
                  <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                    With analytics disabled, we may not be able to help diagnose problems you encounter.
                  </p>
                )}
              </div>
            </section>

            <div className="mt-8">
              <PersonalProviderSection />
            </div>
          </div>
        </div>
      }
    />
  )
}
```

- [ ] **Step 2: route** — in `src/App.tsx`, import `Preferences` and add the route next to `/settings`:

```tsx
import { Preferences } from "@/pages/Preferences"
// …
      <Route path="/settings" element={<Settings />} />
      <Route path="/preferences" element={<Preferences />} />
```

- [ ] **Step 3: AccountSwitcher entry** — in `src/components/AccountSwitcher.tsx`, add `import { Link } from "react-router-dom"` and a Preferences link in the open dropdown, just above the "Add another account…" button (inside the `{open && …}` block, after the `<div className="my-1.5 h-px bg-foreground/5" />` that precedes "Add another account"):

```tsx
          <Link
            to="/preferences"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-xl bg-card px-2 py-1.5 text-sm transition-shadow hover:shadow-neu-xs"
          >
            <Settings2 className="h-4 w-4" />
            <span>Preferences</span>
          </Link>
```

Add `Settings2` to the lucide import on line 2 (`import { ChevronsUpDown, LogIn, LogOut, UserPlus, Check, Settings2 } from "lucide-react"`).

- [ ] **Step 4: test** `src/pages/Preferences.test.tsx`: mock `@/hooks/useAnalyticsConsent` (`{ enabled: true, setEnabled: vi.fn() }`), `@/components/settings/PersonalProviderSection` (`() => <div>provider</div>`), `@/components/AccountSwitcher` (`() => null`), `@/lib/frontier/orgs` (`listMyOrgs: vi.fn(async () => [])`); render in `<MemoryRouter><OrgProvider>…`; assert "Preferences" heading + the "Share anonymous usage data" label render.

- [ ] **Step 5:** `npx vitest run src/pages/Preferences.test.tsx` + `npx tsc -b`.
- [ ] **Step 6: commit** — `git add src/pages/Preferences.tsx src/pages/Preferences.test.tsx src/App.tsx src/components/AccountSwitcher.tsx && git commit -m "feat(settings): personal Preferences page reachable by all users (relocated from org Settings)"`

---

### Task OS2: rebuild Settings into Org Settings

**Files:** modify `src/pages/Settings.tsx` (+ test `src/pages/Settings.test.tsx`).

Keep the export name `Settings` (App.tsx imports it). Org identity + rename (level ≥ 600) + facts (your role, member count, project count). Member count from `useOrgMembers(orgId).members.length`; project count from `getPortfolio(jwt, orgId).length`.

- [ ] **Step 1: failing test** — `src/pages/Settings.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { Settings } from "./Settings"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
const renameOrg = vi.fn(async () => {})
vi.mock("@/lib/frontier/orgs", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/frontier/orgs")>()
  return {
    ...actual,
    listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]),
    renameOrg: (...a: unknown[]) => renameOrg(...a),
  }
})
vi.mock("@/hooks/useOrg", () => ({ useOrgMembers: () => ({ members: [{ userId: 1 }, { userId: 2 }, { userId: 3 }], isLoading: false, error: null }) }))
vi.mock("@/lib/frontier/portfolio", () => ({ getPortfolio: vi.fn(async () => [{ id: "p1" }, { id: "p2" }]) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

function renderSettings() {
  return render(<MemoryRouter><OrgProvider><Settings /></OrgProvider></MemoryRouter>)
}

describe("Org Settings", () => {
  it("shows org name and an owner can rename it", async () => {
    renderSettings()
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole("button", { name: /rename/i }))
    const input = screen.getByLabelText(/organization name/i)
    fireEvent.change(input, { target: { value: "CAS" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(renameOrg).toHaveBeenCalledWith("jwt", 1, "CAS"))
  })

  it("shows org facts (member + project counts)", async () => {
    renderSettings()
    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument()) // members
    expect(screen.getByText("2")).toBeInTheDocument() // projects
  })
})
```

(A non-admin no-rename test can be added by overriding the role mock to `{ level: 100, name: "viewer" }` and asserting `queryByRole("button", { name: /rename/i })` is null — optional, keep if quick.)

- [ ] **Step 2: run, verify fail** — `npx vitest run src/pages/Settings.test.tsx`.

- [ ] **Step 3: implement `src/pages/Settings.tsx`:**

```tsx
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
import { renameOrg } from "@/lib/frontier/orgs"
import { getPortfolio } from "@/lib/frontier/portfolio"

export function Settings() {
  const { activeOrg, activeOrgId, isLoading, refresh } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const canRename = (activeOrg?.role.level ?? 0) >= 600
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { members } = useOrgMembers(activeOrgId ?? 0)
  const [projectCount, setProjectCount] = useState<number | null>(null)
  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    getPortfolio(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setProjectCount(list.length) })
      .catch(() => { if (!cancelled) setProjectCount(null) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  async function handleSave() {
    if (!jwt || activeOrgId == null) return
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true); setError(null)
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
          <div className="mx-auto max-w-2xl p-6">
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
                      <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
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
                        <Button size="sm" variant="outline" onClick={() => { setName(activeOrg.name ?? ""); setEditing(true) }}>
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
```

- [ ] **Step 4: run PASS** — `npx vitest run src/pages/Settings.test.tsx` + `npx tsc -b`.
- [ ] **Step 5: full client org/pages suites** — `npx vitest run src/pages/ src/components/org/`.
- [ ] **Step 6: commit** — `git add src/pages/Settings.tsx src/pages/Settings.test.tsx && git commit -m "feat(settings): rebuild /settings into an org settings page (identity + rename + facts)"`

---

## Self-Review
- Coverage: org identity + maintainer+ rename (reuses `renameOrg`) ✓; org facts (role, members, projects) ✓; personal prefs relocated to `/preferences` reachable by all users via AccountSwitcher ✓ (fixes the non-admin-can't-reach-prefs bug); no new backend ✓.
- Types: `useActiveOrg`→`activeOrg.role.level/name`; `renameOrg(jwt, orgId, name)`; `useOrgMembers(orgId).members`; `getPortfolio(jwt, orgId)`. All confirmed against source.
- Placeholders: none. Confirm `@/components/ui/input` exists (used by the rename field) — it's a standard shadcn component in this repo; if absent, use a plain `<input className="...">`.
