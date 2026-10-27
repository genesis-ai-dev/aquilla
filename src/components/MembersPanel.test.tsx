// AQU-553 (Slice 5): the per-member lane/file scopes editor in MembersPanel.
//
// Pins: the editor renders only for lead+ callers (callerMaxRole >= 500) over
// members below project lead. A project lead's lanes are shown read-only and
// point at the language Staff menu (AQU-2054). Maintainers and above have no
// scope row. Save issues the replace-set (onSave = the PUT).

import { describe, it, expect, vi } from "vitest"
import type { ReactElement } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  MembersPanel,
  type MembersPanelMember,
  type MembersPanelScopeConfig,
} from "./MembersPanel"

// The add-member row mounts UsernameTypeahead, which reaches useAccounts ->
// useQueryClient; wrap every render in a provider so those hooks resolve.
function renderPanel(ui: ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  )
}

const ROLE_OPTIONS = [
  { level: 300, name: "reviewer", description: "" },
  { level: 400, name: "contributor", description: "" },
  { level: 500, name: "project_lead", description: "" },
]

function contributor(userId = 2): MembersPanelMember {
  return {
    userId,
    username: "carol",
    roleLevel: 400,
    roleName: "contributor",
    source: "override",
    isLocked: false,
  }
}

function lead(userId = 3): MembersPanelMember {
  return {
    userId,
    username: "lead",
    roleLevel: 500,
    roleName: "project_lead",
    source: "override",
    isLocked: false,
  }
}

function maintainer(userId = 7): MembersPanelMember {
  return {
    userId,
    username: "maya",
    roleLevel: 600,
    roleName: "maintainer",
    source: "override",
    isLocked: false,
  }
}

function scopeConfig(
  onSave: MembersPanelScopeConfig["onSave"],
  scopesByUser: MembersPanelScopeConfig["scopesByUser"] = {},
): MembersPanelScopeConfig {
  return {
    lanes: [
      { value: "", label: "English" },
      { value: "es", label: "Spanish" },
    ],
    files: [{ id: "file-a", name: "Genesis" }],
    scopesByUser,
    onSave,
  }
}

function noop() {
  return Promise.resolve()
}

function baseProps() {
  return {
    members: [contributor()],
    roleOptions: ROLE_OPTIONS,
    newMemberDefaultRole: 400,
    onAdd: async () => [],
    onRemove: noop,
    callerUserId: 1,
  }
}

describe("MembersPanel scopes editor", () => {
  it("renders the scopes editor for a lead caller (500+) over a contributor", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={500}
        scopeConfig={scopeConfig(vi.fn())}
      />,
    )
    expect(screen.getByTestId("member-scopes-2")).toBeInTheDocument()
    expect(screen.queryByTestId("member-lead-lanes-2")).not.toBeInTheDocument()
  })

  // AQU-645: the scopes editor is collapsed by default — one compact header row
  // per member, with the Lanes/Files checkboxes hidden until expanded.
  it("collapses each member's scopes by default (checkboxes hidden)", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={500}
        scopeConfig={scopeConfig(vi.fn())}
      />,
    )
    // The header row is present, but the editor body is not.
    expect(screen.getByTestId("member-scopes-toggle-2")).toBeInTheDocument()
    expect(screen.getByTestId("member-scopes-toggle-2")).toHaveAttribute(
      "aria-expanded",
      "false",
    )
    expect(screen.queryByLabelText("Lane Spanish")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /save scopes/i })).not.toBeInTheDocument()
  })

  // AQU-645: the collapsed header summarizes access without expanding.
  it("shows 'Full access' on the collapsed header for an unscoped member", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={500}
        scopeConfig={scopeConfig(vi.fn())}
      />,
    )
    expect(screen.getByTestId("member-scopes-toggle-2")).toHaveTextContent(
      "Full access",
    )
  })

  // AQU-645: a scoped member's header shows a pluralized lane/file count.
  it("summarizes a scoped member's access as a lane/file count", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={500}
        scopeConfig={scopeConfig(vi.fn(), {
          2: [
            { kind: "lane", value: "" },
            { kind: "lane", value: "es" },
            { kind: "file", value: "file-a" },
          ],
        })}
      />,
    )
    expect(screen.getByTestId("member-scopes-toggle-2")).toHaveTextContent(
      "2 lanes · 1 file",
    )
  })

  // AQU-645: clicking the header expands that member's editor.
  it("expands the editor when the collapsed header is clicked", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={500}
        scopeConfig={scopeConfig(vi.fn())}
      />,
    )
    fireEvent.click(screen.getByTestId("member-scopes-toggle-2"))
    expect(screen.getByTestId("member-scopes-toggle-2")).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(screen.getByLabelText("Lane Spanish")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /save scopes/i })).toBeInTheDocument()
  })

  // AQU-645: expand state is per member — expanding one leaves others collapsed.
  it("keeps other members collapsed when one is expanded", () => {
    const members = [contributor(2), { ...contributor(5), username: "dave" }]
    renderPanel(
      <MembersPanel
        {...baseProps()}
        members={members}
        callerMaxRole={500}
        scopeConfig={scopeConfig(vi.fn())}
      />,
    )
    fireEvent.click(screen.getByTestId("member-scopes-toggle-2"))
    expect(screen.getByTestId("member-scopes-toggle-2")).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(screen.getByTestId("member-scopes-toggle-5")).toHaveAttribute(
      "aria-expanded",
      "false",
    )
  })

  it("hides the scopes editor below the 500 floor", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={400}
        scopeConfig={scopeConfig(vi.fn())}
      />,
    )
    expect(screen.queryByTestId("member-scopes-2")).not.toBeInTheDocument()
  })

  it("shows an unscoped project lead as seeing every lane, without an editor", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        members={[lead()]}
        callerMaxRole={500}
        scopeConfig={scopeConfig(vi.fn())}
      />,
    )
    expect(screen.queryByTestId("member-scopes-3")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /save scopes/i })).not.toBeInTheDocument()
    const row = screen.getByTestId("member-lead-lanes-3")
    expect(row).toHaveTextContent("Every lane")
    expect(row).toHaveTextContent("To change these lanes, use Staff… on the language.")
  })

  it("shows a lane-limited project lead's lanes and points to Staff, without an editor", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        members={[lead()]}
        callerMaxRole={600}
        scopeConfig={scopeConfig(vi.fn(), {
          3: [{ kind: "lane", value: "es" }],
        })}
      />,
    )
    expect(screen.queryByTestId("member-scopes-3")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Lane Spanish")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /save scopes/i })).not.toBeInTheDocument()
    const row = screen.getByTestId("member-lead-lanes-3")
    expect(row).toHaveTextContent("Spanish")
    expect(row).not.toHaveTextContent("Every lane")
    expect(row).toHaveTextContent("To change these lanes, use Staff… on the language.")
  })

  it("shows no scope row for a maintainer", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        members={[maintainer()]}
        callerMaxRole={600}
        scopeConfig={scopeConfig(vi.fn(), {
          7: [{ kind: "lane", value: "es" }],
        })}
      />,
    )
    expect(screen.queryByTestId("member-scopes-7")).not.toBeInTheDocument()
    expect(screen.queryByTestId("member-lead-lanes-7")).not.toBeInTheDocument()
  })

  it("does not render any scope UI when scopeConfig is absent", () => {
    renderPanel(<MembersPanel {...baseProps()} callerMaxRole={500} />)
    expect(screen.queryByTestId("member-scopes-2")).not.toBeInTheDocument()
  })

  it("Save issues onSave (the PUT) with the selected scopes", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={500}
        scopeConfig={scopeConfig(onSave)}
      />,
    )
    // AQU-645: the editor is collapsed by default, so expand it first.
    fireEvent.click(screen.getByTestId("member-scopes-toggle-2"))
    // Tick the Spanish lane. Click the label TEXT: happy-dom re-dispatches
    // label-wrapped clicks onto the control (clicking the control itself
    // double-toggles under happy-dom), matching the ConfirmActionDialog pattern.
    fireEvent.click(screen.getByText("Spanish"))
    fireEvent.click(screen.getByRole("button", { name: /save scopes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(2, [{ kind: "lane", value: "es" }])
  })

  // AQU-645: after a successful save the collapsed header summary reflects the
  // newly-persisted access.
  it("updates the collapsed summary after a successful save", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={500}
        scopeConfig={scopeConfig(onSave)}
      />,
    )
    const toggle = screen.getByTestId("member-scopes-toggle-2")
    expect(toggle).toHaveTextContent("Full access")
    fireEvent.click(toggle)
    fireEvent.click(screen.getByText("Spanish"))
    fireEvent.click(screen.getByRole("button", { name: /save scopes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    // Collapse again and confirm the summary advanced past "Full access".
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveTextContent("1 lane"))
  })
})

describe("MembersPanel search when the roster is hidden", () => {
  it("leaves the username field usable for a project lead when the list is visible", () => {
    renderPanel(<MembersPanel {...baseProps()} callerMaxRole={500} />)
    expect(screen.getByRole("textbox")).toBeEnabled()
  })

  it("disables the username field and shows the reason", () => {
    const reason = "Contributors cannot view the member list."
    renderPanel(
      <MembersPanel
        {...baseProps()}
        callerMaxRole={600}
        searchDisabledReason={reason}
      />,
    )
    const field = screen.getByRole("textbox")
    expect(field).toBeDisabled()
    expect(field).toHaveAttribute("aria-describedby", "member-search-disabled-reason")
    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled()
  })
})
