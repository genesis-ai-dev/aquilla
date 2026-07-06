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

  // FRO-360: cast voices minted on subtitle import (buildCastAdditions) carry
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
    const kokoroVoice = makeVoice({ id: "v-kokoro", name: "Kid", provider: "kokoro", voiceName: "af_heart" })
    const settings: ProjectTtsSettings = { provider: "omnivoice", voices: [kokoroVoice] }
    render(
      <VoiceLibraryPanel
        projectId="dev-project"
        settings={settings}
        onSettingsChange={onSettingsChange}
      />,
    )
    expect(screen.getByText("Kokoro")).toBeTruthy()
  })
})

// FRO-365: viewer/below-floor character-CRUD gating. Character writes flow
// through PUT/PATCH /projects/:id/settings, which the server gates at
// maintainer (600) — the panel must mirror that floor client-side so a
// below-floor user (a) doesn't get a "New voice" / row-menu affordance that
// silently no-ops or false-echoes into localStorage, and (b) sees why.
describe("VoiceLibraryPanel — FRO-365 role gating", () => {
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
