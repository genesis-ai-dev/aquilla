/**
 * AQU-2320: the Give access sentence composer.
 *
 * Why these matter: the dialog must only ever ask the server for a grant the
 * server's rule allows (roles per scope, the granter's cap, places they may
 * grant at), must never let someone confirm a sentence whose consequences
 * they have not been shown (primary disabled until the dry run answers for
 * the sentence on screen), and must write through the route that owns that
 * kind of place — an unknown email becomes an invite, not a failed lookup.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PlaceGrantability } from "@/lib/access/grant-rules"
import { t } from "@/lib/i18n/standalone"
import { previewLines } from "./GrantPreviewPanel"
import { GiveAccessDialog, type GiveAccessDialogProps } from "./GiveAccessDialog"
import type { GrantPreview, PreviewResult } from "./give-access-data"
import type { OrgAccessPayload } from "./org-access-data"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt" }, loading: false }) }))
const toastAdd = vi.fn()
vi.mock("@/components/ui/toast", () => ({ toast: { add: (arg: unknown) => toastAdd(arg) } }))
const fetchGrantPreview = vi.fn<(jwt: string, orgId: number, body: unknown) => Promise<PreviewResult>>()
const submitGrant = vi.fn<(jwt: string, orgId: number, grant: unknown) => Promise<void>>()
vi.mock("./give-access-data", () => ({
  fetchGrantPreview: (jwt: string, orgId: number, body: unknown) => fetchGrantPreview(jwt, orgId, body),
  submitGrant: (jwt: string, orgId: number, grant: unknown) => submitGrant(jwt, orgId, grant),
}))

const org = { type: "org" as const, id: "1", name: "Biblica ETT" }
const team = { type: "team" as const, id: "7", name: "Review desk" }
const project = { type: "project" as const, id: "p1", name: "Pattani" }
const lane = { type: "lane" as const, id: "fr01", name: "French" }

const node = (scope: typeof org | typeof team | typeof project | typeof lane, children: OrgAccessPayload["tree"] = []) =>
  ({ scope, children, directGrantees: [], inherited: [] })

function payload(grantable: Record<string, PlaceGrantability>): OrgAccessPayload {
  return {
    tree: [node(org, [node(team, [node(project, [node(lane)])])])],
    people: [
      { userId: "9", displayName: "naladda", email: "naladda@example.com", isGuest: true, grants: [{ scopePath: [org, project], roleLevel: 300, origin: { kind: "direct" } }] },
      { userId: "1", displayName: "ruth", email: "ruth@example.com", isGuest: false, grants: [] },
    ],
    grantable,
  }
}
const OWNER: Record<string, PlaceGrantability> = {
  "org:1": { ok: true, cap: 700 }, "team:7": { ok: true, cap: 700 }, "project:p1": { ok: true, cap: 700 }, "lane:fr01": { ok: true, cap: 700 },
}

const preview = (over: Partial<GrantPreview> = {}): GrantPreview => ({
  placePath: [org, project], roleLevel: 300, invite: false,
  here: { before: null, after: { roleLevel: 300, source: "direct", via: project } },
  replaces: null, changes: [], redundant: false, guest: { before: false, after: false }, includesFutureProjects: false,
  ...over,
})

function renderDialog(props: Partial<GiveAccessDialogProps> = {}) {
  const onOpenChange = vi.fn()
  const onGranted = vi.fn()
  render(<GiveAccessDialog open onOpenChange={onOpenChange} orgId={1} payload={payload(OWNER)} onGranted={onGranted} {...props} />)
  return { onOpenChange, onGranted, user: userEvent.setup() }
}

async function pickPlace(user: ReturnType<typeof userEvent.setup>, key: string) {
  await user.click(screen.getByTestId("give-place"))
  await user.click(await screen.findByTestId(`give-place-all-${key}`))
}
async function roleLevelsOffered(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("give-role"))
  const options = await screen.findAllByRole("option")
  const levels = options.map((o) => Number(o.getAttribute("data-role-level")))
  await user.keyboard("{Escape}")
  return levels
}

beforeEach(() => {
  fetchGrantPreview.mockReset()
  submitGrant.mockReset()
  toastAdd.mockReset()
})

describe("GiveAccessDialog", () => {
  it("offers only the roles each kind of place carries (AC1)", async () => {
    const { user } = renderDialog()
    await pickPlace(user, "team:7")
    expect(await roleLevelsOffered(user)).toEqual([600, 500, 100])
    await pickPlace(user, "lane:fr01")
    expect(await roleLevelsOffered(user)).toEqual([400, 300, 100])
  })

  it("never offers a Project lead a role above Project lead (AC1)", async () => {
    const { user } = renderDialog({ payload: payload({ "org:1": { ok: false, denial: "owner_only" }, "team:7": { ok: false, denial: "maintainer_only" }, "project:p1": { ok: true, cap: 500 }, "lane:fr01": { ok: true, cap: 500 } }) })
    expect(Math.max(...(await roleLevelsOffered(user)))).toBe(500)
    await pickPlace(user, "project:p1")
    expect(await roleLevelsOffered(user)).toEqual([500, 400, 300, 200, 100])
  })

  it("clears a chosen role the new place does not take, and says why", async () => {
    const { user } = renderDialog()
    await pickPlace(user, "team:7")
    await user.click(screen.getByTestId("give-role"))
    await user.click(await screen.findByRole("option", { name: "Maintainer" }))
    await pickPlace(user, "lane:fr01")
    expect(screen.getByTestId("give-role-notice")).toHaveTextContent(/Maintainer isn't a role on a language lane/i)
    expect(screen.getByTestId("give-role")).toHaveTextContent("role")
  })

  it("greys the organization for a Maintainer with the reason, and lets an Owner pick it (AC2)", async () => {
    const maintainer = renderDialog({ payload: payload({ ...OWNER, "org:1": { ok: false, denial: "owner_only" } }) })
    await maintainer.user.click(screen.getByTestId("give-place"))
    const orgItem = await screen.findByTestId("give-place-all-org:1")
    expect(orgItem).toHaveAttribute("aria-disabled", "true")
    expect(within(orgItem).getByText("Only an Owner can grant here")).toBeInTheDocument()
  })

  it("an Owner can pick the organization", async () => {
    const { user } = renderDialog()
    await user.click(screen.getByTestId("give-place"))
    expect(await screen.findByTestId("give-place-all-org:1")).not.toHaveAttribute("aria-disabled", "true")
  })

  it("keeps the primary button disabled until the dry run answers for this sentence, then shows the redundancy line (AC3)", async () => {
    let answer: (r: PreviewResult) => void = () => {}
    fetchGrantPreview.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    renderDialog({ initialPerson: { userId: "9" }, initialPlace: { type: "project", id: "p1" }, initialRoleLevel: 300 })
    await waitFor(() => expect(fetchGrantPreview).toHaveBeenCalledWith("jwt", 1, { place: { type: "project", id: "p1" }, roleLevel: 300, person: { userId: "9" } }))
    expect(screen.getByTestId("give-access-submit")).toBeDisabled()
    await act(async () => answer({ ok: true, preview: preview({ redundant: true, here: { before: { roleLevel: 300, source: "team", via: team }, after: { roleLevel: 300, source: "direct", via: project } } }) }))
    expect(screen.getByTestId("give-access-submit")).toBeEnabled()
    expect(screen.getByTestId("grant-preview")).toHaveTextContent("Already Reviewer here via Review desk; this adds nothing.")
  })

  it("shows a raise and that a guest stays a guest", async () => {
    fetchGrantPreview.mockResolvedValue({ ok: true, preview: preview({
      placePath: [org, team], roleLevel: 600, includesFutureProjects: true, guest: { before: true, after: true },
      changes: ["a", "b", "c"].map((id) => ({ project: { type: "project", id, name: id }, before: { roleLevel: 100, source: "team", via: team }, after: { roleLevel: 300, source: "team", via: team } })),
    }) })
    renderDialog({ initialPerson: { userId: "9" }, initialPlace: { type: "team", id: "7" }, initialRoleLevel: 600 })
    const panel = await screen.findByTestId("grant-preview")
    await waitFor(() => expect(panel).toHaveTextContent("Raises Viewer to Reviewer on 3 projects"))
    expect(panel).toHaveTextContent("Stays a Guest")
    expect(panel).toHaveTextContent("Projects attached to Review desk later are included")
  })

  it("submits one grant, toasts the place and role, and hands back so the lens reloads", async () => {
    fetchGrantPreview.mockResolvedValue({ ok: true, preview: preview() })
    submitGrant.mockResolvedValue()
    const { user, onGranted, onOpenChange } = renderDialog({ initialPerson: { userId: "9" }, initialPlace: { type: "project", id: "p1" }, initialRoleLevel: 300 })
    await waitFor(() => expect(screen.getByTestId("give-access-submit")).toBeEnabled())
    await user.click(screen.getByTestId("give-access-submit"))
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1))
    expect(submitGrant).toHaveBeenCalledTimes(1)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "naladda is now Reviewer at Biblica ETT › Pattani" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("turns an email that matches nobody into an invite at that place (AC5)", async () => {
    fetchGrantPreview.mockResolvedValue({ ok: true, preview: preview({ invite: true, guest: { before: true, after: true } }) })
    submitGrant.mockResolvedValue()
    const { user } = renderDialog({ initialPlace: { type: "project", id: "p1" }, initialRoleLevel: 300 })
    await user.click(screen.getByTestId("give-person"))
    await user.type(await screen.findByPlaceholderText("Search people or type an email"), "New@Example.com")
    await user.click(await screen.findByRole("option", { name: "Invite new@example.com" }))
    await waitFor(() => expect(fetchGrantPreview).toHaveBeenCalledWith("jwt", 1, expect.objectContaining({ person: { email: "new@example.com" } })))
    await waitFor(() => expect(screen.getByTestId("give-access-submit")).toHaveTextContent("Send invite"))
    await waitFor(() => expect(screen.getByTestId("give-access-submit")).toBeEnabled())
    await user.click(screen.getByTestId("give-access-submit"))
    await waitFor(() => expect(submitGrant).toHaveBeenCalledWith("jwt", 1, expect.objectContaining({ person: { kind: "invite", email: "new@example.com" } })))
  })

  it("an invite cannot go to a team: the team is greyed with the reason", async () => {
    const { user } = renderDialog({ initialPerson: { email: "new@example.com" } })
    await user.click(screen.getByTestId("give-place"))
    const teamItem = await screen.findByTestId("give-place-all-team:7")
    expect(teamItem).toHaveAttribute("aria-disabled", "true")
    expect(teamItem).toHaveTextContent(/not a team/)
  })

  it("walks person → role → place → preview → buttons with Tab, and Escape closes (AC7)", async () => {
    const { user, onOpenChange } = renderDialog()
    screen.getByTestId("give-person").focus()
    const order = [screen.getByTestId("give-role"), screen.getByTestId("give-place"), screen.getByTestId("grant-preview"), screen.getByRole("button", { name: "Cancel" })]
    for (const next of order) {
      await user.tab()
      expect(next).toHaveFocus()
    }
    await user.keyboard("{Escape}")
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything()))
  })
})

describe("AQU-2322: narrowing to one lane", () => {
  it("lists the project's lanes under it with a hint, and a lane offers exactly Contributor, Reviewer, Viewer (AC3)", async () => {
    // Opened on the lane with Project lead asked for: the lane cannot carry it, so no role is filled.
    const { user } = renderDialog({ initialPlace: { type: "lane", id: "fr01" }, initialRoleLevel: 500 })
    expect(screen.getByTestId("give-role")).toHaveTextContent("role")
    expect(await roleLevelsOffered(user)).toEqual([400, 300, 100])
    await user.click(screen.getByTestId("give-place"))
    const projectRow = await screen.findByTestId("give-place-all-project:p1")
    expect(within(projectRow).getByTestId("give-place-narrow")).toHaveTextContent(/narrow to one language lane/i)
    expect(screen.getByTestId("give-place-all-lane:fr01")).toBeInTheDocument()
  })

  it("What changes states the lane, and says other lanes stay closed or are not restricted yet by the wall", () => {
    const lanePreview = (lane: GrantPreview["lane"]) =>
      preview({ placePath: [org, project, lane ? { type: "lane", id: "fr01", name: "French" } : project], roleLevel: 400, lane })
    const on = previewLines(t, lanePreview({ wallOn: true, siblingsClosed: true }), null)
    expect(on).toContain("Opens French only. The project's other languages stay closed to them.")
    const off = previewLines(t, lanePreview({ wallOn: false, siblingsClosed: true }), null)
    expect(off).toContain("Narrowed to French, but access to the project's other languages is not restricted yet.")
    // They already open every other lane: nothing to say about siblings.
    expect(previewLines(t, lanePreview({ wallOn: true, siblingsClosed: false }), null).join(" ")).not.toMatch(/other languages/)
  })
})
