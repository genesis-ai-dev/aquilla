/**
 * The desktop app's "This computer" workspace is reached from the org
 * switcher. It must appear only in the Tauri shell (the web app has no
 * filesystem to show), route to /this-computer without touching the active
 * org, and read as selected while the user is on a this-computer route.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSwitcher } from "./OrgSwitcher"

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

const tauri = vi.hoisted(() => ({ on: false }))
vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => tauri.on }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
vi.mock("@/hooks/usePlatformAdmin", () => ({ usePlatformAdmin: () => ({ isAdmin: false, loading: false }) }))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
  listOrgsPage: vi.fn(),
  createOrg: vi.fn(),
  ORG_SWITCHER_PAGE_SIZE: 40,
}))
// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjects: async () => [],
  fetchAccessibleProjectsResult: async () => ({ ok: true as const, projects: [] }),
}))

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  listMyOrgs.mockResolvedValue([{ id: 1, name: "Acme", role: { level: 700, name: "owner" } }])
  tauri.on = false
})
afterEach(() => vi.restoreAllMocks())

async function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <OrgProvider><OrgSwitcher /><LocationProbe /></OrgProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByRole("combobox", { name: /organization switcher/i })).toBeInTheDocument())
}

describe("OrgSwitcher — This computer", () => {
  it("is absent in the web app", async () => {
    await renderAt("/orgs/1")
    await act(async () => { screen.getByRole("combobox", { name: /organization switcher/i }).click() })
    await screen.findByRole("combobox", { name: /find an organization/i })
    expect(screen.queryByRole("option", { name: /this computer/i })).not.toBeInTheDocument()
  })

  it("in the desktop app, is listed and routes to /this-computer without changing the active org", async () => {
    tauri.on = true
    await renderAt("/orgs/1")
    await act(async () => { screen.getByRole("combobox", { name: /organization switcher/i }).click() })
    const option = await screen.findByRole("option", { name: /this computer/i })
    expect(option).toHaveTextContent("On this device")
    await act(async () => { option.click() })
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/this-computer"))
    expect(localStorage.getItem("org:active")).toBe("1")
  })

  it("reads as the selected scope on this-computer routes, including the Paratext pages", async () => {
    tauri.on = true
    await renderAt("/paratext")
    expect(screen.getByRole("combobox", { name: "Organization switcher: This computer" })).toBeInTheDocument()
    await act(async () => { screen.getByRole("combobox", { name: /organization switcher/i }).click() })
    const option = await screen.findByRole("option", { name: /this computer/i })
    expect(option.querySelector(".lucide-check")).not.toBeNull()
    expect(screen.getByRole("option", { name: /acme/i }).querySelector(".lucide-check")).toBeNull()
  })
})
