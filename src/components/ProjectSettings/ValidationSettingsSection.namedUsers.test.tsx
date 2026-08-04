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
  it("renders selected usernames as chips and exposes the combobox input", () => {
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

    expect(screen.getByText("alice")).toBeTruthy()
    expect(screen.getByText("bob")).toBeTruthy()
    expect(screen.getByRole("combobox", { name: /Named validators/i })).toBeTruthy()
  })

  it("removing a chip calls onChange without that username", () => {
    const onChange = vi.fn()
    const { container } = render(
      <ValidationSettingsSection
        projectId="p1"
        validationCount={2}
        validationCountAudio={2}
        hasAnyAudioData={false}
        validationNamedUsers={["alice", "bob"]}
        onChange={onChange}
      />,
    )

    const bobChip = Array.from(
      container.querySelectorAll('[data-slot="combobox-chip"]'),
    ).find((el) => el.textContent?.includes("bob"))
    expect(bobChip).toBeTruthy()
    const remove = bobChip!.querySelector('[data-slot="combobox-chip-remove"]')
    expect(remove).toBeTruthy()
    fireEvent.click(remove!)

    expect(onChange).toHaveBeenCalledWith({ validationNamedUsers: ["alice"] })
  })
})
