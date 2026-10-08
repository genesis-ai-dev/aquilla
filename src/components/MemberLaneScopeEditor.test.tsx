/**
 * The members matrix's scope editor offers the project's own languages as
 * checkboxes (AQU-581 review). Its old free-text lane code couldn't express
 * the MAIN language (its code is the empty string), so nobody could be limited
 * to the only language most projects have, and a typo silently left a lane
 * coordinator with no lanes at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/lib/sync/member-scopes", () => ({
  fetchMemberScopeView: vi.fn(),
  putMemberScopes: vi.fn(async (_jwt: string, _p: string, _u: number, scopes: unknown) => ({
    scopes,
    laneNames: {},
  })),
}))
vi.mock("@/lib/sync/project-settings", () => ({ fetchProjectSettings: vi.fn() }))

import { MemberLaneScopeEditor } from "./MemberLaneScopeEditor"
import { fetchMemberScopeView, putMemberScopes } from "@/lib/sync/member-scopes"
import { fetchProjectSettings } from "@/lib/sync/project-settings"
import { STALL_WATCHDOG_MS } from "@/test-utils/timeouts"

const settings = (targetLanguage: string, targetLanes: string[]) =>
  ({ version: 1, updatedAt: "", updatedBy: null, settings: { targetLanguage, targetLanes } }) as never

async function openEditor() {
  const onSaved = vi.fn()
  render(
    <MemberLaneScopeEditor jwt="jwt" projectId="p1" userId={7} username="carol" trigger={<span>scopes</span>} onSaved={onSaved} />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Edit carol's lane scopes on this project" }))
  await screen.findByText("Languages they can work in")
  return onSaved
}

describe("MemberLaneScopeEditor — the project's languages as checkboxes", () => {
  beforeEach(() => vi.clearAllMocks())

  it("lists the main language by name, and saves it as the default lane ('')", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({ scopes: [], laneNames: {} })
    vi.mocked(fetchProjectSettings).mockResolvedValue(settings("German", ["Spanish"]))
    const onSaved = await openEditor()
    expect(screen.getByLabelText("Lane German")).not.toBeChecked()
    expect(screen.getByLabelText("Lane Spanish")).not.toBeChecked()
    expect(screen.queryByPlaceholderText("Lane code (e.g. es)")).toBeNull()

    // Label-wrapped: a click on the text reaches the control.
    fireEvent.click(screen.getByText("German"))
    fireEvent.click(screen.getByRole("button", { name: "Save scopes" }))
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: STALL_WATCHDOG_MS })
    expect(vi.mocked(putMemberScopes).mock.calls[0][3]).toEqual([{ kind: "lane", value: "" }])
  })

  it("shows a lane the project doesn't have, ticked, so it can be removed", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({ scopes: [{ kind: "lane", value: "Spansih" }], laneNames: {} })
    vi.mocked(fetchProjectSettings).mockResolvedValue(settings("German", ["Spanish"]))
    const onSaved = await openEditor()
    const stray = screen.getByLabelText("Lane Spansih (not a language in this project)")
    expect(stray).toBeChecked()
    fireEvent.click(screen.getByText("Spansih (not a language in this project)"))
    fireEvent.click(screen.getByText("Spanish"))
    fireEvent.click(screen.getByRole("button", { name: "Save scopes" }))
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: STALL_WATCHDOG_MS })
    expect(vi.mocked(putMemberScopes).mock.calls[0][3]).toEqual([{ kind: "lane", value: "Spanish" }])
  })

  it("falls back to typing a lane code when the project's settings can't be read", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({ scopes: [], laneNames: {} })
    vi.mocked(fetchProjectSettings).mockResolvedValue(null)
    render(
      <MemberLaneScopeEditor jwt="jwt" projectId="p1" userId={7} username="carol" trigger={<span>scopes</span>} onSaved={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit carol's lane scopes on this project" }))
    expect(await screen.findByPlaceholderText("Lane code (e.g. es)")).toBeInTheDocument()
    expect(screen.queryByText("Languages they can work in")).toBeNull()
  })
})

/**
 * AQU-1607: a lane scope is a lane id. The checkboxes are the project's lane
 * ROWS, so two lanes of the same language are two boxes and ticking one
 * scopes the member to that lane alone.
 */
describe("MemberLaneScopeEditor — lane rows and lane ids", () => {
  beforeEach(() => vi.clearAllMocks())

  const withLanes = () =>
    ({
      version: 1,
      updatedAt: "",
      updatedBy: null,
      settings: { targetLanguage: "Spanish", targetLanes: ["Spanish (Mexico)"] },
      lanes: [
        { id: "ln-src", role: "source", name: "Greek", langCode: "el", legacyTag: null, position: 0, archivedAt: null },
        { id: "ln-main", role: "target", name: "Spanish", langCode: "es", legacyTag: "", position: 1, archivedAt: null },
        { id: "ln-mx", role: "target", name: "Spanish (Mexico)", langCode: "es", legacyTag: "es-MX", position: 2, archivedAt: null },
        { id: "ln-old", role: "target", name: "Tagalog", langCode: "tl", legacyTag: "tl", position: 3, archivedAt: "2026-09-01T00:00:00Z" },
      ],
    }) as never

  it("offers one box per live target lane and saves the lane's id", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({ scopes: [], laneNames: {} })
    vi.mocked(fetchProjectSettings).mockResolvedValue(withLanes())
    const onSaved = await openEditor()
    // The source lane and the archived lane are not offered.
    expect(screen.queryByLabelText("Lane Greek")).toBeNull()
    expect(screen.queryByLabelText("Lane Tagalog")).toBeNull()

    fireEvent.click(screen.getByText("Spanish (Mexico)"))
    fireEvent.click(screen.getByRole("button", { name: "Save scopes" }))
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: STALL_WATCHDOG_MS })
    expect(vi.mocked(putMemberScopes).mock.calls[0][3]).toEqual([{ kind: "lane", value: "ln-mx" }])
  })

  it("ticks a scope that still holds a legacy tag against its lane, and saves the id", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({ scopes: [{ kind: "lane", value: "es-MX" }], laneNames: {} })
    vi.mocked(fetchProjectSettings).mockResolvedValue(withLanes())
    const onSaved = await openEditor()
    expect(screen.getByLabelText("Lane Spanish (Mexico)")).toBeChecked()
    expect(screen.getByLabelText("Lane Spanish")).not.toBeChecked()

    fireEvent.click(screen.getByRole("button", { name: "Save scopes" }))
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: STALL_WATCHDOG_MS })
    expect(vi.mocked(putMemberScopes).mock.calls[0][3]).toEqual([{ kind: "lane", value: "ln-mx" }])
  })

  it("ticks the former default lane's '' scope against that lane", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({ scopes: [{ kind: "lane", value: "" }], laneNames: {} })
    vi.mocked(fetchProjectSettings).mockResolvedValue(withLanes())
    await openEditor()
    expect(screen.getByLabelText("Lane Spanish")).toBeChecked()
    expect(screen.getByLabelText("Lane Spanish (Mexico)")).not.toBeChecked()
  })

  // AQU-1586: a second lane of a language is tagged with its own opaque id, so
  // a row that names nothing falls to the language it records — never the tag.
  it("labels a lane tagged with its own id by the row's language, never the id", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({ scopes: [], laneNames: {} })
    vi.mocked(fetchProjectSettings).mockResolvedValue({
      version: 1,
      updatedAt: "",
      updatedBy: null,
      settings: { targetLanguage: "Spanish", targetLanes: ["a3f09c1e"] },
      lanes: [
        { id: "ln-main", role: "target", name: "Spanish", langCode: "es", legacyTag: "", position: 1, archivedAt: null },
        { id: "a3f09c1e", role: "target", name: "", langCode: "es-MX", legacyTag: "a3f09c1e", position: 2, archivedAt: null },
      ],
    } as never)
    await openEditor()
    expect(screen.getByLabelText("Lane es-MX")).toBeInTheDocument()
    expect(screen.queryByLabelText("Lane a3f09c1e")).toBeNull()
  })
})

/**
 * AQU-1783: the popover reports access from the lane GRANTS, because that is
 * what the read wall reads. Before this it printed "Unscoped — full access"
 * off the scopes table and gave a lead no clue why a contributor saw 3
 * translated cells where the lead saw 315.
 */
describe("MemberLaneScopeEditor — lane grants, not scopes (AQU-1783)", () => {
  beforeEach(() => vi.clearAllMocks())

  const twoLaneSettings = () =>
    ({
      version: 1,
      updatedAt: "",
      updatedBy: null,
      settings: { targetLanguage: "French", targetLanes: ["Spanish"] },
      lanes: [
        { id: "ln-fr", role: "target", name: "French", langCode: "fr", legacyTag: "", position: 1, archivedAt: null },
        { id: "ln-es", role: "target", name: "Spanish", langCode: "es", legacyTag: "es", position: 2, archivedAt: null },
      ],
    }) as never

  const laneAccess = (grantedLaneIds: string[], memberRoleLevel = 400) => ({
    memberRoleLevel,
    readWallEnabled: true,
    grants: grantedLaneIds.map((laneId) => ({ laneId, name: laneId, level: memberRoleLevel })),
    targetLanes: [
      { id: "ln-fr", name: "French" },
      { id: "ln-es", name: "Spanish" },
    ],
  })

  it("all granted: lists both lanes, no 'no access' marker and no warning", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({
      scopes: [],
      laneNames: {},
      laneAccess: laneAccess(["ln-fr", "ln-es"]),
    })
    vi.mocked(fetchProjectSettings).mockResolvedValue(twoLaneSettings())
    await openEditor()
    const grants = screen.getByTestId("member-lane-grants")
    expect(grants).toHaveTextContent("French")
    expect(grants).toHaveTextContent("Spanish")
    expect(screen.queryByText("no access")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    // Grants really do cover every lane, so the old wording is still true.
    expect(screen.getByText("Unscoped — full access")).toBeInTheDocument()
  })

  it("gap: marks the walled-off lane, warns, and offers the one-click regrant", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({
      scopes: [],
      laneNames: {},
      laneAccess: laneAccess(["ln-fr"]),
    })
    vi.mocked(fetchProjectSettings).mockResolvedValue(twoLaneSettings())
    await openEditor()
    expect(screen.getByTestId("member-lane-grants")).toHaveTextContent("Spanish")
    expect(screen.getByText("no access")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("has no grant for every lane")
    // The lie this issue is about is gone.
    expect(screen.queryByText("Unscoped — full access")).toBeNull()
  })

  it("the regrant saves an empty lane-scope set and refreshes the list in place", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({
      scopes: [{ kind: "file", value: "f1" }],
      laneNames: {},
      laneAccess: laneAccess(["ln-fr"]),
    })
    vi.mocked(fetchProjectSettings).mockResolvedValue(twoLaneSettings())
    vi.mocked(putMemberScopes).mockResolvedValue({
      scopes: [{ kind: "file", value: "f1" }],
      laneNames: {},
      laneAccess: laneAccess(["ln-fr", "ln-es"]),
    })
    await openEditor()
    fireEvent.click(screen.getByRole("button", { name: "Grant all current lanes" }))
    await vi.waitFor(() => expect(putMemberScopes).toHaveBeenCalled(), { timeout: STALL_WATCHDOG_MS })
    // File scopes are preserved; the empty LANE set is what re-grants every lane.
    expect(vi.mocked(putMemberScopes).mock.calls[0][3]).toEqual([{ kind: "file", value: "f1" }])
    // Refreshed from the PUT response — no reload, and the popover stayed open.
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: STALL_WATCHDOG_MS })
    expect(screen.queryByText("no access")).toBeNull()
  })

  it("a deliberately scoped member gets the marker but no warning or regrant", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({
      scopes: [{ kind: "lane", value: "ln-fr" }],
      laneNames: { "ln-fr": "French" },
      laneAccess: laneAccess(["ln-fr"]),
    })
    vi.mocked(fetchProjectSettings).mockResolvedValue(twoLaneSettings())
    await openEditor()
    expect(screen.getByText("no access")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByRole("button", { name: "Grant all current lanes" })).toBeNull()
  })

  it("maintainer: says every lane is visible by role, and shows no grant list", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({
      scopes: [],
      laneNames: {},
      laneAccess: laneAccess([], 600),
    })
    vi.mocked(fetchProjectSettings).mockResolvedValue(twoLaneSettings())
    await openEditor()
    expect(screen.getByTestId("member-lane-grants-by-role")).toBeInTheDocument()
    expect(screen.queryByTestId("member-lane-grants")).toBeNull()
    expect(screen.queryByText("no access")).toBeNull()
    expect(screen.queryByText("Unscoped — full access")).toBeNull()
  })

  it("says nothing about grants where the wall is off, or where the server did not report them", async () => {
    vi.mocked(fetchMemberScopeView).mockResolvedValue({
      scopes: [],
      laneNames: {},
      laneAccess: { ...laneAccess(["ln-fr"]), readWallEnabled: false },
    })
    vi.mocked(fetchProjectSettings).mockResolvedValue(twoLaneSettings())
    await openEditor()
    expect(screen.queryByTestId("member-lane-grants")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText("Unscoped — full access")).toBeInTheDocument()
  })
})
