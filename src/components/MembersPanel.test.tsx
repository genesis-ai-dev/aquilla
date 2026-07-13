// AQU-553 (Slice 5): the per-member lane/file scopes editor in MembersPanel.
//
// Pins: the editor renders only for lead+ callers (callerMaxRole >= 500) over
// scopable members (roleLevel < 500), stays hidden below that floor and for
// leads themselves, and Save issues the replace-set (onSave = the PUT).

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
    onAdd: async () => ({ ok: true }),
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

  it("hides the scopes editor for a lead member (leads stay unscoped)", () => {
    renderPanel(
      <MembersPanel
        {...baseProps()}
        members={[lead()]}
        callerMaxRole={500}
        scopeConfig={scopeConfig(vi.fn())}
      />,
    )
    expect(screen.queryByTestId("member-scopes-3")).not.toBeInTheDocument()
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
    // Tick the Spanish lane. Click the label TEXT: happy-dom re-dispatches
    // label-wrapped clicks onto the control (clicking the control itself
    // double-toggles under happy-dom), matching the ConfirmActionDialog pattern.
    fireEvent.click(screen.getByText("Spanish"))
    fireEvent.click(screen.getByRole("button", { name: /save scopes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(2, [{ kind: "lane", value: "es" }])
  })
})
