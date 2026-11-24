import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useNavigate } from "react-router-dom"
import { OrgProvider, useActiveOrg } from "./OrgContext"
import { useOrgLookup } from "@/hooks/useOrgLookup"

// An org a platform admin opens without belonging to it is in neither `orgs`
// (memberships) nor `guestOrgs` (project grants). These cover how the provider
// fetches such an org by id, and what `useOrgLookup` hands the chrome that has
// to name it — the breadcrumb used to skip the level altogether.

// This vitest/happy-dom env doesn't provide localStorage; OrgContext reads and
// writes it synchronously (same shim as OrgContext.test.tsx).
if (typeof globalThis.localStorage === "undefined") {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)) },
      removeItem: (k: string) => { map.delete(k) },
      clear: () => { map.clear() },
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() { return map.size },
    },
  })
}

const sessionState: {
  session: { jwt: string; username: string; createdAt: string } | null
  loading: boolean
} = {
  session: { jwt: "jwt", username: "anna", createdAt: "x" },
  loading: false,
}
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => sessionState,
}))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))
const getOrg = vi.fn()
vi.mock("@/lib/frontier/get-org", () => ({ getOrg: (...a: unknown[]) => getOrg(...a) }))
const fetchAccessibleProjects = vi.fn()
// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: async (...a: unknown[]) => ({
    ok: true,
    projects: await fetchAccessibleProjects(...a),
  }),
}))

const OWN_ORGS = [
  { id: 1, name: "Mine", role: { level: 700, name: "owner" } },
  { id: 2, name: "Also mine", role: { level: 600, name: "maintainer" } },
]

function catalogOrg(id: number, name: string) {
  return { id, name, role: { level: 700, name: "admin" }, viaPlatformAdmin: true }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function Probe() {
  const navigate = useNavigate()
  const { activeOrg, activeGuestOrg, refresh } = useActiveOrg()
  const lookup = useOrgLookup(9)
  return (
    <div>
      <span data-testid="active">{activeOrg ? `${activeOrg.id}:${activeOrg.name}` : "none"}</span>
      <span data-testid="guest">{activeGuestOrg?.id ?? "none"}</span>
      <span data-testid="lookup">{lookup.pending ? "pending" : lookup.org?.name ?? "none"}</span>
      <button onClick={() => navigate("/orgs/10/projects")}>open-org-10</button>
      <button onClick={() => { void refresh() }}>reload-orgs</button>
    </div>
  )
}

function renderAt(path: string) {
  const tree = () => (
    <MemoryRouter initialEntries={[path]}>
      <OrgProvider><Probe /></OrgProvider>
    </MemoryRouter>
  )
  return { tree, view: render(tree()) }
}

const text = (testId: string) => screen.getByTestId(testId).textContent

beforeEach(() => {
  localStorage.clear()
  sessionState.loading = false
  sessionState.session = { jwt: "jwt", username: "anna", createdAt: "x" }
  listMyOrgs.mockReset()
  listMyOrgs.mockResolvedValue(OWN_ORGS)
  getOrg.mockReset()
  getOrg.mockResolvedValue(null)
  fetchAccessibleProjects.mockReset()
  fetchAccessibleProjects.mockResolvedValue([])
})

describe("an org the caller can open without belonging to it", () => {
  it("names the active org, asking the server once for the provider and the chrome together", async () => {
    getOrg.mockResolvedValue(catalogOrg(9, "aaaaa"))

    renderAt("/orgs/9/projects")

    await waitFor(() => expect(text("active")).toBe("9:aaaaa"))
    expect(text("lookup")).toBe("aaaaa")
    expect(getOrg).toHaveBeenCalledTimes(1)
    expect(getOrg).toHaveBeenCalledWith("jwt", 9)
  })

  it("names a project's org when that org is not the active one", async () => {
    getOrg.mockResolvedValue(catalogOrg(9, "aaaaa"))

    renderAt("/project/p1/editor")

    await waitFor(() => expect(text("lookup")).toBe("aaaaa"))
    expect(text("active")).toBe("none")
    expect(getOrg).toHaveBeenCalledTimes(1)
  })

  it("is pending until the answer is in, and settles on no org when refused", async () => {
    const answer = deferred<null>()
    getOrg.mockReturnValue(answer.promise)

    renderAt("/project/p1/editor")

    await waitFor(() => expect(getOrg).toHaveBeenCalledTimes(1))
    expect(text("lookup")).toBe("pending")

    await act(async () => { answer.resolve(null) })
    expect(text("lookup")).toBe("none")
  })

  it("never names one looked-up org under another's id", async () => {
    const second = deferred<ReturnType<typeof catalogOrg>>()
    getOrg.mockImplementation((_jwt: string, id: number) =>
      id === 9 ? Promise.resolve(catalogOrg(9, "aaaaa")) : second.promise)

    renderAt("/orgs/9/projects")
    await waitFor(() => expect(text("active")).toBe("9:aaaaa"))

    await act(async () => { screen.getByText("open-org-10").click() })
    await waitFor(() => expect(getOrg).toHaveBeenCalledWith("jwt", 10))
    // Org 10's answer is still out: the previous org's name must not stand in.
    expect(text("active")).toBe("none")

    await act(async () => { second.resolve(catalogOrg(10, "bbbbb")) })
    expect(text("active")).toBe("10:bbbbb")
  })

  it("keeps the last answer up while a reload of the org list re-checks it", async () => {
    getOrg.mockResolvedValueOnce(catalogOrg(9, "aaaaa"))
    renderAt("/project/p1/editor")
    await waitFor(() => expect(text("lookup")).toBe("aaaaa"))

    const recheck = deferred<ReturnType<typeof catalogOrg>>()
    getOrg.mockReturnValueOnce(recheck.promise)
    await act(async () => { screen.getByText("reload-orgs").click() })

    await waitFor(() => expect(getOrg).toHaveBeenCalledTimes(2))
    expect(text("lookup")).toBe("aaaaa")

    await act(async () => { recheck.resolve(catalogOrg(9, "renamed")) })
    expect(text("lookup")).toBe("renamed")
  })

  it("keeps the last answer when a re-check fails outright", async () => {
    getOrg.mockResolvedValueOnce(catalogOrg(9, "aaaaa"))
    renderAt("/project/p1/editor")
    await waitFor(() => expect(text("lookup")).toBe("aaaaa"))

    getOrg.mockRejectedValueOnce(new Error("offline"))
    await act(async () => { screen.getByText("reload-orgs").click() })

    await waitFor(() => expect(getOrg).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(text("lookup")).toBe("aaaaa")
  })

  it("does not look up a guest org, which is named from the project directory", async () => {
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p9", name: "Shared", orgId: 9, orgName: "Guest Co", role: { level: 100, name: "viewer", source: "project" } },
    ])

    renderAt("/orgs/9/projects")

    await waitFor(() => expect(text("guest")).toBe("9"))
    expect(text("active")).toBe("none")
    expect(text("lookup")).toBe("none")
    expect(getOrg).not.toHaveBeenCalled()
  })

  it("drops an answer that arrives after the account changed", async () => {
    const late = deferred<ReturnType<typeof catalogOrg>>()
    getOrg.mockImplementation((jwt: string) =>
      jwt === "jwt" ? late.promise : Promise.resolve(catalogOrg(9, "theirs")))

    const { tree, view } = renderAt("/project/p1/editor")
    await waitFor(() => expect(getOrg).toHaveBeenCalledWith("jwt", 9))

    sessionState.session = { jwt: "jwt-2", username: "bob", createdAt: "y" }
    view.rerender(tree())
    await waitFor(() => expect(text("lookup")).toBe("theirs"))

    await act(async () => { late.resolve(catalogOrg(9, "mine")) })
    expect(text("lookup")).toBe("theirs")
  })

  it("is never pending when signed out: there is nobody to ask", async () => {
    sessionState.session = null

    renderAt("/orgs/9/projects")

    expect(text("lookup")).toBe("none")
    await act(async () => {})
    expect(text("lookup")).toBe("none")
    expect(getOrg).not.toHaveBeenCalled()
  })
})
