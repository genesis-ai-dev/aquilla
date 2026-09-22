// AQU-490: the audio half of the validation card.
//
// Sam's ruling is that these are SEPARATE settings from the text ones — a
// project can want two ears on a recording and one on a translation, or trust
// a different set of people with each. So the thing worth pinning is not that
// the controls exist but that they are genuinely independent: changing one
// must never emit the other's key.
import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ValidationSettingsSection } from "./ValidationSettingsSection"

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [
      { userId: 1, username: "alice", role: { level: 700, name: "owner", source: "creator" as const }, secondarySources: [] },
      { userId: 2, username: "bob", role: { level: 300, name: "reviewer", source: "override" as const }, secondarySources: [] },
    ],
    isLoading: false, error: null, rosterHidden: false,
    refresh: async () => {}, add: async () => null, addMany: async () => [],
    remove: async () => {}, changeRole: async () => null,
  }),
}))

function draw(over: Record<string, unknown> = {}) {
  const onChange = vi.fn()
  render(
    <ValidationSettingsSection
      projectId="p1"
      validationCount={1}
      validationCountAudio={1}
      hasAnyAudioData
      onChange={onChange}
      {...over}
    />,
  )
  return { onChange }
}

describe("ValidationSettingsSection — the audio policy", () => {
  it("offers its own role floor, self-validation switch and allowlist", () => {
    draw()
    expect(screen.getByRole("combobox", { name: /Minimum role to validate recordings/i })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: /Allow validating your own recordings/i })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /Named recording validators/i })).toBeInTheDocument()
  })

  // THE SEPARATION, which is the whole ruling. Flipping the audio switch must
  // emit the audio key and only the audio key.
  it("emits only the audio key when the audio switch flips", () => {
    const { onChange } = draw({ allowSelfValidationAudio: true, allowSelfValidation: true })
    fireEvent.click(screen.getByRole("switch", { name: /Allow validating your own recordings/i }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ allowSelfValidationAudio: false })
  })

  it("emits only the text key when the text switch flips", () => {
    const { onChange } = draw({ allowSelfValidationAudio: true, allowSelfValidation: true })
    const switches = screen.getAllByRole("switch")
    // The TEXT switch is the one that is not the audio switch — queried this
    // way rather than by label so the test does not silently pass if the two
    // labels ever converge.
    const audio = screen.getByRole("switch", { name: /Allow validating your own recordings/i })
    const textSwitch = switches.find((el) => el !== audio && /self|own/i.test(el.getAttribute("aria-label") ?? ""))!
    fireEvent.click(textSwitch)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(Object.keys(onChange.mock.calls[0][0])).toEqual(["allowSelfValidation"])
  })

  // The write path, not just the read path: selecting into the audio
  // allowlist must emit the AUDIO key. Pointing it at the text key would be
  // invisible on screen — both comboboxes would keep rendering their own
  // prop — and would quietly apply the recording rule to translations.
  it("writes the audio key when a name is added to the audio allowlist", async () => {
    const { onChange } = draw({ validationNamedUsersAudio: [] })
    fireEvent.click(screen.getByRole("combobox", { name: /Named recording validators/i }))
    await screen.findByRole("option", { name: "alice" })
    const search = screen.getByRole("combobox", { name: /Search members/i })
    const popup = search.closest('[data-slot="combobox-content"]') ?? search
    fireEvent.keyDown(popup, { key: "Enter", code: "Enter", shiftKey: true })
    expect(onChange).toHaveBeenCalledWith({ validationNamedUsersAudio: ["alice"] })
  })

  it("shows the audio allowlist independently of the text one", () => {
    draw({ validationNamedUsers: ["alice"], validationNamedUsersAudio: ["bob"] })
    expect(screen.getByRole("combobox", { name: /Named validators/i }).textContent).toContain("alice")
    expect(screen.getByRole("combobox", { name: /Named recording validators/i }).textContent).toContain("bob")
  })
})

// Sam, 2026-09-21: a fully dubbed project's audio threshold could not be
// edited because the "audio exists" signal was a device-local latch. The field
// is a policy number the projection applies at read time; nothing depends on
// a take existing first, so it is never gated on one.
describe("the audio threshold input", () => {
  it("is editable even when this device has never seen audio", () => {
    draw({ hasAnyAudioData: false })
    expect(screen.getByLabelText(/Required validators \(audio\)/i)).toBeEnabled()
  })

  it("still respects the role/offline gate", () => {
    draw({ hasAnyAudioData: false, disabled: true })
    expect(screen.getByLabelText(/Required validators \(audio\)/i)).toBeDisabled()
  })
})
