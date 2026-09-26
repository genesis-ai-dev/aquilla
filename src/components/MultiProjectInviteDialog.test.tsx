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

// AQU-1150: a filter box above the project checklist. The load-bearing part is
// that filtering is purely presentational — it narrows the rendered rows and
// must never disturb `selections`, which is what the count reads and what the
// submit iterates. A filter that silently dropped a hidden selection would
// fail the operator exactly when the dialog is most useful (a large org, where
// you cannot see everything you picked at once).
describe("MultiProjectInviteDialog project filter (AQU-1150)", () => {
  const threeProjects = [
    { id: "pa", name: "John" },
    { id: "pb", name: "Mark" },
    { id: "pc", name: "Luke" },
  ] as CloudProjectSummary[]

  function renderThree() {
    return render(
      <MultiProjectInviteDialog open={true} onOpenChange={() => {}} projects={threeProjects} />,
    )
  }

  const searchBox = () => screen.getByRole("textbox", { name: "Search projects" })

  it("narrows the list as you type and restores it when cleared", () => {
    renderThree()
    expect(screen.getAllByRole("checkbox")).toHaveLength(3)

    fireEvent.change(searchBox(), { target: { value: "ar" } })
    expect(screen.getByRole("checkbox", { name: "Select Mark" })).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: "Select John" })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: "Select Luke" })).not.toBeInTheDocument()

    fireEvent.change(searchBox(), { target: { value: "" } })
    expect(screen.getAllByRole("checkbox")).toHaveLength(3)
  })

  it("matches case-insensitively on any part of the name", () => {
    renderThree()
    fireEvent.change(searchBox(), { target: { value: "LUK" } })
    expect(screen.getByRole("checkbox", { name: "Select Luke" })).toBeInTheDocument()
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
  })

  it("says so when nothing matches, rather than showing an empty box", () => {
    renderThree()
    fireEvent.change(searchBox(), { target: { value: "zzzz" } })
    expect(screen.getByText("No projects match your search.")).toBeInTheDocument()
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
  })

  it("keeps earlier selections through a filter — count AND submit include the hidden ones", async () => {
    vi.mocked(lookupUser).mockResolvedValue({ id: 7, username: "bob" })
    renderThree()

    fireEvent.click(screen.getByRole("checkbox", { name: "Select John" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Mark" }))
    expect(screen.getByText(/2 projects selected/)).toBeInTheDocument()

    // Filter the two checked rows out of view, then check the third.
    fireEvent.change(searchBox(), { target: { value: "luke" } })
    expect(screen.queryByRole("checkbox", { name: "Select John" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Luke" }))
    expect(screen.getByText(/3 projects selected/)).toBeInTheDocument()

    // The real regression guard: the grant goes out for all three, including
    // the two the filter is hiding at submit time.
    fireEvent.change(screen.getByLabelText("recipient-input"), { target: { value: "bob" } })
    fireEvent.click(screen.getByRole("button", { name: "Add to projects" }))
    await waitFor(() => expect(addProjectMember).toHaveBeenCalledTimes(3))
    expect(addProjectMember).toHaveBeenCalledWith("jwt", "pa", "bob", 400)
    expect(addProjectMember).toHaveBeenCalledWith("jwt", "pb", "bob", 400)
    expect(addProjectMember).toHaveBeenCalledWith("jwt", "pc", "bob", 400)
  })

  it("does not offer a filter when the operator has no projects to filter", () => {
    render(<MultiProjectInviteDialog open={true} onOpenChange={() => {}} projects={[]} />)
    expect(screen.queryByRole("textbox", { name: "Search projects" })).not.toBeInTheDocument()
    expect(screen.getByText(/no projects available/i)).toBeInTheDocument()
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

// AQU-1152: a 60+ character project name used to paint over the role picker
// once its row was checked. The row is a three-column grid whose name track is
// `minmax(0,1fr)`, and the name button already carried `truncate` — but the
// button is inline-block, and shrink-to-fit resolves a `white-space: nowrap`
// box to its full text width no matter how narrow the track is. The box
// overflowed the track and the picker sat underneath it.
//
// happy-dom does no layout, so the guard is the class pair that encodes the
// constraint: `truncate` supplies the ellipsis, `max-w-full` is what makes it
// reachable. Either one alone is the bug.
describe("MultiProjectInviteDialog long project names (AQU-1152)", () => {
  const LONG_NAME =
    "Genesis through Deuteronomy — Burmese Back Translation Review Pass 2026"
  const longProjects = [
    { id: "pa", name: LONG_NAME },
    { id: "pb", name: "Mark" },
  ] as CloudProjectSummary[]

  function renderLong() {
    return render(
      <MultiProjectInviteDialog open={true} onOpenChange={() => {}} projects={longProjects} />,
    )
  }

  const nameButton = (name: string) => screen.getByRole("button", { name })

  it("clamps the name to its grid track so it can ellipsise", () => {
    expect(LONG_NAME.length).toBeGreaterThanOrEqual(60)
    renderLong()
    const btn = nameButton(LONG_NAME)
    expect(btn).toHaveClass("truncate")
    expect(btn).toHaveClass("max-w-full")
    // The wrapper has to be a block box for `max-w-full` to resolve against
    // the track rather than an inline shrink-wrap.
    expect(btn.parentElement).toHaveClass("block", "min-w-0")
  })

  it("keeps the full name readable through the tooltip", () => {
    renderLong()
    // The tooltip wraps the name button, so the untruncated string is still
    // in the accessibility tree even once CSS clips the visible text.
    expect(nameButton(LONG_NAME)).toHaveTextContent(LONG_NAME)
  })

  it("leaves the checkbox and the role picker their own space once checked", () => {
    renderLong()
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${LONG_NAME}` }))
    // All three grid columns are present and distinct — the name never
    // replaces or swallows the controls on either side of it.
    expect(screen.getByRole("checkbox", { name: `Select ${LONG_NAME}` })).toBeInTheDocument()
    expect(nameButton(LONG_NAME)).toBeInTheDocument()
    expect(screen.getByLabelText(`Role for ${LONG_NAME}`)).toBeInTheDocument()
  })

  it("does not stretch short names to the full track", () => {
    renderLong()
    // `w-full` would fix the overlap too, but it would also hand a two-letter
    // project the entire row as a click target — "short names are unaffected".
    expect(nameButton("Mark")).not.toHaveClass("w-full")
  })
})
