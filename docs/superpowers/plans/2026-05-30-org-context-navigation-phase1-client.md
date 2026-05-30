# Org Context & Navigation — Phase 1 Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the client-side **org context** — a single active org with a top-left switcher, an org-context shell (sidebar of Projects + read-only Teams, breadcrumbs), an org-scoped projects list, a minimal project overview with an "Open project" hand-off into the existing workspace, and a placeholder Overview.

**Architecture:** A new `OrgProvider` React context holds the active org (hydrated from `GET /api/v2/orgs`, persisted in `localStorage`). The existing `AppShell` frame is reused with a new `OrgSidebar`. The current flat `Dashboard` at `/` is replaced by an org-context home; project creation, the account switcher, and trash are reused from existing components. The existing `/project/:id` workspace is unchanged — "Open project" navigates into it.

**Tech Stack:** React 19, react-router v7 (`useNavigate`, `NavLink`), TanStack Query already present, vitest + happy-dom + `@testing-library/react`. Tests follow the repo pattern: `vi.mock("@/hooks/useFrontierSession", …)` for the session and `global.fetch = vi.fn(async (input) => …)` for HTTP (see `src/hooks/useProject.test.tsx`). `src/test-setup.ts` provides fake-indexeddb + jest-dom + `cleanup()`.

**Depends on:** the merged Phase 1 backend (`GET /api/v2/orgs`, `orgId` + `?orgId` on the projects list, read-only `GET /api/v2/orgs/:orgId/groups[/:groupId]`). **Spec:** [docs/superpowers/specs/2026-05-30-org-context-navigation-design.md](../specs/2026-05-30-org-context-navigation-design.md). Run client tests with `npx vitest run <path>` from the repo root.

---

## File Structure

- `src/lib/frontier/orgs.ts` — **modify**: add `listMyOrgs()` + `OrgSummary`.
- `src/lib/frontier/teams.ts` — **new**: `listTeams`, `getTeam`, `TeamSummary`, `TeamDetail`.
- `src/lib/sync/cloud-projects.ts` — **modify**: add `orgId` to `CloudProjectSummary`; add `orgId?` arg to `fetchAccessibleProjects`.
- `src/context/OrgContext.tsx` — **new**: `OrgProvider` + `useActiveOrg()`.
- `src/components/org/OrgSwitcher.tsx` — **new**.
- `src/components/org/OrgSidebar.tsx`, `OrgBreadcrumb.tsx` — **new**.
- `src/components/org/OrgHome.tsx` (Overview placeholder), `ProjectsList.tsx`, `ProjectOverview.tsx`, `TeamsList.tsx`, `TeamDetail.tsx` — **new**.
- `src/App.tsx` — **modify**: wrap `OrgProvider`, add org-context routes.
- `src/pages/MembersPage.tsx` — **modify**: read the active org instead of the owned org.

Each task ends with a commit.

---

### Task 1: Client API layer (orgs, teams, project orgId)

**Files:** modify `src/lib/frontier/orgs.ts`, `src/lib/sync/cloud-projects.ts`; create `src/lib/frontier/teams.ts`, `src/lib/frontier/teams.test.ts`, `src/lib/frontier/orgs.test.ts`.

- [ ] **Step 1: Write failing tests** — `src/lib/frontier/orgs.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest"
import { listMyOrgs } from "./orgs"

const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks() })

describe("listMyOrgs", () => {
  it("GETs /api/v2/orgs and returns the orgs array", async () => {
    let calledUrl = ""
    global.fetch = vi.fn(async (input) => {
      calledUrl = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ orgs: [{ id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const orgs = await listMyOrgs("jwt-123")
    expect(calledUrl).toMatch(/\/api\/v2\/orgs$/)
    expect(orgs).toEqual([{ id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } }])
  })

  it("throws on non-OK", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    await expect(listMyOrgs("jwt")).rejects.toThrow(/HTTP 500/)
  })
})
```

`src/lib/frontier/teams.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest"
import { listTeams, getTeam } from "./teams"

const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks() })

describe("teams API", () => {
  it("listTeams GETs the org groups endpoint", async () => {
    let url = ""
    global.fetch = vi.fn(async (input) => {
      url = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ groups: [{ id: 10, name: "West Africa", memberCount: 2, projectCount: 1, viewerIsMember: true }] }), { status: 200 })
    }) as unknown as typeof fetch
    const teams = await listTeams("jwt", 1)
    expect(url).toMatch(/\/api\/v2\/orgs\/1\/groups$/)
    expect(teams[0]).toMatchObject({ id: 10, name: "West Africa", memberCount: 2 })
  })

  it("getTeam GETs the detail endpoint", async () => {
    let url = ""
    global.fetch = vi.fn(async (input) => {
      url = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ id: 10, name: "West Africa", members: [{ userId: 1, username: "wendi", roleLevel: 700 }], projects: [{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }] }), { status: 200 })
    }) as unknown as typeof fetch
    const detail = await getTeam("jwt", 1, 10)
    expect(url).toMatch(/\/api\/v2\/orgs\/1\/groups\/10$/)
    expect(detail.projects).toEqual([{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }])
  })
})
```

Add to a new/existing `src/lib/sync/cloud-projects.test.ts` (create if absent):

```ts
import { describe, it, expect, afterEach, vi } from "vitest"
import { fetchAccessibleProjects } from "./cloud-projects"

const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks() })

describe("fetchAccessibleProjects orgId", () => {
  it("appends ?orgId when given and surfaces orgId on results", async () => {
    let url = ""
    global.fetch = vi.fn(async (input) => {
      url = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ projects: [{ id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] }] }), { status: 200 })
    }) as unknown as typeof fetch
    const list = await fetchAccessibleProjects("jwt", 7)
    expect(url).toMatch(/\/api\/v2\/projects\?orgId=7$/)
    expect(list[0].orgId).toBe(7)
  })

  it("omits the query param when no orgId is given", async () => {
    let url = ""
    global.fetch = vi.fn(async (input) => { url = typeof input === "string" ? input : (input as Request).url; return new Response(JSON.stringify({ projects: [] }), { status: 200 }) }) as unknown as typeof fetch
    await fetchAccessibleProjects("jwt")
    expect(url).toMatch(/\/api\/v2\/projects$/)
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/lib/frontier/orgs.test.ts src/lib/frontier/teams.test.ts src/lib/sync/cloud-projects.test.ts` → FAIL (functions/fields missing).

- [ ] **Step 3: Implement `listMyOrgs`** in `src/lib/frontier/orgs.ts` (mirror the existing `getOrCreateMyOrg`/`authHeaders`/`fetchWithTimeout` pattern already in that file):

```ts
export interface OrgSummary {
  id: number
  name: string | null
  role: OrgRole
}

export async function listMyOrgs(jwt: string): Promise<OrgSummary[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`listMyOrgs failed: HTTP ${res.status}`)
  return ((await res.json()) as { orgs: OrgSummary[] }).orgs
}
```

- [ ] **Step 4: Implement `src/lib/frontier/teams.ts`:**

```ts
import { FRONTIER_BASE } from "./auth"

export interface TeamSummary {
  id: number
  name: string
  memberCount: number
  projectCount: number
  viewerIsMember: boolean
}

export interface TeamDetail {
  id: number
  name: string
  members: Array<{ userId: number; username: string; roleLevel: number | null }>
  projects: Array<{ id: string; name: string; grantedRoleLevel: number }>
}

function authHeaders(jwt: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }
}

export async function listTeams(jwt: string, orgId: number): Promise<TeamSummary[]> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`listTeams failed: HTTP ${res.status}`)
  return ((await res.json()) as { groups: TeamSummary[] }).groups
}

export async function getTeam(jwt: string, orgId: number, groupId: number): Promise<TeamDetail> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getTeam failed: HTTP ${res.status}`)
  return (await res.json()) as TeamDetail
}
```

- [ ] **Step 5: Add `orgId` to projects** in `src/lib/sync/cloud-projects.ts`: add `orgId: number | null` to the `CloudProjectSummary` interface, and change `fetchAccessibleProjects` to accept an optional `orgId`:

```ts
export async function fetchAccessibleProjects(
  jwt: string,
  orgId?: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<CloudProjectSummary[]> {
  try {
    const url = orgId != null ? `${apiUrl}/api/v2/projects?orgId=${orgId}` : `${apiUrl}/api/v2/projects`
    const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${jwt}` } })
    if (!res.ok) return []
    const body = (await res.json()) as { projects?: CloudProjectSummary[] }
    return body.projects ?? []
  } catch {
    return []
  }
}
```

Then update existing callers that passed `apiUrl` positionally (search `fetchAccessibleProjects(`): the Dashboard call `fetchAccessibleProjects(session.jwt)` is unaffected; any call passing a custom `apiUrl` as the 2nd arg must move it to the 3rd. Fix those call sites.

- [ ] **Step 6: Run tests, verify PASS** — the three test files above. Then **typecheck**: `npx tsc -b` (catches any caller signature breakage). Fix any errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/frontier/orgs.ts src/lib/frontier/teams.ts src/lib/frontier/orgs.test.ts src/lib/frontier/teams.test.ts src/lib/sync/cloud-projects.ts src/lib/sync/cloud-projects.test.ts
git commit -m "feat(client): org + teams API wrappers; orgId on project list fetch"
```

---

### Task 2: `OrgProvider` + `useActiveOrg`

**Files:** create `src/context/OrgContext.tsx`, `src/context/OrgContext.test.tsx`.

- [ ] **Step 1: Write the failing test** — `src/context/OrgContext.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { OrgProvider, useActiveOrg } from "./OrgContext"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))

const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))

function Probe() {
  const { orgs, activeOrg, setActiveOrg } = useActiveOrg()
  return (
    <div>
      <span data-testid="count">{orgs.length}</span>
      <span data-testid="active">{activeOrg?.id ?? "none"}</span>
      <button onClick={() => setActiveOrg(2)}>switch</button>
    </div>
  )
}

beforeEach(() => { localStorage.clear(); listMyOrgs.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe("OrgProvider", () => {
  it("loads orgs and defaults active to the first", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }, { id: 2, name: "B", role: { level: 600, name: "maintainer" } }])
    render(<OrgProvider><Probe /></OrgProvider>)
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"))
    expect(screen.getByTestId("active").textContent).toBe("1")
  })

  it("honors a persisted activeOrgId and re-persists on switch", async () => {
    localStorage.setItem("org:active", "2")
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }, { id: 2, name: "B", role: { level: 600, name: "maintainer" } }])
    render(<OrgProvider><Probe /></OrgProvider>)
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("2"))
    await act(async () => { screen.getByText("switch").click() })
    expect(localStorage.getItem("org:active")).toBe("2")
  })

  it("falls back to first org when the persisted id is stale", async () => {
    localStorage.setItem("org:active", "999")
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
    render(<OrgProvider><Probe /></OrgProvider>)
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("1"))
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/context/OrgContext.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/context/OrgContext.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"

const STORAGE_KEY = "org:active"

interface OrgContextValue {
  orgs: OrgSummary[]
  activeOrgId: number | null
  activeOrg: OrgSummary | null
  setActiveOrg: (id: number) => void
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const OrgContext = createContext<OrgContextValue | null>(null)

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [activeOrgId, setActiveOrgId] = useState<number | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? Number(raw) : null
  })
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!jwt) { setOrgs([]); return }
    setLoading(true); setError(null)
    try {
      const list = await listMyOrgs(jwt)
      setOrgs(list)
      setActiveOrgId((cur) => (cur != null && list.some((o) => o.id === cur) ? cur : list[0]?.id ?? null))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [jwt])

  useEffect(() => { void refresh() }, [refresh])

  const setActiveOrg = useCallback((id: number) => {
    setActiveOrgId(id)
    localStorage.setItem(STORAGE_KEY, String(id))
  }, [])

  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null

  return (
    <OrgContext.Provider value={{ orgs, activeOrgId, activeOrg, setActiveOrg, isLoading, error, refresh }}>
      {children}
    </OrgContext.Provider>
  )
}

export function useActiveOrg(): OrgContextValue {
  const v = useContext(OrgContext)
  if (!v) throw new Error("useActiveOrg must be used within <OrgProvider>")
  return v
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/context/OrgContext.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/context/OrgContext.tsx src/context/OrgContext.test.tsx
git commit -m "feat(client): OrgProvider + useActiveOrg (active-org state, persisted)"
```

---

### Task 3: `OrgSwitcher`

**Files:** create `src/components/org/OrgSwitcher.tsx`, `src/components/org/OrgSwitcher.test.tsx`.

- [ ] **Step 1: Write the failing test** — `src/components/org/OrgSwitcher.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSwitcher } from "./OrgSwitcher"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))

beforeEach(() => { localStorage.clear(); listMyOrgs.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe("OrgSwitcher", () => {
  it("shows the active org and its role, and switches on select", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } },
      { id: 2, name: "Side Org", role: { level: 700, name: "owner" } },
    ])
    render(<OrgProvider><OrgSwitcher /></OrgProvider>)
    await waitFor(() => expect(screen.getByText("Come and See")).toBeInTheDocument())
    expect(screen.getByText(/maintainer/i)).toBeInTheDocument()
    // Open the menu and pick the other org
    await act(async () => { screen.getByRole("button", { name: /come and see/i }).click() })
    await act(async () => { screen.getByText("Side Org").click() })
    await waitFor(() => expect(localStorage.getItem("org:active")).toBe("2"))
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/components/org/OrgSwitcher.test.tsx`.

- [ ] **Step 3: Implement** `src/components/org/OrgSwitcher.tsx` — a button showing the active org + role; clicking toggles a menu listing all orgs (each calls `setActiveOrg`), plus a disabled "Create org — coming soon" row. Use the repo's existing menu/popover primitives if present (check `AccountSwitcher.tsx` for the pattern); otherwise a simple `useState`-toggled `<ul>`:

```tsx
import { useState } from "react"
import { ChevronsUpDown } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"

export function OrgSwitcher() {
  const { orgs, activeOrg, setActiveOrg } = useActiveOrg()
  const [open, setOpen] = useState(false)
  if (!activeOrg) return null
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{activeOrg.name ?? "Workspace"}</span>
          <span className="block text-xs text-muted-foreground">{activeOrg.role.name}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
          {orgs.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => { setActiveOrg(o.id); setOpen(false) }}
                className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="truncate">{o.name ?? "Workspace"}</span>
                <span className="text-xs text-muted-foreground">{o.role.name}</span>
              </button>
            </li>
          ))}
          <li className="border-t">
            <span className="block px-2 py-1.5 text-xs text-muted-foreground">Create org — coming soon</span>
          </li>
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/components/org/OrgSwitcher.tsx src/components/org/OrgSwitcher.test.tsx
git commit -m "feat(client): OrgSwitcher (active org + role, switch, create-soon)"
```

---

### Task 4: Org-context shell + routing

**Files:** create `src/components/org/OrgSidebar.tsx`, `src/components/org/OrgBreadcrumb.tsx`, `src/components/org/OrgHome.tsx`; modify `src/App.tsx`.

**Context:** `AppShell` props are `{ sidebar, header, statusBar, beforeMain?, main, aside? }` (the `sidebar` prop is the full left column). The org-context surfaces all render inside `AppShell` with `OrgSidebar` as `sidebar` and an `OrgBreadcrumb` in `header`. `OrgProvider` must wrap the routes.

- [ ] **Step 1: Wrap `OrgProvider`** in `src/App.tsx` — wrap `<AppRoutes />` (inside the existing provider tree) with `<OrgProvider>`:

```tsx
// import { OrgProvider } from "@/context/OrgContext"
// in App(): wrap the routes
<OrgProvider>
  <AppRoutes />
</OrgProvider>
```

- [ ] **Step 2: Add routes** to `AppRoutes` in `src/App.tsx` (keep `/project/:id` and its children unchanged):

```tsx
<Route path="/" element={<OrgHome />} />
<Route path="/projects" element={<ProjectsList />} />
<Route path="/projects/:id" element={<ProjectOverview />} />
<Route path="/teams" element={<TeamsList />} />
<Route path="/teams/:groupId" element={<TeamDetail />} />
```

Remove the old `<Route path="/" element={<Dashboard />} />`. (The `/projects` → `/` redirect line, if present, must be deleted since `/projects` is now a real surface.) Add the imports for the new components.

- [ ] **Step 3: Implement `OrgSidebar`** (`src/components/org/OrgSidebar.tsx`) — `OrgSwitcher` at top, then `NavLink`s for Overview (`/`), Projects (`/projects`), Teams (`/teams`); and, when `activeOrg.role.level >= 600`, Members (`/members`) and Settings (`/settings`):

```tsx
import { NavLink } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { OrgSwitcher } from "./OrgSwitcher"

const link = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-accent font-medium" : "hover:bg-accent/60"}`

export function OrgSidebar() {
  const { activeOrg } = useActiveOrg()
  const isAdmin = (activeOrg?.role.level ?? 0) >= 600
  return (
    <div className="flex h-full flex-col gap-1 p-2">
      <OrgSwitcher />
      <nav className="mt-2 flex flex-col gap-0.5">
        <NavLink to="/" end className={link}>Overview</NavLink>
        <NavLink to="/projects" className={link}>Projects</NavLink>
        <NavLink to="/teams" className={link}>Teams</NavLink>
        {isAdmin && <>
          <div className="my-1 border-t" />
          <NavLink to="/members" className={link}>Members</NavLink>
          <NavLink to="/settings" className={link}>Settings</NavLink>
        </>}
      </nav>
    </div>
  )
}
```

- [ ] **Step 4: Implement `OrgBreadcrumb`** (`src/components/org/OrgBreadcrumb.tsx`) — shows `‹org name› › ‹section›`:

```tsx
import { useActiveOrg } from "@/context/OrgContext"

export function OrgBreadcrumb({ section }: { section: string }) {
  const { activeOrg } = useActiveOrg()
  return (
    <div className="flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{activeOrg?.name ?? "Workspace"}</span>
      <span>›</span>
      <span>{section}</span>
    </div>
  )
}
```

- [ ] **Step 5: Implement `OrgHome`** (`src/components/org/OrgHome.tsx`) — the Overview placeholder, rendered in the shell:

```tsx
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"

export function OrgHome() {
  const { activeOrg, isLoading } = useActiveOrg()
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Overview" />}
      statusBar={null}
      main={
        <div className="p-6">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <div className="rounded-lg border p-6">
              <h1 className="text-lg font-semibold">{activeOrg?.name ?? "Workspace"}</h1>
              <p className="mt-1 text-sm text-muted-foreground">Portfolio insights coming soon.</p>
            </div>
          )}
        </div>
      }
    />
  )
}
```

- [ ] **Step 6: Write an integration test** — `src/components/org/OrgHome.test.tsx` (renders the home within a router + provider, asserts the org name + nav links appear):

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgHome } from "./OrgHome"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]) }))

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("OrgHome", () => {
  it("renders the org name, nav, and admin links for an owner", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    expect(screen.getByRole("link", { name: "Projects" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Teams" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Members" })).toBeInTheDocument() // owner → admin links
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument()
  })
})
```

(Steps 3–5 create the components that this test imports; write the test after they exist, run it to confirm the integration, per TDD-light for UI composition.)

- [ ] **Step 7: Run + typecheck** — `npx vitest run src/components/org/OrgHome.test.tsx` and `npx tsc -b`. Fix any unresolved imports from the new routes.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/components/org/OrgSidebar.tsx src/components/org/OrgBreadcrumb.tsx src/components/org/OrgHome.tsx src/components/org/OrgHome.test.tsx
git commit -m "feat(client): org-context shell — sidebar, breadcrumb, routes, Overview placeholder"
```

---

### Task 5: Org-scoped Projects list + Project overview

**Files:** create `src/components/org/ProjectsList.tsx`, `src/components/org/ProjectOverview.tsx`, `src/components/org/ProjectsList.test.tsx`. Reuse the existing `ProjectCard` and `ProjectCreateDialog` components.

- [ ] **Step 1: Write the failing test** — `src/components/org/ProjectsList.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectsList } from "./ProjectsList"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({ fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a) }))

beforeEach(() => { localStorage.clear(); fetchAccessibleProjects.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe("ProjectsList", () => {
  it("fetches projects scoped to the active org and renders them", async () => {
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] },
    ])
    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("John")).toBeInTheDocument())
    // called with the active org id (7)
    expect(fetchAccessibleProjects).toHaveBeenCalledWith("jwt", 7)
  })
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `ProjectsList`** — renders the shell; fetches `fetchAccessibleProjects(jwt, activeOrgId)`; renders each project as a row/card whose click navigates to `/projects/:id` (the overview). Include the existing `ProjectCreateDialog` trigger in the header (project creation passes the active org id — see note). Skeleton:

```tsx
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"

export function ProjectsList() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    setLoading(true)
    fetchAccessibleProjects(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setProjects(list) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Projects" />}
      statusBar={null}
      main={
        <div className="p-6">
          {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <button key={p.id} onClick={() => navigate(`/projects/${p.id}`)} className="rounded-lg border p-4 text-left hover:bg-accent/40">
                  <span className="block font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">{p.role.name}</span>
                </button>
              ))}
              {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects in this org yet.</p>}
            </div>
          )}
        </div>
      }
    />
  )
}
```

(Note: wiring the existing `ProjectCreateDialog` to create into `activeOrgId` — pass `orgId` in its create call body — and surfacing trash, are part of preserving Dashboard's affordances; add the dialog trigger to the header. If `ProjectCreateDialog`'s create call doesn't accept an org, extend it to send `orgId` to `POST /api/v2/projects`.)

- [ ] **Step 4: Implement `ProjectOverview`** (`src/components/org/ProjectOverview.tsx`) — reads `:id` from the route, fetches the project (reuse the existing `useProject(id)` hook which calls `GET /api/v2/projects/:id`), shows name + your role + file/cell counts, and a primary **Open project** button → `navigate('/project/' + id)`:

```tsx
import { useParams, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useProject } from "@/hooks/useProject"

export function ProjectOverview() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { project, status } = useProject(id)
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={project?.name ?? "Project"} />}
      statusBar={null}
      main={
        <div className="p-6">
          {status !== "ready" ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <div className="max-w-xl rounded-lg border p-6">
              <h1 className="text-lg font-semibold">{project?.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{project?.files.length ?? 0} files</p>
              <button onClick={() => navigate(`/project/${id}`)} className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
                Open project
              </button>
            </div>
          )}
        </div>
      }
    />
  )
}
```

(Confirm `useProject`'s return shape — `{ project, status }` with `status === "ready"` and `project.files` — from `src/hooks/useProject.tsx`; adjust field names if they differ.)

- [ ] **Step 5: Run the ProjectsList test, verify PASS; typecheck** (`npx tsc -b`).
- [ ] **Step 6: Commit**

```bash
git add src/components/org/ProjectsList.tsx src/components/org/ProjectOverview.tsx src/components/org/ProjectsList.test.tsx
git commit -m "feat(client): org-scoped projects list + project overview with Open project"
```

---

### Task 6: Read-only Teams surfaces

**Files:** create `src/components/org/TeamsList.tsx`, `src/components/org/TeamDetail.tsx`, `src/components/org/TeamsList.test.tsx`.

- [ ] **Step 1: Write the failing test** — `src/components/org/TeamsList.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { TeamsList } from "./TeamsList"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
const listTeams = vi.fn()
vi.mock("@/lib/frontier/teams", () => ({ listTeams: (...a: unknown[]) => listTeams(...a), getTeam: vi.fn() }))

beforeEach(() => { localStorage.clear(); listTeams.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe("TeamsList", () => {
  it("lists the active org's teams", async () => {
    listTeams.mockResolvedValue([{ id: 10, name: "West Africa", memberCount: 2, projectCount: 1, viewerIsMember: true }])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("West Africa")).toBeInTheDocument())
    expect(listTeams).toHaveBeenCalledWith("jwt", 7)
  })

  it("shows an empty state when there are no teams", async () => {
    listTeams.mockResolvedValue([])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no teams/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `TeamsList`** — fetches `listTeams(jwt, activeOrgId)`; renders rows (name + member/project counts + a "you're in this" hint), each navigating to `/teams/:id`; empty state "No teams in this org yet." Follows the same shell + fetch shape as `ProjectsList` (Task 5 Step 3) using `listTeams` from `@/lib/frontier/teams`.

- [ ] **Step 4: Implement `TeamDetail`** — reads `:groupId`, fetches `getTeam(jwt, activeOrgId, groupId)`, renders members (username + role) and attached projects (name + granted role), read-only. Same shell shape; `OrgBreadcrumb section={team?.name ?? "Team"}`.

- [ ] **Step 5: Run the TeamsList test, verify PASS; typecheck.**
- [ ] **Step 6: Commit**

```bash
git add src/components/org/TeamsList.tsx src/components/org/TeamDetail.tsx src/components/org/TeamsList.test.tsx
git commit -m "feat(client): read-only Teams list + detail"
```

---

### Task 7: Re-point MembersPage at the active org

**Files:** modify `src/pages/MembersPage.tsx`.

**Context:** `MembersPage` currently calls `useOrg()` (the owned org via `/orgs/me`) and renders `<MembersPageContent orgId={state.org.id} … />`. It should manage the **active** org instead.

- [ ] **Step 1: Write the failing test** — `src/pages/MembersPage.test.tsx` (new):

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { MembersPage } from "./MembersPage"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 42, name: "Come and See", role: { level: 700, name: "owner" } }]),
  // keep other named exports used by MembersPageContent as needed:
  listOrgMembers: vi.fn(async () => []),
}))

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("MembersPage active-org", () => {
  it("renders members for the active org (42), not /orgs/me", async () => {
    render(<MemoryRouter><OrgProvider><MembersPage /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Come and See")).toBeInTheDocument())
  })
})
```

(Adjust the `@/lib/frontier/orgs` mock to include every named export `MembersPageContent` actually imports — check the file — so the mock doesn't drop them.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — replace the `useOrg()` usage in `MembersPage` with `useActiveOrg()`, deriving the same `{ orgId, orgName }` for `MembersPageContent`:

```tsx
import { useActiveOrg } from "@/context/OrgContext"
// …
export function MembersPage() {
  const { activeOrg, isLoading, error } = useActiveOrg()
  if (isLoading) return <PageShell><p className="p-6 text-sm text-muted-foreground">Loading…</p></PageShell>
  if (error) return <PageShell><p className="p-6 text-sm text-destructive">{error}</p></PageShell>
  if (!activeOrg) return <PageShell><p className="p-6 text-sm">Sign in to manage members</p></PageShell>
  return <MembersPageContent orgId={activeOrg.id} orgName={activeOrg.name ?? "Organization"} />
}
```

Keep `MembersPageContent` and its member CRUD unchanged. Remove the now-unused `useOrg` import if nothing else uses it.

- [ ] **Step 4: Run the MembersPage test + full client suite** — `npx vitest run` (whole client suite must stay green) and `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/MembersPage.tsx src/pages/MembersPage.test.tsx
git commit -m "feat(client): MembersPage manages the active org"
```

---

## Self-Review

- **Spec coverage:** OrgProvider/active-org + persistence (Task 2); switcher (Task 3); shell + sidebar + breadcrumbs + routes + Overview placeholder (Task 4); org-scoped projects list, no local/cloud split, project overview + Open project (Task 5); read-only Teams (Task 6); Members re-pointed to active org (Task 7); API layer incl. `orgId` on the list + teams wrappers (Task 1). Matches the spec's Phase 1 client scope.
- **Type consistency:** `OrgSummary` (Task 1) is consumed by `OrgProvider`/`useActiveOrg` (Task 2) and every surface; `TeamSummary`/`TeamDetail` (Task 1) by Task 6; `CloudProjectSummary.orgId` (Task 1) by Task 5. `fetchAccessibleProjects(jwt, orgId)` signature (Task 1) is called exactly that way in Task 5's test + impl.
- **Placeholder scan:** Three spots call for verifying an existing API against the repo before coding (they're flagged inline, not left vague): (a) `ProjectCreateDialog`'s create call must send `orgId` — extend it if it doesn't (Task 5 Step 3 note); (b) `useProject`'s return shape `{ project, status }` (Task 5 Step 4 note); (c) the `@/lib/frontier/orgs` mock in Task 7 must list every named export `MembersPageContent` imports. Each names exactly what to check and what to do.
- **Risk — replacing `/`:** Task 4 removes the flat `Dashboard` at `/`. Project creation, account switching, and trash must be preserved by reusing `ProjectCreateDialog`/`AccountSwitcher`/trash inside the org shell (Task 5 note). If the implementer finds a Dashboard affordance with no home in the new shell, surface it (DONE_WITH_CONCERNS) rather than dropping it.

## Execution Handoff

After this plan executes, the org-context shell is live end-to-end against the merged backend. Phase 2 (distilled Overview, Teams lifecycle/management, archive, org create/rename) follows in its own spec + plan.
