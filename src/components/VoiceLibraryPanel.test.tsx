/**
 * VoiceLibraryPanel.test.tsx — the simplified Voices SELECTOR.
 *
 * Confirms the panel is a pure selector: search + voice rows + narrator star,
 * plus a single "New voice" entry point that opens the unified modal (which
 * carries both TTS + Clone tabs, exercised in its own test) seeded with the
 * project's configured engine — not hardcoded Gemini.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { VoiceLibraryPanel } from "./VoiceLibraryPanel"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"
import type { NewVoiceModalProps } from "@/components/voice/NewVoiceModal"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"

// The unified create/clone modal is heavy (audio/network) — stub to a marker
// that records the props the panel wires in.
const modalProps: { last: NewVoiceModalProps | null } = { last: null }
vi.mock("@/components/voice/NewVoiceModal", () => ({
  NewVoiceModal: (props: NewVoiceModalProps) => {
    modalProps.last = props
    return props.open ? <div data-testid="new-voice-modal" /> : null
  },
}))

function makeVoice(over: Partial<Voice> = {}): Voice {
  return { id: "v-narrator", name: "Narrator", color: "#475569", provider: "gemini", voiceName: "Charon", ...over }
}

function setup(settingsOver: Partial<ProjectTtsSettings> = {}) {
  const onSettingsChange = vi.fn()
  const narrator = makeVoice()
  const mary = makeVoice({ id: "v-mary", name: "Mary", color: "#be123c", voiceName: "Kore" })
  const settings: ProjectTtsSettings = {
    provider: "gemini",
    voices: [narrator, mary],
    defaultVoiceId: narrator.id,
    ...settingsOver,
  }
  modalProps.last = null
  renderWithTooltips(
    <VoiceLibraryPanel
      projectId="dev-project"
      settings={settings}
      onSettingsChange={onSettingsChange}
      castStats={new Map([["v-mary", { assigned: 2, voiced: 1 }]])}
      selectedVoiceId="v-mary"
    />,
  )
  return { onSettingsChange }
}

describe("VoiceLibraryPanel (selector)", () => {
  it("renders search, rows, narrator star, and a single New voice button", async () => {
    setup()
    expect(screen.getByRole("heading", { name: "Voices" })).toBeTruthy()
    expect(screen.getByPlaceholderText("Search voices…")).toBeTruthy()
    expect(screen.getByText("Mary")).toBeTruthy()
    expect(screen.getByText(/1\/2 voiced/)).toBeTruthy()
    // The narrator (default) row carries a star whose tooltip is just "Narrator".
    await expectTooltip(screen.getByTestId("voice-narrator-star"), "Narrator")
    expect(screen.getByRole("button", { name: /New voice/ })).toBeTruthy()
  })

  // AQU-959: a partner opened Voices as a contributor, found "New voice" greyed
  // out, and got no tooltip, no message and no path forward — the demo stalled
  // until the host changed her role by hand. The role gate and its denial
  // sentence were already here (AQU-365); what was missing is that a disabled
  // button swallows hover, so the sentence could never surface. Asserting the
  // hover would prove nothing (happy-dom dispatches on disabled elements and a
  // browser does not) — assert that the tooltip's trigger is a real, focusable
  // element that is not the disabled button.
  it("explains why New voice is dead for a contributor instead of going silent", () => {
    const narrator = makeVoice()
    renderWithTooltips(
      <VoiceLibraryPanel
        projectId="dev-project"
        settings={{ provider: "gemini", voices: [narrator], defaultVoiceId: narrator.id }}
        onSettingsChange={vi.fn()}
        roleLevel={ROLE.CONTRIBUTOR}
      />,
    )

    const button = screen.getByRole("button", { name: /New voice/ })
    expect(button).toBeDisabled()

    const standIn = document.querySelector('[data-slot="tooltip-disabled-trigger"]')
    expect(standIn).not.toBeNull()
    expect(standIn).not.toHaveAttribute("disabled")
    expect(standIn).toContainElement(button)
    // Full-width button: the stand-in must carry the width or the row collapses.
    expect(standIn).toHaveClass("w-full")
  })

  // The other half of the AC: a user who CAN create voices gains no new chrome.
  it("adds no stand-in trigger for a maintainer who can create voices", () => {
    const narrator = makeVoice()
    renderWithTooltips(
      <VoiceLibraryPanel
        projectId="dev-project"
        settings={{ provider: "gemini", voices: [narrator], defaultVoiceId: narrator.id }}
        onSettingsChange={vi.fn()}
        roleLevel={ROLE.MAINTAINER}
      />,
    )
    expect(screen.getByRole("button", { name: /New voice/ })).not.toBeDisabled()
    expect(document.querySelector('[data-slot="tooltip-disabled-trigger"]')).toBeNull()
  })

  it("filters rows by the search query", () => {
    setup()
    fireEvent.change(screen.getByPlaceholderText("Search voices…"), { target: { value: "mary" } })
    expect(screen.getByText("Mary")).toBeTruthy()
    expect(screen.queryByText("Narrator")).toBeNull()
  })

  it("opens the unified modal from New voice, seeded with the project engine", () => {
    const onSettingsChange = vi.fn()
    const narrator = makeVoice()
    renderWithTooltips(
      <VoiceLibraryPanel
        projectId="dev-project"
        targetLanguage="en"
        targetLanes={["es"]}
        settings={{ provider: "mms", voices: [narrator], defaultVoiceId: narrator.id }}
        onSettingsChange={onSettingsChange}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /New voice/ }))
    expect(screen.getByTestId("new-voice-modal")).toBeTruthy()
    expect(modalProps.last?.provider).toBe("mms")
    expect(modalProps.last?.voice).toBeNull()
    expect(modalProps.last?.targetLanguage).toBe("en")
    expect(modalProps.last?.targetLanes).toEqual(["es"])
  })

  it("labels each row with the voice's own engine, not Gemini", () => {
    setup({
      provider: "mms",
      voices: [
        makeVoice({ id: "v-k", name: "Kiki", provider: "inworld", voiceName: "Dennis" }),
        makeVoice({ id: "v-c", name: "Cloney", provider: undefined, voiceName: undefined, referenceAudioId: "ref-1.webm" }),
        // No per-voice engine → falls back to the project engine (mms).
        makeVoice({ id: "v-legacy", name: "Legacy", provider: undefined, voiceName: undefined }),
      ],
      defaultVoiceId: "v-k",
    })
    expect(screen.getByText("Inworld")).toBeTruthy()
    expect(screen.getByText("Clone")).toBeTruthy()
    expect(screen.getByText("MMS")).toBeTruthy()
  })

  // AQU-360: cast voices minted on subtitle import (buildCastAdditions) carry
  // no `provider` of their own — they must display the PROJECT's configured
  // engine, not a hardcoded "Gemini".
  it("shows the project's configured provider for a voice with no provider of its own (imported cast)", () => {
    const onSettingsChange = vi.fn()
    // Imported cast voice: only { id, name, color } — exactly what
    // buildCastAdditions mints, no `provider` field.
    const importedCastMember: Voice = { id: "v-imported", name: "Speaker 1", color: "#0d9488" }
    const settings: ProjectTtsSettings = { provider: "mms", voices: [importedCastMember] }
    render(
      <VoiceLibraryPanel
        projectId="dev-project"
        settings={settings}
        onSettingsChange={onSettingsChange}
      />,
    )
    expect(screen.getByText("Speaker 1")).toBeTruthy()
    expect(screen.getByText("MMS")).toBeTruthy()
    expect(screen.queryByText("Gemini")).toBeNull()
  })

  it("still labels a voice with its own explicit provider, ignoring the project default", () => {
    const onSettingsChange = vi.fn()
    const leftoverKokoro = makeVoice({ id: "v-kokoro", name: "Kid", provider: "kokoro", voiceName: "af_heart" })
    const settings: ProjectTtsSettings = { provider: "gemini", voices: [leftoverKokoro] }
    render(
      <VoiceLibraryPanel
        projectId="dev-project"
        settings={settings}
        onSettingsChange={onSettingsChange}
      />,
    )
    expect(screen.getByText("Inworld")).toBeTruthy()
    expect(screen.queryByText("Kokoro")).toBeNull()
  })

  it("opens Edit / Make narrator / Delete from the ⋯ menu", () => {
    setup()
    const maryRow = screen.getByText("Mary").closest("[role='button']")
    expect(maryRow).toBeInstanceOf(HTMLElement)
    fireEvent.click(within(maryRow as HTMLElement).getByRole("button", { name: /More voice actions/ }))
    expect(screen.getByRole("menuitem", { name: /^Edit$/ })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /^Make narrator$/ })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /^Delete$/ })).toBeTruthy()
  })

  it("opens the same items from a right-click on the row", () => {
    setup()
    fireEvent.contextMenu(screen.getByText("Mary"))
    expect(screen.getByRole("menuitem", { name: /^Edit$/ })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /^Make narrator$/ })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /^Delete$/ })).toBeTruthy()
  })

  it("places the selected check to the left of the ⋯ menu trigger", () => {
    setup()
    const maryRow = screen.getByText("Mary").closest("[role='button']")
    expect(maryRow).toBeTruthy()
    const check = maryRow!.querySelector("[data-testid='voice-row-selected']")
    const more = screen.getAllByRole("button", { name: /More voice actions/ }).find((btn) => maryRow!.contains(btn))
    expect(check).toBeTruthy()
    expect(more).toBeTruthy()
    expect(check!.compareDocumentPosition(more!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("badges voice names with their language when the project has multiple lanes", () => {
    const onSettingsChange = vi.fn()
    render(
      <VoiceLibraryPanel
        projectId="dev-project"
        targetLanguage="en"
        targetLanes={["es"]}
        settings={{
          provider: "inworld",
          voices: [
            makeVoice({ id: "v-en", name: "Dennis", provider: "inworld", voiceName: "Dennis", language: "en-US" }),
            makeVoice({ id: "v-es", name: "Diego", provider: "inworld", voiceName: "Diego", language: "es-ES" }),
          ],
        }}
        onSettingsChange={onSettingsChange}
      />,
    )
    expect(screen.getByText("en-US")).toBeTruthy()
    expect(screen.getByText("es-ES")).toBeTruthy()
  })

  it("does not badge voice names on a single-lane project", () => {
    const onSettingsChange = vi.fn()
    render(
      <VoiceLibraryPanel
        projectId="dev-project"
        targetLanguage="en"
        settings={{
          provider: "inworld",
          voices: [
            makeVoice({ id: "v-en", name: "Dennis", provider: "inworld", voiceName: "Dennis", language: "en-US" }),
          ],
        }}
        onSettingsChange={onSettingsChange}
      />,
    )
    expect(screen.getByText("Dennis")).toBeTruthy()
    expect(screen.queryByText("en-US")).toBeNull()
  })

  it("puts the voice language in the row description", () => {
    const onSettingsChange = vi.fn()
    render(
      <VoiceLibraryPanel
        projectId="dev-project"
        targetLanguage="en"
        settings={{
          provider: "inworld",
          voices: [
            makeVoice({
              id: "v-en",
              name: "Dennis",
              provider: "inworld",
              voiceName: "Dennis",
              language: "en-US",
            }),
          ],
        }}
        onSettingsChange={onSettingsChange}
        castStats={new Map([["v-en", { assigned: 2, voiced: 0 }]])}
      />,
    )
    const row = screen.getByText("Dennis").closest("[role='button']")
    expect(row).toHaveTextContent(/Inworld/)
    expect(row).toHaveTextContent(/English/i)
    expect(row).toHaveTextContent(/0\/2 voiced/)
  })

  it("uses the project language on a voice that has none of its own", () => {
    const onSettingsChange = vi.fn()
    render(
      <VoiceLibraryPanel
        projectId="dev-project"
        targetLanguage="es"
        targetLanes={["fr"]}
        settings={{
          provider: "inworld",
          voices: [makeVoice({ id: "v-narrator", name: "Narrator", provider: "inworld" })],
          defaultVoiceId: "v-narrator",
        }}
        onSettingsChange={onSettingsChange}
      />,
    )
    const row = screen.getByText("Narrator").closest("[role='button']")
    expect(row).toHaveTextContent(/Spanish/i)
  })
})

// AQU-365: viewer/below-floor character-CRUD gating. Character writes flow
// through PUT/PATCH /projects/:id/settings, which the server gates at
// maintainer (600) — the panel must mirror that floor client-side so a
// below-floor user (a) doesn't get a "New voice" / row-menu affordance that
// silently no-ops or false-echoes into localStorage, and (b) sees why.
describe("VoiceLibraryPanel — AQU-365 role gating", () => {
  function setupWithRole(roleLevel: number | null) {
    const onSettingsChange = vi.fn()
    const narrator = makeVoice()
    const mary = makeVoice({ id: "v-mary", name: "Mary", color: "#be123c", voiceName: "Kore" })
    const settings: ProjectTtsSettings = { provider: "gemini", voices: [narrator, mary], defaultVoiceId: narrator.id }
    render(
      <VoiceLibraryPanel
        projectId="dev-project"
        settings={settings}
        onSettingsChange={onSettingsChange}
        castStats={new Map([["v-mary", { assigned: 2, voiced: 1 }]])}
        selectedVoiceId="v-mary"
        roleLevel={roleLevel}
      />,
    )
    return { onSettingsChange }
  }

  it("disables New voice for a viewer (100, below maintainer floor)", () => {
    setupWithRole(100)
    const button = screen.getByRole("button", { name: /New voice/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it("disables New voice for a contributor (400, still below maintainer floor)", () => {
    setupWithRole(400)
    const button = screen.getByRole("button", { name: /New voice/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it("hides the row ⋯ menu (edit/delete/set-narrator) for a viewer", () => {
    setupWithRole(100)
    expect(screen.queryByRole("button", { name: /More voice actions/ })).toBeNull()
  })

  it("enables New voice and the row menu for a maintainer (600)", () => {
    setupWithRole(600)
    const button = screen.getByRole("button", { name: /New voice/ }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(screen.getAllByRole("button", { name: /More voice actions/ }).length).toBeGreaterThan(0)
  })

  it("fails open (New voice enabled) when roleLevel is not provided (local/legacy project)", () => {
    setupWithRole(null)
    const button = screen.getByRole("button", { name: /New voice/ }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })
})

describe("VoiceLibraryPanel — settings sync (AQU-1001)", () => {
  it("shows a voice that lands on settings after the initial seed", () => {
    const onSettingsChange = vi.fn()
    const narrator = makeVoice()
    const settings: ProjectTtsSettings = { provider: "gemini", voices: [narrator], defaultVoiceId: narrator.id }
    const { rerender } = render(
      <VoiceLibraryPanel
        projectId="dev-project"
        settings={settings}
        onSettingsChange={onSettingsChange}
      />,
    )
    expect(screen.queryByText("Keean")).toBeNull()

    const cloned: Voice = { id: "v-clone", name: "Keean", color: "#0d9488", referenceAudioId: "ref.webm" }
    rerender(
      <VoiceLibraryPanel
        projectId="dev-project"
        settings={{ ...settings, voices: [narrator, cloned] }}
        onSettingsChange={onSettingsChange}
      />,
    )
    expect(screen.getByText("Keean")).toBeTruthy()
  })
})
