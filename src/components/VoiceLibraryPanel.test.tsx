/**
 * VoiceLibraryPanel.test.tsx — the simplified Voices SELECTOR.
 *
 * Confirms the panel is a pure selector: search + voice rows + narrator badge,
 * plus a single "New voice" entry point that opens the unified modal (which
 * carries both Gemini + Clone tabs, exercised in its own test).
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { VoiceLibraryPanel } from "./VoiceLibraryPanel"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

// The unified create/clone modal is heavy (audio/network) — stub to a marker.
vi.mock("@/components/voice/NewVoiceModal", () => ({
  NewVoiceModal: ({ open }: { open: boolean }) => (open ? <div data-testid="new-voice-modal" /> : null),
}))

function makeVoice(over: Partial<Voice> = {}): Voice {
  return { id: "v-narrator", name: "Narrator", color: "#475569", provider: "gemini", voiceName: "Charon", ...over }
}

function setup() {
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
    />,
  )
  return { onSettingsChange }
}

describe("VoiceLibraryPanel (selector)", () => {
  it("renders search, rows, narrator badge, and a single New voice button", () => {
    setup()
    expect(screen.getByRole("heading", { name: "Voices" })).toBeTruthy()
    expect(screen.getByPlaceholderText("Search voices…")).toBeTruthy()
    expect(screen.getByText("Mary")).toBeTruthy()
    expect(screen.getByText(/1\/2 voiced/)).toBeTruthy()
    // The narrator (default) row carries the narrator badge.
    expect(screen.getByTitle(/lines without an explicit speaker/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /New voice/ })).toBeTruthy()
  })

  it("filters rows by the search query", () => {
    setup()
    fireEvent.change(screen.getByPlaceholderText("Search voices…"), { target: { value: "mary" } })
    expect(screen.getByText("Mary")).toBeTruthy()
    expect(screen.queryByText("Narrator")).toBeNull()
  })

  it("opens the unified modal from New voice", () => {
    setup()
    fireEvent.click(screen.getByRole("button", { name: /New voice/ }))
    expect(screen.getByTestId("new-voice-modal")).toBeTruthy()
  })
})
