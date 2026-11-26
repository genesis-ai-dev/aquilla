/**
 * AQU-2322: StaffLanePopover's Add opens Give access through this launcher.
 * The dialog's dry run gates on the viewer's own access payload, so the
 * launcher must hand the dialog that payload and the lane it was asked for —
 * and open nothing when the payload cannot be read, rather than a dialog with
 * no places that the server would refuse anyway.
 */
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GiveAccessLauncher } from "./GiveAccessLauncher"
import type { OrgAccessPayload } from "./org-access-data"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt" } }) }))
const toastAdd = vi.fn()
vi.mock("@/components/ui/toast", () => ({ toast: { add: (arg: unknown) => toastAdd(arg) } }))
const fetchOrgAccess = vi.fn<(jwt: string, orgId: number) => Promise<OrgAccessPayload>>()
vi.mock("./org-access-data", () => ({ fetchOrgAccess: (jwt: string, orgId: number) => fetchOrgAccess(jwt, orgId) }))
vi.mock("./GiveAccessDialog", () => ({
  GiveAccessDialog: (props: { orgId: number; initialPerson?: { userId: string }; initialRoleLevel?: number; initialPlace?: { type: string; id: string }; payload: OrgAccessPayload }) => (
    <div
      data-testid="give-access-dialog"
      data-org={props.orgId}
      data-user={props.initialPerson?.userId}
      data-role={props.initialRoleLevel}
      data-place={props.initialPlace ? `${props.initialPlace.type}:${props.initialPlace.id}` : ""}
      data-places={props.payload.tree.length}
    />
  ),
}))

const payload: OrgAccessPayload = { tree: [{ scope: { type: "org", id: "1", name: "Org" }, children: [], directGrantees: [] }], people: [] }

beforeEach(() => {
  fetchOrgAccess.mockReset()
  toastAdd.mockReset()
})

describe("GiveAccessLauncher", () => {
  it("reads the viewer's access payload, then opens Give access pre-filled with the lane", async () => {
    fetchOrgAccess.mockResolvedValue(payload)
    render(<GiveAccessLauncher orgId={1} request={{ userId: "10", roleLevel: 300, place: { type: "lane", id: "ln-es" }, nonce: 1 }} onClose={() => {}} />)
    const dialog = await screen.findByTestId("give-access-dialog")
    expect(fetchOrgAccess).toHaveBeenCalledWith("jwt", 1)
    expect(dialog).toHaveAttribute("data-user", "10")
    expect(dialog).toHaveAttribute("data-role", "300")
    expect(dialog).toHaveAttribute("data-place", "lane:ln-es")
    expect(dialog).toHaveAttribute("data-places", "1")
  })

  it("opens nothing, and says so, when the payload cannot be read", async () => {
    fetchOrgAccess.mockRejectedValue(new Error("403"))
    render(<GiveAccessLauncher orgId={1} request={{ userId: "10", nonce: 1 }} onClose={() => {}} />)
    await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })))
    expect(screen.queryByTestId("give-access-dialog")).toBeNull()
  })

  it("opens nothing without a request", () => {
    render(<GiveAccessLauncher orgId={1} request={null} onClose={() => {}} />)
    expect(fetchOrgAccess).not.toHaveBeenCalled()
    expect(screen.queryByTestId("give-access-dialog")).toBeNull()
  })
})
