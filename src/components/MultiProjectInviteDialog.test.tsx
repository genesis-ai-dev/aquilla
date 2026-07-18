// AQU-471: email mode actually sends per-project email invites (it used to
// punt the operator to each project's Share panel).
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MultiProjectInviteDialog } from "./MultiProjectInviteDialog"
import { createServerInvite } from "@/lib/sync/invites"
import { addProjectMember } from "@/lib/frontier/members"
import type { RecipientValue } from "@/components/UsernameTypeahead"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

vi.mock("@/lib/sync/invites", () => ({
  createServerInvite: vi.fn(async () => ({
    token: "tok",
    projectId: "pa",
    role: 400,
    expiresAt: "2099-01-01T00:00:00Z",
    email: "bob@example.com",
  })),
}))
vi.mock("@/lib/frontier/members", () => ({
  addProjectMember: vi.fn(async () => ({})),
  lookupUser: vi.fn(async () => null),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt" }, loading: false }),
}))
// The real typeahead debounces + fetches; a stub input with a mode toggle is
// all the dialog contract needs.
vi.mock("@/components/UsernameTypeahead", () => ({
  UsernameTypeahead: ({
    value,
    onChange,
  }: {
    value: RecipientValue
    onChange: (v: RecipientValue) => void
  }) => (
    <div>
      <input
        aria-label="recipient-input"
        value={value.raw}
        onChange={(e) => onChange({ ...value, raw: e.target.value })}
      />
      <button
        onClick={() =>
          onChange({ mode: value.mode === "email" ? "username" : "email", raw: value.raw })
        }
      >
        toggle-mode
      </button>
    </div>
  ),
}))

const projects = [
  { id: "pa", name: "John" },
  { id: "pb", name: "Mark" },
] as CloudProjectSummary[]

function renderDialog(onSuccess?: () => void) {
  return render(
    <MultiProjectInviteDialog
      open={true}
      onOpenChange={() => {}}
      projects={projects}
      onSuccess={onSuccess}
    />,
  )
}

beforeEach(() => vi.clearAllMocks())

describe("MultiProjectInviteDialog email mode (AQU-471)", () => {
  async function enterEmailModeAndSelectBoth() {
    fireEvent.click(screen.getByText("toggle-mode"))
    fireEvent.change(screen.getByLabelText("recipient-input"), {
      target: { value: "bob@example.com" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "Select John" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Mark" }))
  }

  it("mints one email-bound invite per selected project", async () => {
    const onSuccess = vi.fn()
    renderDialog(onSuccess)
    await enterEmailModeAndSelectBoth()
    fireEvent.click(screen.getByRole("button", { name: /send invites/i }))
    await waitFor(() => expect(createServerInvite).toHaveBeenCalledTimes(2))
    expect(createServerInvite).toHaveBeenCalledWith("jwt", "pa", 400, undefined, "bob@example.com")
    expect(createServerInvite).toHaveBeenCalledWith("jwt", "pb", 400, undefined, "bob@example.com")
    // Direct-grant path must NOT run in email mode.
    expect(addProjectMember).not.toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalled()
    expect(await screen.findAllByText("invited")).toHaveLength(2)
  })

  it("surfaces a per-project error when a mint fails (no project-lead)", async () => {
    vi.mocked(createServerInvite)
      .mockResolvedValueOnce({
        token: "tok",
        projectId: "pa",
        role: 400,
        expiresAt: "2099-01-01T00:00:00Z",
      })
      .mockResolvedValueOnce(null)
    renderDialog()
    await enterEmailModeAndSelectBoth()
    fireEvent.click(screen.getByRole("button", { name: /send invites/i }))
    expect(await screen.findByText("invited")).toBeInTheDocument()
    expect(
      await screen.findByText(/you need project-lead access/i),
    ).toBeInTheDocument()
  })

  it("disables Send until the email looks valid", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("toggle-mode"))
    fireEvent.change(screen.getByLabelText("recipient-input"), {
      target: { value: "not-an-email" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "Select John" }))
    expect(screen.getByRole("button", { name: /send invites/i })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("recipient-input"), {
      target: { value: "bob@example.com" },
    })
    expect(screen.getByRole("button", { name: /send invites/i })).toBeEnabled()
  })
})
