import { act, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({ members: [], addMany: vi.fn() }),
}))
vi.mock("@/hooks/useProjectScopePath", () => ({
  useProjectScopePath: () => [
    { type: "org", id: "1", name: "CAS" },
    { type: "project", id: "p1", name: "Bambara" },
  ],
}))

import { InviteStep } from "./InviteStep"

// AQU-1352 §3.9: the onboarding invite dialog must name the scope people are
// being added to, byte-identical to project settings ("Org › Project"), so a
// PM invites into the project they think they are inviting into.
describe("InviteStep", () => {
  it("titles the add-people dialog with the project's scope path", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <InviteStep projectId="p1" onSharesChanged={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await act(async () => { screen.getByRole("button").click() })
    expect(await screen.findByText("Add people to CAS › Bambara")).toBeInTheDocument()
  })
})
