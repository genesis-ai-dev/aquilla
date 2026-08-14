import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import type { ReactNode } from "react"
import { PermissionDeniedAlert } from "./PermissionDeniedAlert"
import {
  _resetDbForTesting, addSession, loadActiveSession,
} from "@/lib/frontier/session-store"
import { ROLE } from "@/lib/frontier/roles"

// AQU-832: `action`/`requiredRoleLevel` are typed against the real catalog
// (MessageKey / RoleLevel) now, not raw strings — every render below uses the
// actual production key/level ProjectSettings.tsx passes, so a regression
// that reverts the component to rendering its props verbatim (instead of
// through `t()`/`resolveRoleName()`) shows up as literal key text in the
// alert rather than "change shared settings" / "Maintainer or higher".
const CHANGE_SHARED_SETTINGS_ACTION = "projectSettings.permission.changeSharedSettingsAction"

// AccountSwitcher pulls in the full auth-dialog tree; stub it so the test
// focuses on the alert's own identity + switch-user affordance (AQU-560).
vi.mock("@/components/AccountSwitcher", () => ({
  AccountSwitcher: () => <div data-testid="account-switcher" />,
}))

// clearAllLocalData (called by useAccounts.activate) touches IDB stores we
// don't seed here; no-op it so switching in the test doesn't throw.
vi.mock("@/lib/store/project-index", () => ({ clearAllLocalData: vi.fn(async () => {}) }))

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
)

describe("PermissionDeniedAlert", () => {
  beforeEach(async () => { await _resetDbForTesting() })

  it("names the active account and the required role", async () => {
    await addSession({ jwt: "j", username: "translator", email: "t@example.com", createdAt: "2026-01-01T00:00:00Z" })
    render(
      <PermissionDeniedAlert action={CHANGE_SHARED_SETTINGS_ACTION} requiredRoleLevel={ROLE.MAINTAINER} />,
      { wrapper },
    )
    const alert = await screen.findByRole("alert")
    await waitFor(() =>
      expect(alert).toHaveTextContent(
        "You're signed in as translator (t@example.com), which doesn't have permission to change shared settings (needs Maintainer or higher).",
      ),
    )
  })

  it("omits the role clause when requiredRole is not given", async () => {
    await addSession({ jwt: "j", username: "translator", createdAt: "2026-01-01T00:00:00Z" })
    render(<PermissionDeniedAlert action={CHANGE_SHARED_SETTINGS_ACTION} />, { wrapper })
    const alert = await screen.findByRole("alert")
    await waitFor(() =>
      expect(alert).toHaveTextContent(
        "You're signed in as translator, which doesn't have permission to change shared settings.",
      ),
    )
    expect(alert.textContent).not.toContain("needs")
  })

  it("AQU-623: names the current project role using the permission vocabulary", async () => {
    await addSession({ jwt: "j", username: "translator", email: "t@example.com", createdAt: "2026-01-01T00:00:00Z" })
    render(
      <PermissionDeniedAlert
        action={CHANGE_SHARED_SETTINGS_ACTION}
        requiredRoleLevel={ROLE.MAINTAINER}
        currentRole="Viewer"
      />,
      { wrapper },
    )
    const alert = await screen.findByRole("alert")
    await waitFor(() =>
      expect(alert).toHaveTextContent(
        "You're signed in as translator (t@example.com) — your role on this project is Viewer, which doesn't have permission to change shared settings (needs Maintainer or higher).",
      ),
    )
  })

  it("AQU-511 finding 4: keeps the account name visually distinct (font-medium) without a role", async () => {
    // Regression: extraction had flattened this sentence into one plain-text
    // catalog string, dropping the font-medium that marks the account name as
    // the actionable fact in the sentence. A text-only assertion would still
    // pass on that flattened version, so assert the styled element itself.
    await addSession({ jwt: "j", username: "translator", email: "t@example.com", createdAt: "2026-01-01T00:00:00Z" })
    render(<PermissionDeniedAlert action={CHANGE_SHARED_SETTINGS_ACTION} />, { wrapper })
    const alert = await screen.findByRole("alert")
    await waitFor(() => expect(alert).toHaveTextContent("translator (t@example.com)"))
    const styled = alert.querySelector(".font-medium")
    expect(styled).not.toBeNull()
    expect(styled).toHaveTextContent("translator (t@example.com)")
  })

  it("AQU-511 finding 4: keeps both the account name and the role visually distinct (font-medium)", async () => {
    // Regression: extraction had flattened this sentence too, dropping
    // font-medium from BOTH the account name and the role — the two pieces
    // of information the user actually needs from the alert.
    await addSession({ jwt: "j", username: "translator", email: "t@example.com", createdAt: "2026-01-01T00:00:00Z" })
    render(
      <PermissionDeniedAlert
        action={CHANGE_SHARED_SETTINGS_ACTION}
        requiredRoleLevel={ROLE.MAINTAINER}
        currentRole="Viewer"
      />,
      { wrapper },
    )
    const alert = await screen.findByRole("alert")
    // Wait on the ACCOUNT NAME, not the role: the role comes from props and is
    // painted on the first render, while the account name arrives from the async
    // session. Gating on the role let a slow session slip through and the
    // querySelectorAll below then saw only one styled span — the source of this
    // test's intermittent failures under full-suite parallel load.
    await waitFor(() =>
      expect(alert).toHaveTextContent("translator (t@example.com)"),
    )
    await waitFor(() => expect(alert).toHaveTextContent("your role on this project is Viewer"))
    const styled = Array.from(alert.querySelectorAll(".font-medium"))
    expect(styled).toHaveLength(2)
    expect(styled.some((el) => el.textContent === "translator (t@example.com)")).toBe(true)
    expect(styled.some((el) => el.textContent === "Viewer")).toBe(true)
  })

  it("AQU-623: links to the permission-levels docs page", async () => {
    await addSession({ jwt: "j", username: "translator", createdAt: "2026-01-01T00:00:00Z" })
    render(<PermissionDeniedAlert action={CHANGE_SHARED_SETTINGS_ACTION} />, { wrapper })
    const link = await screen.findByRole("link", { name: /learn about permission levels/i })
    expect(link).toHaveAttribute("href", expect.stringContaining("/permissions"))
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("offers a one-click switch to an already signed-in account", async () => {
    // First added becomes active (translator); owner is the other session.
    await addSession({ jwt: "j1", username: "translator", createdAt: "2026-01-01T00:00:00Z" })
    await addSession({ jwt: "j2", username: "owner", createdAt: "2026-01-02T00:00:00Z" })

    render(<PermissionDeniedAlert action={CHANGE_SHARED_SETTINGS_ACTION} />, { wrapper })

    const switchBtn = await screen.findByRole("button", { name: "Switch to owner" })
    fireEvent.click(switchBtn)

    await waitFor(async () => {
      const active = await loadActiveSession()
      expect(active?.username).toBe("owner")
    })
  })

  it("AQU-832: resolves `action` through the message catalog rather than rendering it verbatim", async () => {
    // The regression this guards: `action` used to be a raw string rendered
    // straight into the sentence, so ProjectSettings.tsx and ProjectMembersPage.tsx
    // could (and did) pass untranslated English into an otherwise fully
    // localized alert. `action` is now a MessageKey — if a future change
    // reverts the component to interpolating the prop directly instead of
    // calling `t(action)`, this test catches it: the alert would render the
    // literal key string instead of the catalog's English value.
    await addSession({ jwt: "j", username: "translator", createdAt: "2026-01-01T00:00:00Z" })
    render(<PermissionDeniedAlert action={CHANGE_SHARED_SETTINGS_ACTION} />, { wrapper })
    const alert = await screen.findByRole("alert")
    await waitFor(() => expect(alert).toHaveTextContent("doesn't have permission to change shared settings"))
    expect(alert.textContent).not.toContain(CHANGE_SHARED_SETTINGS_ACTION)
  })

  it("AQU-832: resolves `requiredRoleLevel` through resolveRoleName()/common.role.*, not a hardcoded label", async () => {
    // Regression guard for the companion fix: requiredRole used to be a raw
    // "Maintainer or higher" string. requiredRoleLevel is now a RoleLevel the
    // component resolves itself, reusing common.role.maintainer instead of a
    // second, independently-translated copy of the same word.
    await addSession({ jwt: "j", username: "translator", createdAt: "2026-01-01T00:00:00Z" })
    render(
      <PermissionDeniedAlert action={CHANGE_SHARED_SETTINGS_ACTION} requiredRoleLevel={ROLE.MAINTAINER} />,
      { wrapper },
    )
    const alert = await screen.findByRole("alert")
    await waitFor(() => expect(alert).toHaveTextContent("(needs Maintainer or higher)"))
  })

  it("falls back to the account switcher when no other account is signed in", async () => {
    await addSession({ jwt: "j", username: "translator", createdAt: "2026-01-01T00:00:00Z" })
    render(<PermissionDeniedAlert action={CHANGE_SHARED_SETTINGS_ACTION} />, { wrapper })
    await screen.findByRole("alert")
    expect(screen.getByText("Have another account? Add or switch:")).toBeInTheDocument()
    expect(screen.getByTestId("account-switcher")).toBeInTheDocument()
  })
})
