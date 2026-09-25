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
  fetchMemberScopes: vi.fn(),
  putMemberScopes: vi.fn(async (_jwt: string, _p: string, _u: number, scopes: unknown) => scopes),
}))
vi.mock("@/lib/sync/project-settings", () => ({ fetchProjectSettings: vi.fn() }))

import { MemberLaneScopeEditor } from "./MemberLaneScopeEditor"
import { fetchMemberScopes, putMemberScopes } from "@/lib/sync/member-scopes"
import { fetchProjectSettings } from "@/lib/sync/project-settings"

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
    vi.mocked(fetchMemberScopes).mockResolvedValue([])
    vi.mocked(fetchProjectSettings).mockResolvedValue(settings("German", ["Spanish"]))
    const onSaved = await openEditor()
    expect(screen.getByLabelText("Lane German")).not.toBeChecked()
    expect(screen.getByLabelText("Lane Spanish")).not.toBeChecked()
    expect(screen.queryByPlaceholderText("Lane code (e.g. es)")).toBeNull()

    // Label-wrapped: a click on the text reaches the control.
    fireEvent.click(screen.getByText("German"))
    fireEvent.click(screen.getByRole("button", { name: "Save scopes" }))
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(vi.mocked(putMemberScopes).mock.calls[0][3]).toEqual([{ kind: "lane", value: "" }])
  })

  it("shows a lane the project doesn't have, ticked, so it can be removed", async () => {
    vi.mocked(fetchMemberScopes).mockResolvedValue([{ kind: "lane", value: "Spansih" }])
    vi.mocked(fetchProjectSettings).mockResolvedValue(settings("German", ["Spanish"]))
    const onSaved = await openEditor()
    const stray = screen.getByLabelText("Lane Spansih (not a language in this project)")
    expect(stray).toBeChecked()
    fireEvent.click(screen.getByText("Spansih (not a language in this project)"))
    fireEvent.click(screen.getByText("Spanish"))
    fireEvent.click(screen.getByRole("button", { name: "Save scopes" }))
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(vi.mocked(putMemberScopes).mock.calls[0][3]).toEqual([{ kind: "lane", value: "Spanish" }])
  })

  it("falls back to typing a lane code when the project's settings can't be read", async () => {
    vi.mocked(fetchMemberScopes).mockResolvedValue([])
    vi.mocked(fetchProjectSettings).mockResolvedValue(null)
    render(
      <MemberLaneScopeEditor jwt="jwt" projectId="p1" userId={7} username="carol" trigger={<span>scopes</span>} onSaved={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit carol's lane scopes on this project" }))
    expect(await screen.findByPlaceholderText("Lane code (e.g. es)")).toBeInTheDocument()
    expect(screen.queryByText("Languages they can work in")).toBeNull()
  })
})
