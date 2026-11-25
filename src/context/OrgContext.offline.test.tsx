import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider, useActiveOrg } from "./OrgContext"
import { UserError } from "@/lib/errors/user-error"
import { readOrgDirectory, rememberOrgDirectory } from "@/lib/offline/org-directory-cache"

// Desktop: the org lists fall back to the last online load when the server
// can't be reached, so an offline launch can still reach downloaded projects.

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

vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => true }))

const connectivityListeners = new Set<(online: boolean | null) => void>()
let currentConnectivity: boolean | null = null
vi.mock("@/lib/offline/connectivity", () => ({
  desktopConnectivity: {
    current: () => currentConnectivity,
    subscribe: (listener: (online: boolean | null) => void) => {
      connectivityListeners.add(listener)
      return () => connectivityListeners.delete(listener)
    },
  },
}))

const sessionState = {
  session: { jwt: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig", username: "anna", createdAt: "x" },
  loading: false,
}
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => sessionState }))

const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))

const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: (...a: unknown[]) => fetchAccessibleProjects(...a),
}))

const memberOrg = { id: 1, name: "Acme", role: { level: 300, name: "translator" } }
const guestProject = { id: "p9", name: "Shared", gitlabProjectId: null, orgId: 9, orgName: "Guesthouse" }

function Probe() {
  const { orgs, guestOrgs, error, accessibleProjectsError, offline, isLoading, accessibleProjectsLoading } = useActiveOrg()
  return (
    <div>
      <span data-testid="orgs">{orgs.map((o) => o.name).join(",")}</span>
      <span data-testid="guests">{guestOrgs.map((o) => o.name).join(",")}</span>
      <span data-testid="error">{error ?? "none"}</span>
      <span data-testid="projects-error">{accessibleProjectsError ?? "none"}</span>
      <span data-testid="offline">{offline ? "yes" : "no"}</span>
      <span data-testid="settled">{!isLoading && !accessibleProjectsLoading ? "yes" : "no"}</span>
    </div>
  )
}

function renderProvider() {
  return render(
    <MemoryRouter initialEntries={["/orgs/all"]}>
      <OrgProvider><Probe /></OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
  connectivityListeners.clear()
  currentConnectivity = null
  vi.useRealTimers()
})

describe("OrgProvider offline fallback (desktop)", () => {
  it("remembers the lists from an online load", async () => {
    listMyOrgs.mockResolvedValue([memberOrg])
    fetchAccessibleProjects.mockResolvedValue({ ok: true, projects: [guestProject] })
    renderProvider()
    await waitFor(() => expect(readOrgDirectory("anna")).toEqual({
      orgs: [memberOrg],
      guestOrgs: [{ id: 9, name: "Guesthouse" }],
    }))
    expect(screen.getByTestId("offline").textContent).toBe("no")
  })

  it("serves the remembered lists when the server can't be reached", async () => {
    rememberOrgDirectory("anna", { orgs: [memberOrg], guestOrgs: [{ id: 9, name: "Guesthouse" }] })
    listMyOrgs.mockRejectedValue(new TypeError("Failed to fetch"))
    fetchAccessibleProjects.mockResolvedValue({ ok: false, reason: "unreachable" })
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("offline").textContent).toBe("yes"))
    expect(screen.getByTestId("orgs").textContent).toBe("Acme")
    expect(screen.getByTestId("guests").textContent).toBe("Guesthouse")
    expect(screen.getByTestId("error").textContent).toBe("none")
    expect(screen.getByTestId("projects-error").textContent).toBe("none")
  })

  it("still reports a server error, which the cache can't answer for", async () => {
    rememberOrgDirectory("anna", { orgs: [memberOrg], guestOrgs: [] })
    listMyOrgs.mockRejectedValue(new UserError(500, "", "org"))
    fetchAccessibleProjects.mockResolvedValue({ ok: true, projects: [] })
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("error").textContent).not.toBe("none"))
    expect(screen.getByTestId("offline").textContent).toBe("no")
  })

  it("reports the failure as before with nothing remembered", async () => {
    listMyOrgs.mockRejectedValue(new TypeError("Failed to fetch"))
    fetchAccessibleProjects.mockResolvedValue({ ok: false, reason: "unreachable" })
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("Failed to fetch"))
    expect(screen.getByTestId("offline").textContent).toBe("no")
  })

  it("reloads from the server when the connection comes back", async () => {
    rememberOrgDirectory("anna", { orgs: [memberOrg], guestOrgs: [] })
    listMyOrgs.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fetchAccessibleProjects.mockResolvedValueOnce({ ok: false, reason: "unreachable" })
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("offline").textContent).toBe("yes"))

    const renamed = { ...memberOrg, name: "Acme Translation" }
    listMyOrgs.mockResolvedValue([renamed])
    fetchAccessibleProjects.mockResolvedValue({ ok: true, projects: [] })
    act(() => { for (const listener of connectivityListeners) listener(true) })
    await waitFor(() => expect(screen.getByTestId("offline").textContent).toBe("no"))
    await waitFor(() => expect(screen.getByTestId("orgs").textContent).toBe("Acme Translation"))
    await waitFor(() => expect(readOrgDirectory("anna")?.orgs).toEqual([renamed]))
  })

  it("keeps the offline view while a retry is in flight", async () => {
    rememberOrgDirectory("anna", { orgs: [memberOrg], guestOrgs: [{ id: 9, name: "Guesthouse" }] })
    listMyOrgs.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fetchAccessibleProjects.mockResolvedValueOnce({ ok: false, reason: "unreachable" })
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("offline").textContent).toBe("yes"))

    let failOrgs: (e: Error) => void = () => {}
    listMyOrgs.mockReturnValue(new Promise((_, reject) => { failOrgs = reject }))
    fetchAccessibleProjects.mockReturnValue(new Promise(() => {}))
    act(() => { for (const listener of connectivityListeners) listener(true) })
    await waitFor(() => expect(listMyOrgs).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId("offline").textContent).toBe("yes")
    expect(screen.getByTestId("guests").textContent).toBe("Guesthouse")

    await act(async () => { failOrgs(new TypeError("Failed to fetch")) })
    expect(screen.getByTestId("offline").textContent).toBe("yes")
  })

  it("retries on a timer when the probe never reports a change", async () => {
    // The probe already reads online, so no change event will ever come.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    currentConnectivity = true
    rememberOrgDirectory("anna", { orgs: [memberOrg], guestOrgs: [] })
    listMyOrgs.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fetchAccessibleProjects.mockResolvedValueOnce({ ok: false, reason: "unreachable" })
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("offline").textContent).toBe("yes"))

    listMyOrgs.mockResolvedValue([memberOrg])
    fetchAccessibleProjects.mockResolvedValue({ ok: true, projects: [] })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(screen.getByTestId("offline").textContent).toBe("no"))
  })

  it("doesn't retry on the timer while the probe reads offline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    currentConnectivity = false
    rememberOrgDirectory("anna", { orgs: [memberOrg], guestOrgs: [] })
    listMyOrgs.mockRejectedValue(new TypeError("Failed to fetch"))
    fetchAccessibleProjects.mockResolvedValue({ ok: false, reason: "unreachable" })
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("offline").textContent).toBe("yes"))
    const calls = listMyOrgs.mock.calls.length

    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(listMyOrgs).toHaveBeenCalledTimes(calls)
  })
})
