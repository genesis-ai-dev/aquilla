/**
 * VoiceLibraryPanel.test.tsx — the simplified Voices SELECTOR.
 *
 * Confirms the panel is now a pure selector: search + voice rows + narrator
 * badge, plus the two distinct entry points (New voice / Clone a voice). The
 * focused modals are exercised in their own tests.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { VoiceLibraryPanel } from "./VoiceLibraryPanel"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

// The create/clone modals are heavy (audio/network) — stub to a marker.
vi.mock("@/components/voice/VoiceCreator", () => ({
  VoiceCreator: ({ open }: { open: boolean }) => (open ? <div data-testid="voice-creator" /> : null),
}))
vi.mock("@/components/voice/CloneVoiceModal", () => ({
  CloneVoiceModal: ({ open }: { open: boolean }) => (open ? <div data-testid="clone-modal" /> : null),
}))
vi.mock("@/lib/store/user-api-keys", () => ({ useUserApiKey: () => "" }))

function makeVoice(over: Partial<Voice> = {}): Voice {
  return { id: "v-narrator", name: "Narrator", color: "#6366f1", provider: "gemini", voiceName: "Charon", ...over }
}

function setup() {
  const onSettingsChange = vi.fn()
  const narrator = makeVoice()
  const mary = makeVoice({ id: "v-mary", name: "Mary", color: "#ec4899", voiceName: "Kore" })
  const settings: ProjectTtsSettings = { provider: "gemini", voices: [narrator, mary], defaultVoiceId: narrator.id }
  render(
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
  it("renders search, rows, narrator badge, and the two action buttons", () => {
    setup()
    expect(screen.getByRole("heading", { name: "Voices" })).toBeTruthy()
    expect(screen.getByPlaceholderText("Search voices…")).toBeTruthy()
    expect(screen.getByText("Mary")).toBeTruthy()
    expect(screen.getByText("1/2 lines voiced")).toBeTruthy()
    // The narrator (default) row carries the narrator badge.
    expect(screen.getByTitle(/lines without an explicit speaker/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /New voice/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Clone a voice/ })).toBeTruthy()
  })

  it("filters rows by the search query", () => {
    setup()
    fireEvent.change(screen.getByPlaceholderText("Search voices…"), { target: { value: "mary" } })
    expect(screen.getByText("Mary")).toBeTruthy()
    expect(screen.queryByText("Narrator")).toBeNull()
  })

  it("opens the creator from New voice and the clone workflow from Clone a voice", () => {
    setup()
    fireEvent.click(screen.getByRole("button", { name: /New voice/ }))
    expect(screen.getByTestId("voice-creator")).toBeTruthy()
  })

  it("opens the clone modal from Clone a voice", () => {
    setup()
    fireEvent.click(screen.getByRole("button", { name: /Clone a voice/ }))
    expect(screen.getByTestId("clone-modal")).toBeTruthy()
  })
})
