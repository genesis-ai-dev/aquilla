// AQU-1993: a person can leave a project they were individually added to.
//
// The control lives in the always-visible General pane rather than the
// Members pane, because the organization's member-list policy can hide that
// pane from exactly the contributor who wants out.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { LeaveProjectSection } from "./LeaveProjectSection"
import { leaveProject, NoDirectMembershipError } from "@/lib/frontier/members"
import { toast } from "@/components/ui/toast"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "cass" } }),
}))
vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn(), update: vi.fn(), promise: vi.fn() },
}))
vi.mock("@/lib/frontier/members", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/frontier/members")>()
  return {
    ...original,
    leaveProject: vi.fn(),
  }
})

const navigate = vi.fn()
vi.mock("react-router-dom", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router-dom")>()
  return { ...original, useNavigate: () => navigate }
})

function renderSection() {
  render(
    <MemoryRouter>
      <LeaveProjectSection projectId="proj-1" projectName="Luke" />
    </MemoryRouter>,
  )
}

/** Open the confirm dialog and press its own Leave project button. */
async function confirmLeave() {
  fireEvent.click(screen.getByRole("button", { name: /leave project/i }))
  const dialog = await screen.findByRole("dialog")
  fireEvent.click(within(dialog).getByRole("button", { name: /leave project/i }))
}

beforeEach(() => {
  vi.mocked(leaveProject).mockReset()
  vi.mocked(navigate).mockReset()
  vi.mocked(toast.add).mockReset()
})

describe("LeaveProjectSection", () => {
  it("confirms first and leaves nothing behind when cancelled", async () => {
    renderSection()
    fireEvent.click(screen.getByRole("button", { name: /leave project/i }))
    expect(await screen.findByRole("heading", { name: "Leave Luke?" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Leave Luke?" })).toBeNull())
    expect(leaveProject).not.toHaveBeenCalled()
  })

  it("leaves the project and navigates away once access is gone", async () => {
    vi.mocked(leaveProject).mockResolvedValue({ stillHasAccess: false, remainingSource: null })
    renderSection()
    await confirmLeave()
    await waitFor(() => expect(leaveProject).toHaveBeenCalledWith("test-jwt", "proj-1"))
    expect(navigate).toHaveBeenCalledWith("/")
  })

  // Inherited access is not the caller's to drop, so the app must not claim
  // the project is gone — and must not navigate away from a project they can
  // still open.
  it("says so when an inherited path still grants access, and stays put", async () => {
    vi.mocked(leaveProject).mockResolvedValue({ stillHasAccess: true, remainingSource: "org" })
    renderSection()
    await confirmLeave()
    await waitFor(() => expect(toast.add).toHaveBeenCalled())
    expect(vi.mocked(toast.add).mock.calls[0][0].title).toMatch(/still gives you access/i)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("explains the refusal when there is no individual grant to give up", async () => {
    vi.mocked(leaveProject).mockRejectedValue(new NoDirectMembershipError())
    renderSection()
    await confirmLeave()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /comes from your organization or a team/i,
    )
    expect(navigate).not.toHaveBeenCalled()
  })
})
