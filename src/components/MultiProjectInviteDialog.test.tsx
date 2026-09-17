// AQU-471: email mode actually sends per-project email invites (it used to
// punt the operator to each project's Share panel).
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MultiProjectInviteDialog } from "./MultiProjectInviteDialog"
import { createServerInvite } from "@/lib/sync/invites"
import { addProjectMember, lookupUser } from "@/lib/frontier/members"
import { toast } from "@/components/ui/toast"
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
vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn(), update: vi.fn(), promise: vi.fn() },
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

// AQU-1149: the row badges die with the dialog, so the outcome also has to be
// announced at page level. The toast counts SUCCESSES only — a partial failure
// must not be rounded up to "added to 2 projects" while one of them failed.
describe("MultiProjectInviteDialog confirmation toast (AQU-1149)", () => {
  function selectBothProjects() {
    fireEvent.click(screen.getByRole("checkbox", { name: "Select John" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Mark" }))
  }

  async function addAsUsername() {
    vi.mocked(lookupUser).mockResolvedValue({ id: 7, username: "ciaran" })
    renderDialog()
    fireEvent.change(screen.getByLabelText("recipient-input"), {
      target: { value: "ciaran" },
    })
    selectBothProjects()
    fireEvent.click(screen.getByRole("button", { name: /add to projects/i }))
  }

  it("names the recipient and the project count after a clean add", async () => {
    await addAsUsername()
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith({
        type: "success",
        title: "Added ciaran to 2 projects",
      }),
    )
  })

  it("counts only the successes on a partial failure, and keeps the error inline", async () => {
    vi.mocked(addProjectMember)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("nope"))
    await addAsUsername()
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith({
        type: "success",
        title: "Added ciaran to 1 project",
      }),
    )
    // The failure stays where the operator can act on it, not in the toast.
    expect(await screen.findByText("added")).toBeInTheDocument()
    expect(toast.add).toHaveBeenCalledTimes(1)
  })

  it("stays silent when every project fails", async () => {
    vi.mocked(addProjectMember)
      .mockRejectedValueOnce(new Error("nope"))
      .mockRejectedValueOnce(new Error("nope"))
    const onSuccess = vi.fn()
    vi.mocked(lookupUser).mockResolvedValue({ id: 7, username: "ciaran" })
    renderDialog(onSuccess)
    fireEvent.change(screen.getByLabelText("recipient-input"), {
      target: { value: "ciaran" },
    })
    selectBothProjects()
    fireEvent.click(screen.getByRole("button", { name: /add to projects/i }))
    await waitFor(() => expect(addProjectMember).toHaveBeenCalledTimes(2))
    expect(toast.add).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("announces invites sent in email mode", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("toggle-mode"))
    fireEvent.change(screen.getByLabelText("recipient-input"), {
      target: { value: "bob@example.com" },
    })
    selectBothProjects()
    fireEvent.click(screen.getByRole("button", { name: /send invites/i }))
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith({
        type: "success",
        title: "Invites sent to bob@example.com for 2 projects",
      }),
    )
  })
})
