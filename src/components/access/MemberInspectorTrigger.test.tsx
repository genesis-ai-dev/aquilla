/**
 * AQU-1352 §3.8: clicking a roster name opens the inspector. Rule 1 says both
 * sections always render in order; rule 5 says guests are labelled in the
 * header; a failed or forbidden read must say so instead of showing an empty
 * (and therefore misleading) "no other access" list.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { MemberAccess } from "@/lib/access/types"
import { UserError } from "@/lib/errors/user-error"

import { MemberInspectorTrigger } from "./MemberInspectorTrigger"

const fetchMemberAccess = vi.fn()
vi.mock("@/lib/sync/access-read", () => ({
  fetchMemberAccess: (...args: unknown[]) => fetchMemberAccess(...args),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "alice" } }),
}))

const org = { type: "org" as const, id: "1", name: "Biblica ETT" }
const naladda: MemberAccess = {
  userId: "9",
  displayName: "Naladda",
  isGuest: true,
  effectiveHere: {
    roleLevel: 500,
    chain: [{ scopePath: [org, { type: "project", id: "p1", name: "Pattani" }], roleLevel: 500, origin: { kind: "direct" } }],
  },
  elsewhere: [{ scopePath: [org, { type: "project", id: "p2", name: "Thai" }], roleLevel: 300, origin: { kind: "direct" } }],
}

function renderTrigger() {
  render(
    <MemberInspectorTrigger userId={9} username="naladda" from={{ type: "project", id: "p1" }} herePath={[org]}>
      naladda
    </MemberInspectorTrigger>,
  )
  fireEvent.click(screen.getByRole("button", { name: /naladda/i }))
}

// Braces matter: a function returned from beforeEach runs as a cleanup hook.
beforeEach(() => {
  fetchMemberAccess.mockReset()
})

describe("MemberInspectorTrigger", () => {
  it("fetches only on open, then shows Effective here before Everything else", async () => {
    fetchMemberAccess.mockResolvedValue(naladda)
    renderTrigger()
    const inspector = await screen.findByTestId("member-inspector")
    expect(fetchMemberAccess).toHaveBeenCalledWith("test-jwt", 9, { type: "project", id: "p1" })
    const sections = [...inspector.querySelectorAll("section")].map((s) => s.getAttribute("data-section"))
    expect(sections).toEqual(["effective-here", "everything-else"])
    expect(inspector.textContent).toContain("Thai")
  })

  it("labels a guest in the header (rule 5)", async () => {
    fetchMemberAccess.mockResolvedValue(naladda)
    renderTrigger()
    expect(await screen.findByTestId("inspector-guest")).toHaveTextContent("Biblica ETT")
  })

  it("shows an error instead of an empty inspector when the read fails", async () => {
    fetchMemberAccess.mockImplementation(async () => {
      throw new UserError(403, "no access", "project")
    })
    renderTrigger()
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("can't see this person's access"))
    expect(screen.queryByTestId("member-inspector")).toBeNull()
  })

})
