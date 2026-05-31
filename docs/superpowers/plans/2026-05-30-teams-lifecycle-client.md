# Teams Lifecycle — Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add team management UI on top of the Phase 1 read-only Teams surfaces: create/rename/delete teams, add/remove members (from org members), and attach/detach projects at a role — all admin-gated (org role ≥ maintainer).

**Architecture:** Extend `src/lib/frontier/teams.ts` with typed wrappers for the 8 backend endpoints, then add admin affordances to `TeamsList` (create) and `TeamDetail` (rename/delete/members/projects). Admin status = `useActiveOrg().activeOrg?.role.level ≥ 600`. Member picker reuses `listOrgMembers`; project picker reuses `fetchAccessibleProjects`. No new routes.

**Tech Stack:** React 19, react-router v7, vitest + happy-dom + RTL. Test pattern: `vi.mock("@/hooks/useFrontierSession", …)`, `vi.mock("@/lib/frontier/orgs", …)` (for `listMyOrgs` + `listOrgMembers`), `vi.mock("@/lib/frontier/teams", …)`, and `MemoryRouter` for components using `useNavigate`/`useParams`.

**Depends on:** the Teams backend (this branch) — `POST/PATCH/DELETE /orgs/:orgId/groups[/:groupId]`, `.../members[/:userId]`, `.../projects[/:projectId]`. **Spec:** [docs/superpowers/specs/2026-05-30-teams-lifecycle-management-design.md](../specs/2026-05-30-teams-lifecycle-management-design.md).

Run client tests from the worktree root: `npx vitest run <path>`; typecheck `npx tsc -b`.

---

## Current State (verified, in this worktree)

- `src/lib/frontier/teams.ts`: imports `FRONTIER_BASE` + `fetchWithTimeout` (from `./orgs`); has `listTeams`/`getTeam` + `TeamSummary`/`TeamDetail` types + a local `authHeaders`.
- `src/components/org/TeamsList.tsx`: read-only grid of team cards → `navigate('/teams/:id')`; uses `useActiveOrg().activeOrgId`, `useFrontierSession`.
- `src/components/org/TeamDetail.tsx`: read-only Members + Projects sections; uses `useParams` `groupId`, `useActiveOrg().activeOrgId`, `getTeam`. `TeamDetail` member rows show `{username}` + `Level N`; project rows show `{name}` + `Level N`.
- `useActiveOrg()` returns `{ activeOrgId, activeOrg, ... }`; `activeOrg.role.level` is the caller's org role.
- `listOrgMembers(jwt, orgId): Promise<OrgMember[]>` exists in `src/lib/frontier/orgs.ts` (`OrgMember = { userId, username, role: { level, name } }`).
- `fetchAccessibleProjects(jwt, orgId?)` exists in `src/lib/sync/cloud-projects.ts` (returns `{ id, name, orgId, role, files }[]`).

---

## File Structure

- `src/lib/frontier/teams.ts` — **modify**: add 8 mutation wrappers + `teams.test.ts` coverage.
- `src/components/org/TeamsList.tsx` — **modify**: admin "New team" + create form.
- `src/components/org/TeamDetail.tsx` — **modify**: admin rename/delete/members/projects management.
- `src/components/org/TeamsList.test.tsx`, `TeamDetail.test.tsx` — **modify/extend** with management tests.

Role options (canonical ladder) used by the role selects:

```ts
const ROLE_OPTIONS = [
  { level: 100, name: "viewer" },
  { level: 200, name: "commenter" },
  { level: 300, name: "reviewer" },
  { level: 400, name: "contributor" },
  { level: 500, name: "project_lead" },
  { level: 600, name: "maintainer" },
  { level: 700, name: "owner" },
] as const
```

---

### Task C1: `teams.ts` mutation wrappers

**Files:** modify `src/lib/frontier/teams.ts`; modify `src/lib/frontier/teams.test.ts`.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/frontier/teams.test.ts`:

```ts
import { createTeam, updateTeam, deleteTeam, addTeamMember, removeTeamMember, attachProject, changeProjectRole, detachProject } from "./teams"

describe("teams mutations", () => {
  function captureFetch(responseBody: unknown = {}) {
    const calls: { url: string; method: string; body: string | null }[] = []
    global.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url
      calls.push({ url, method: (init?.method as string) ?? "GET", body: (init?.body as string) ?? null })
      return new Response(JSON.stringify(responseBody), { status: 200 })
    }) as unknown as typeof fetch
    return calls
  }

  it("createTeam POSTs name + description", async () => {
    const calls = captureFetch({ id: 5, name: "WA", description: "d" })
    const t = await createTeam("jwt", 1, "WA", "d")
    expect(calls[0]).toMatchObject({ method: "POST" })
    expect(calls[0].url).toMatch(/\/api\/v2\/orgs\/1\/groups$/)
    expect(JSON.parse(calls[0].body!)).toEqual({ name: "WA", description: "d" })
    expect(t).toEqual({ id: 5, name: "WA", description: "d" })
  })

  it("updateTeam PATCHes the group", async () => {
    const calls = captureFetch({ id: 5, name: "New", description: null })
    await updateTeam("jwt", 1, 5, { name: "New" })
    expect(calls[0].method).toBe("PATCH")
    expect(calls[0].url).toMatch(/\/groups\/5$/)
    expect(JSON.parse(calls[0].body!)).toEqual({ name: "New" })
  })

  it("deleteTeam DELETEs the group", async () => {
    const calls = captureFetch({ removed: true })
    await deleteTeam("jwt", 1, 5)
    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toMatch(/\/groups\/5$/)
  })

  it("addTeamMember POSTs a username", async () => {
    const calls = captureFetch({ userId: 2, username: "anna" })
    await addTeamMember("jwt", 1, 5, "anna")
    expect(calls[0].url).toMatch(/\/groups\/5\/members$/)
    expect(JSON.parse(calls[0].body!)).toEqual({ username: "anna" })
  })

  it("removeTeamMember DELETEs by userId", async () => {
    const calls = captureFetch({ removed: true })
    await removeTeamMember("jwt", 1, 5, 2)
    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toMatch(/\/groups\/5\/members\/2$/)
  })

  it("attachProject POSTs projectId + roleLevel", async () => {
    const calls = captureFetch({ projectId: "pa", roleLevel: 400 })
    await attachProject("jwt", 1, 5, "pa", 400)
    expect(calls[0].url).toMatch(/\/groups\/5\/projects$/)
    expect(JSON.parse(calls[0].body!)).toEqual({ projectId: "pa", roleLevel: 400 })
  })

  it("changeProjectRole PATCHes the grant", async () => {
    const calls = captureFetch({ projectId: "pa", roleLevel: 300 })
    await changeProjectRole("jwt", 1, 5, "pa", 300)
    expect(calls[0].method).toBe("PATCH")
    expect(calls[0].url).toMatch(/\/groups\/5\/projects\/pa$/)
  })

  it("detachProject DELETEs the grant", async () => {
    const calls = captureFetch({ removed: true })
    await detachProject("jwt", 1, 5, "pa")
    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toMatch(/\/groups\/5\/projects\/pa$/)
  })
})
```

Ensure the file's top has `import { describe, it, expect, afterEach, vi } from "vitest"` and an `afterEach` restoring `global.fetch` (match the existing `teams.test.ts` setup — it already restores fetch for `listTeams`/`getTeam`).

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/lib/frontier/teams.test.ts`.

- [ ] **Step 3: Implement** — append to `src/lib/frontier/teams.ts`:

```ts
export async function createTeam(jwt: string, orgId: number, name: string, description?: string): Promise<{ id: number; name: string; description: string | null }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(description != null ? { name, description } : { name }) })
  if (!res.ok) throw new Error(`createTeam failed: HTTP ${res.status}`)
  return (await res.json()) as { id: number; name: string; description: string | null }
}

export async function updateTeam(jwt: string, orgId: number, groupId: number, patch: { name?: string; description?: string }): Promise<{ id: number; name: string; description: string | null }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify(patch) })
  if (!res.ok) throw new Error(`updateTeam failed: HTTP ${res.status}`)
  return (await res.json()) as { id: number; name: string; description: string | null }
}

export async function deleteTeam(jwt: string, orgId: number, groupId: number): Promise<void> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}`, { method: "DELETE", headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`deleteTeam failed: HTTP ${res.status}`)
}

export async function addTeamMember(jwt: string, orgId: number, groupId: number, username: string): Promise<{ userId: number; username: string }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/members`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ username }) })
  if (!res.ok) throw new Error(`addTeamMember failed: HTTP ${res.status}`)
  return (await res.json()) as { userId: number; username: string }
}

export async function removeTeamMember(jwt: string, orgId: number, groupId: number, userId: number): Promise<void> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/members/${userId}`, { method: "DELETE", headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`removeTeamMember failed: HTTP ${res.status}`)
}

export async function attachProject(jwt: string, orgId: number, groupId: number, projectId: string, roleLevel: number): Promise<{ projectId: string; roleLevel: number }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/projects`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ projectId, roleLevel }) })
  if (!res.ok) throw new Error(`attachProject failed: HTTP ${res.status}`)
  return (await res.json()) as { projectId: string; roleLevel: number }
}

export async function changeProjectRole(jwt: string, orgId: number, groupId: number, projectId: string, roleLevel: number): Promise<{ projectId: string; roleLevel: number }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ roleLevel }) })
  if (!res.ok) throw new Error(`changeProjectRole failed: HTTP ${res.status}`)
  return (await res.json()) as { projectId: string; roleLevel: number }
}

export async function detachProject(jwt: string, orgId: number, groupId: number, projectId: string): Promise<void> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`detachProject failed: HTTP ${res.status}`)
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/frontier/teams.test.ts` + `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/frontier/teams.ts src/lib/frontier/teams.test.ts
git commit -m "feat(client): teams.ts mutation wrappers (create/update/delete/members/projects)"
```

---

### Task C2: TeamsList — create a team (admin)

**Files:** modify `src/components/org/TeamsList.tsx`, `src/components/org/TeamsList.test.tsx`.

- [ ] **Step 1: Write the failing test** — append to `src/components/org/TeamsList.test.tsx` (its top already mocks `useFrontierSession`, `@/lib/frontier/orgs` `listMyOrgs`, and `@/lib/frontier/teams` `listTeams`; extend the teams mock to also export `createTeam`):

```ts
// In the existing vi.mock("@/lib/frontier/teams", …), add createTeam to the returned object:
//   createTeam: (...a: unknown[]) => createTeam(...a)
// and at top: const createTeam = vi.fn()

describe("TeamsList admin create", () => {
  it("shows New team for an org admin and creates a team", async () => {
    // listMyOrgs mock returns an org where role.level >= 600 (owner)
    listTeams.mockResolvedValue([])
    createTeam.mockResolvedValue({ id: 99, name: "West Africa", description: null })
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no teams/i)).toBeInTheDocument())
    const newBtn = screen.getByRole("button", { name: /new team/i })
    await act(async () => { newBtn.click() })
    const input = screen.getByPlaceholderText(/team name/i)
    await act(async () => { fireEvent.change(input, { target: { value: "West Africa" } }) })
    await act(async () => { screen.getByRole("button", { name: /^create$/i }).click() })
    await waitFor(() => expect(createTeam).toHaveBeenCalledWith("jwt", expect.any(Number), "West Africa", undefined))
  })

  it("hides New team for a non-admin", async () => {
    // Re-mock listMyOrgs to return role.level < 600 for this test (e.g. 100)
    // (set the orgs mock's resolved value to [{ id, name, role: { level: 100, name: "viewer" } }])
    listTeams.mockResolvedValue([])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no teams/i)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /new team/i })).toBeNull()
  })
})
```

Ensure imports at the top include `fireEvent`, `act`, `waitFor` from `@testing-library/react` and the `OrgProvider`/`MemoryRouter`. The admin test needs the `listMyOrgs` mock to yield an org with `role.level >= 600`; the non-admin test needs `< 600` — set the mock's resolved value per test with `listMyOrgs.mockResolvedValue([...])` inside each test (make `listMyOrgs` a `vi.fn()` in the orgs mock).

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/components/org/TeamsList.test.tsx`.

- [ ] **Step 3: Implement** — in `src/components/org/TeamsList.tsx`: pull `activeOrg` from `useActiveOrg()`; compute `const isAdmin = (activeOrg?.role.level ?? 0) >= 600`. Add `createTeam` to the teams import. Add a header row above the grid with a **New team** button (only when `isAdmin`) that toggles an inline create form (controlled `name` + optional `description` inputs + a **Create** button). On Create: `const t = await createTeam(jwt, activeOrgId, name.trim(), description.trim() || undefined); navigate(\`/teams/${t.id}\`)`. Guard `jwt`/`activeOrgId` non-null. Example header block to render inside `main`, above the grid:

```tsx
{isAdmin && (
  <div className="mb-4">
    {!creating ? (
      <button onClick={() => setCreating(true)} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">New team</button>
    ) : (
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!jwt || activeOrgId == null || !name.trim()) return
          const t = await createTeam(jwt, activeOrgId, name.trim(), description.trim() || undefined)
          navigate(`/teams/${t.id}`)
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" className="rounded-md border px-2 py-1 text-sm" />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="rounded-md border px-2 py-1 text-sm" />
        <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Create</button>
        <button type="button" onClick={() => setCreating(false)} className="text-sm text-muted-foreground">Cancel</button>
      </form>
    )}
  </div>
)}
```

Add the `creating`/`name`/`description` `useState` declarations near the top of the component.

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/components/org/TeamsList.test.tsx` + `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add src/components/org/TeamsList.tsx src/components/org/TeamsList.test.tsx
git commit -m "feat(client): create a team from TeamsList (admin)"
```

---

### Task C3: TeamDetail — rename / delete / members (admin)

**Files:** modify `src/components/org/TeamDetail.tsx`; create `src/components/org/TeamDetail.test.tsx` (or extend if present).

- [ ] **Step 1: Write the failing test** — `src/components/org/TeamDetail.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { TeamDetail } from "./TeamDetail"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }) }))
const listMyOrgs = vi.fn(async () => [{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
const listOrgMembers = vi.fn(async () => [{ userId: 2, username: "anna", role: { level: 100, name: "viewer" } }])
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a), listOrgMembers: (...a: unknown[]) => listOrgMembers(...a) }))
const getTeam = vi.fn()
const addTeamMember = vi.fn(async () => ({ userId: 2, username: "anna" }))
const removeTeamMember = vi.fn(async () => {})
const deleteTeam = vi.fn(async () => {})
const updateTeam = vi.fn(async () => ({ id: 10, name: "WA2", description: null }))
vi.mock("@/lib/frontier/teams", () => ({
  getTeam: (...a: unknown[]) => getTeam(...a),
  addTeamMember: (...a: unknown[]) => addTeamMember(...a),
  removeTeamMember: (...a: unknown[]) => removeTeamMember(...a),
  deleteTeam: (...a: unknown[]) => deleteTeam(...a),
  updateTeam: (...a: unknown[]) => updateTeam(...a),
  attachProject: vi.fn(), changeProjectRole: vi.fn(), detachProject: vi.fn(),
}))
vi.mock("@/lib/sync/cloud-projects", () => ({ fetchAccessibleProjects: vi.fn(async () => []) }))

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/teams/10"]}>
      <OrgProvider>
        <Routes><Route path="/teams/:groupId" element={<TeamDetail />} /></Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => { localStorage.clear(); getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] }) })
afterEach(() => vi.restoreAllMocks())

describe("TeamDetail admin management", () => {
  it("adds a member via the org-member picker", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    // an "Add member" control exists for an owner; pick anna + add
    const addBtn = await screen.findByRole("button", { name: /add member/i })
    await act(async () => { addBtn.click() })
    // a select of org members appears; choose anna (value = username) then confirm
    const select = screen.getByRole("combobox")
    await act(async () => { fireEvent.change(select, { target: { value: "anna" } }) })
    await act(async () => { screen.getByRole("button", { name: /^add$/i }).click() })
    await waitFor(() => expect(addTeamMember).toHaveBeenCalledWith("jwt", 1, 10, "anna"))
  })

  it("removes a member", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /remove anna/i }).click() })
    await waitFor(() => expect(removeTeamMember).toHaveBeenCalledWith("jwt", 1, 10, 2))
  })

  it("deletes the team after confirm", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText(/members/i)).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /delete team/i }).click() })
    await act(async () => { screen.getByRole("button", { name: /confirm/i }).click() })
    await waitFor(() => expect(deleteTeam).toHaveBeenCalledWith("jwt", 1, 10))
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/components/org/TeamDetail.test.tsx`.

- [ ] **Step 3: Implement** — in `src/components/org/TeamDetail.tsx`:
  - Pull `activeOrg` from `useActiveOrg()`; `const isAdmin = (activeOrg?.role.level ?? 0) >= 600`.
  - Add imports: `addTeamMember, removeTeamMember, deleteTeam, updateTeam` from `@/lib/frontier/teams`; `listOrgMembers, type OrgMember` from `@/lib/frontier/orgs`; `useNavigate` from `react-router-dom`.
  - Add a `refetch()` that re-runs `getTeam` and sets state (extract the effect body into a callback so handlers can re-fetch after mutations).
  - When `isAdmin`, in the header area: a **rename/edit** affordance (an "Edit" toggle revealing name + description inputs + Save → `updateTeam(jwt, activeOrgId, groupIdNum, { name, description })` then `refetch()`), and a **Delete team** button that opens an inline confirm ("Delete '<name>'? …" with **Confirm** + **Cancel**); Confirm → `await deleteTeam(jwt, activeOrgId, groupIdNum); navigate('/teams')`.
  - **Members section (admin):** load org members on mount when admin (`listOrgMembers(jwt, activeOrgId)` into `orgMembers` state). An "Add member" button reveals a `<select>` (options = org members not already on the team, `value` = username) + an **Add** button → `await addTeamMember(jwt, activeOrgId, groupIdNum, username); refetch()`. Each member row (when admin) gets a **Remove** button with accessible name `Remove {username}` → `await removeTeamMember(jwt, activeOrgId, groupIdNum, m.userId); refetch()`.
  - Non-admins keep the read-only sections (unchanged).
  - Guard all handlers on `jwt && activeOrgId != null && groupIdNum != null`.

  (Projects management is added in Task C4 — leave the Projects section read-only in this task.)

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/components/org/TeamDetail.test.tsx` + `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add src/components/org/TeamDetail.tsx src/components/org/TeamDetail.test.tsx
git commit -m "feat(client): TeamDetail rename/delete + member management (admin)"
```

---

### Task C4: TeamDetail — project attachment management (admin)

**Files:** modify `src/components/org/TeamDetail.tsx`, `src/components/org/TeamDetail.test.tsx`.

- [ ] **Step 1: Write the failing test** — append to `TeamDetail.test.tsx`:

```ts
describe("TeamDetail project management", () => {
  it("attaches a project at a role", async () => {
    // extend the cloud-projects mock to return an org project:
    const { fetchAccessibleProjects } = await import("@/lib/sync/cloud-projects")
    ;(fetchAccessibleProjects as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "pa", name: "Bambara", orgId: 1, role: { level: 700, name: "owner", source: "creator" }, files: [] }])
    const { attachProject } = await import("@/lib/frontier/teams")
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [], projects: [] })
    renderDetail()
    await waitFor(() => expect(screen.getByText(/projects/i)).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /attach project/i })).click() })
    const selects = screen.getAllByRole("combobox")
    // project select + role select
    await act(async () => { fireEvent.change(selects[0], { target: { value: "pa" } }) })
    await act(async () => { fireEvent.change(selects[1], { target: { value: "400" } }) })
    await act(async () => { screen.getByRole("button", { name: /^attach$/i }).click() })
    await waitFor(() => expect(attachProject).toHaveBeenCalledWith("jwt", 1, 10, "pa", 400))
  })

  it("detaches a project", async () => {
    const { detachProject } = await import("@/lib/frontier/teams")
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [], projects: [{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }] })
    renderDetail()
    await waitFor(() => expect(screen.getByText("Bambara")).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /detach bambara/i }).click() })
    await waitFor(() => expect(detachProject).toHaveBeenCalledWith("jwt", 1, 10, "pa"))
  })
})
```

(Note: the C3 `vi.mock("@/lib/frontier/teams", …)` already includes `attachProject`/`changeProjectRole`/`detachProject` as `vi.fn()` — change those to module-level `vi.fn()` consts wired the same way as `addTeamMember` so the tests can assert on them, mirroring C3's pattern.)

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/components/org/TeamDetail.test.tsx`.

- [ ] **Step 3: Implement** — in `TeamDetail.tsx`, add (admin-only) to the Projects section:
  - Import `attachProject, changeProjectRole, detachProject` from `@/lib/frontier/teams`; `fetchAccessibleProjects, type CloudProjectSummary` from `@/lib/sync/cloud-projects`. Define the `ROLE_OPTIONS` constant (from the File Structure section above) at module scope.
  - Load org projects when admin (`fetchAccessibleProjects(jwt, activeOrgId)` into `orgProjects` state).
  - An **Attach project** button reveals a project `<select>` (options = org projects not already attached, `value` = project id) + a role `<select>` (options from `ROLE_OPTIONS`, `value` = level as string) + an **Attach** button → `await attachProject(jwt, activeOrgId, groupIdNum, projectId, Number(roleLevel)); refetch()`.
  - Each attached-project row (admin): a role `<select>` bound to the row's current `grantedRoleLevel` → on change `await changeProjectRole(jwt, activeOrgId, groupIdNum, p.id, Number(newLevel)); refetch()`; and a **Detach** button with accessible name `Detach {name}` → `await detachProject(jwt, activeOrgId, groupIdNum, p.id); refetch()`.
  - Non-admins keep the read-only project rows.

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/components/org/TeamDetail.test.tsx` + full client suite `npx vitest run` + `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add src/components/org/TeamDetail.tsx src/components/org/TeamDetail.test.tsx
git commit -m "feat(client): TeamDetail project attach/role/detach (admin)"
```

---

## Self-Review

- **Spec coverage:** mutation wrappers (C1) ✓; create team (C2) ✓; rename/delete/members (C3) ✓; project attach/change-role/detach (C4) ✓. Admin-gating via `activeOrg.role.level >= 600` on every affordance ✓. Member picker is org-scoped (`listOrgMembers`) ✓; project picker is org-scoped (`fetchAccessibleProjects(jwt, activeOrgId)`) ✓.
- **Type consistency:** the 8 wrappers in C1 are consumed by C2–C4 with matching signatures `(jwt, orgId, groupId, …)`. `ROLE_OPTIONS` is defined once and used by both attach + change-role selects. `refetch()` (defined in C3) is reused in C4.
- **Placeholder scan:** none — every step has runnable code or a precise, code-level implementation description. Two implementer notes are flagged explicitly: (a) wire `attachProject`/`changeProjectRole`/`detachProject` as asserting `vi.fn()` consts in the shared teams mock (C4 Step 1 note); (b) per-test `listMyOrgs.mockResolvedValue` to vary admin vs non-admin org role (C2 Step 1 note).

## Execution Handoff

This completes the Teams feature (backend + client) on `worktree-teams-lifecycle`. Merge to main waits until the user's working tree is clean (the spec/branch are isolated). A browser pass (create a team → add a member → attach a project) is the natural post-merge verification.
