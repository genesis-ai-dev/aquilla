import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ValidationSettingsSection } from "./ValidationSettingsSection"

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [
      {
        userId: 1,
        username: "alice",
        role: { level: 700, name: "owner", source: "creator" as const },
        secondarySources: [],
      },
      {
        userId: 2,
        username: "bob",
        role: { level: 300, name: "reviewer", source: "override" as const },
        secondarySources: [],
      },
      {
        userId: 3,
        username: "carol",
        role: { level: 400, name: "contributor", source: "override" as const },
        secondarySources: [],
      },
      {
        userId: 4,
        username: "dave",
        role: { level: 300, name: "reviewer", source: "override" as const },
        secondarySources: [],
      },
    ],
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: async () => {},
    add: async () => null,
    addMany: async () => [],
    remove: async () => {},
    changeRole: async () => null,
  }),
}))

describe("ValidationSettingsSection — named validators combobox", () => {
  it("shows avatar-stack trigger with comma-separated selected names", () => {
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={["alice", "bob"]}
        onChange={vi.fn()}
      />,
    )

    const trigger = screen.getByRole("combobox", { name: /Named validators/i })
    expect(trigger.textContent).toContain("alice, bob")
    expect(screen.queryByText("Select project members…")).toBeNull()
  })

  it("shows +N overflow when more than three validators are selected", () => {
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={["alice", "bob", "carol", "dave"]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText("+1")).toBeTruthy()
    expect(screen.getByRole("combobox", { name: /Named validators/i }).textContent).toContain(
      "alice, bob, carol, dave",
    )
  })

  it("renders usernames on unselected options (not only when selected)", async () => {
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={[]}
        onChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("combobox", { name: /Named validators/i }))
    const aliceOption = await screen.findByRole("option", { name: "alice" })
    // Visible label text (not aria-only) — regression for CSS that hid the
    // username span when the trailing ItemIndicator was absent.
    const name = aliceOption.querySelector("span.font-medium")
    expect(name?.textContent).toBe("alice")
    expect(name).toBeVisible()
    // Unselected — leading checkbox must not be checked.
    const checkbox = aliceOption.querySelector('[data-slot="checkbox"]')
    expect(checkbox?.getAttribute("aria-checked")).toBe("false")
    // Square InitialsAvatar (app default) — not rounded-full circles.
    const avatar = aliceOption.querySelector('[data-slot="avatar"]')
    expect(avatar?.className ?? "").not.toMatch(/rounded-full/)
  })

  it("Shift+Enter toggles highlighted member and keeps the popup open", async () => {
    const onChange = vi.fn()
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={[]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("combobox", { name: /Named validators/i }))
    await screen.findByRole("option", { name: "alice" })
    const search = screen.getByRole("combobox", { name: /Search members/i })
    const popup = search.closest('[data-slot="combobox-content"]') ?? search
    fireEvent.keyDown(popup, { key: "Enter", code: "Enter", shiftKey: true })

    expect(onChange).toHaveBeenCalledWith({ validationNamedUsers: ["alice"] })
    // Popup stays open for multi-select via Shift+Enter.
    expect(screen.getByRole("combobox", { name: /Search members/i })).toBeTruthy()
  })

  it("Enter toggles highlighted member and closes the popup", async () => {
    const onChange = vi.fn()
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={[]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("combobox", { name: /Named validators/i }))
    await screen.findByRole("option", { name: "alice" })
    const search = screen.getByRole("combobox", { name: /Search members/i })
    const popup = search.closest('[data-slot="combobox-content"]') ?? search
    fireEvent.keyDown(popup, { key: "Enter", code: "Enter", shiftKey: false })

    expect(onChange).toHaveBeenCalledWith({ validationNamedUsers: ["alice"] })
    expect(screen.queryByRole("combobox", { name: /Search members/i })).toBeNull()
  })

  it("Space with empty query toggles the auto-highlighted first member", async () => {
    const onChange = vi.fn()
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={[]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("combobox", { name: /Named validators/i }))
    const search = await screen.findByRole("combobox", { name: /Search members/i })
    expect((search as HTMLInputElement).value).toBe("")

    expect(fireEvent.keyDown(search, { key: " " })).toBe(false)
    expect(onChange).toHaveBeenCalledWith({ validationNamedUsers: ["alice"] })
    expect(screen.getByRole("combobox", { name: /Search members/i })).toBeTruthy()
  })

  it("Space toggles the highlighted member while list-nav locked", async () => {
    const onChange = vi.fn()
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={[]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("combobox", { name: /Named validators/i }))
    const search = await screen.findByRole("combobox", { name: /Search members/i })
    fireEvent.change(search, { target: { value: "al" } })
    fireEvent.keyDown(search, { key: "ArrowDown" })

    expect(fireEvent.keyDown(search, { key: " " })).toBe(false)
    expect(onChange).toHaveBeenCalledWith({ validationNamedUsers: ["alice"] })
    // Popup stays open (Space is multi-select, like Shift+Enter).
    expect(screen.getByRole("combobox", { name: /Search members/i })).toBeTruthy()
  })

  it("locks Space-as-typing after ArrowDown; ArrowUp on top unlocks", async () => {
    const onChange = vi.fn()
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={[]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("combobox", { name: /Named validators/i }))
    const search = await screen.findByRole("combobox", { name: /Search members/i })
    fireEvent.change(search, { target: { value: "al" } })

    // Space allowed while typing (handler does not preventDefault).
    expect(fireEvent.keyDown(search, { key: " " })).toBe(true)

    fireEvent.keyDown(search, { key: "ArrowDown" })
    // Space selects while locked (preventDefault).
    expect(fireEvent.keyDown(search, { key: " " })).toBe(false)
    expect(onChange).toHaveBeenCalled()

    // Extra unlock step: ArrowUp on the top item (wrap left alone).
    const top = screen.getAllByRole("option")[0]
    top?.setAttribute("data-highlighted", "")
    fireEvent.keyDown(search, { key: "ArrowUp" })

    onChange.mockClear()
    expect(fireEvent.keyDown(search, { key: " " })).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("typing again unlocks Space-as-typing", async () => {
    const onChange = vi.fn()
    render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={[]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("combobox", { name: /Named validators/i }))
    const search = await screen.findByRole("combobox", { name: /Search members/i })
    fireEvent.change(search, { target: { value: "al" } })
    fireEvent.keyDown(search, { key: "ArrowDown" })

    // Locked — Space selects.
    expect(fireEvent.keyDown(search, { key: " " })).toBe(false)
    expect(onChange).toHaveBeenCalled()
    onChange.mockClear()

    // Edit the query → unlock; Space no longer selects.
    fireEvent.change(search, { target: { value: "ali" } })
    expect(fireEvent.keyDown(search, { key: " " })).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })
})
