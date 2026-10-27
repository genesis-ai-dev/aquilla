/**
 * NewVoiceModal — the Characters tab: one click adds a ready-made character
 * voice to the cast; editing a character voice re-points it.
 */
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { NewVoiceModal } from "./NewVoiceModal"
import type { Voice } from "@/lib/parsers/types"

vi.mock("@/lib/sync/tts", () => ({
  listInworldVoices: vi.fn().mockResolvedValue([]),
  listInworldSupportedLanguages: vi.fn().mockResolvedValue([]),
  synthesizeCellTts: vi.fn(),
  designInworldVoice: vi.fn(),
  publishInworldVoice: vi.fn(),
}))
vi.mock("@/components/VoiceCloneSection", () => ({ VoiceCloneSection: () => null }))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
vi.mock("@/lib/audio/voice-clone", () => ({ buildVoiceReferenceId: vi.fn(), uploadVoiceReference: vi.fn() }))
vi.mock("@/lib/audio/upload", () => ({
  parseFrontierAudioUrl: vi.fn(), fetchCellAudio: vi.fn(), getCellAudioStreamUrl: vi.fn(),
}))

function renderModal(props: { voice?: Voice | null; existingVoices?: Voice[] } = {}) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(
    <NewVoiceModal
      open
      onClose={onClose}
      voice={props.voice ?? null}
      provider="inworld"
      isDefault={false}
      paletteIndex={0}
      cells={[]}
      onSave={onSave}
      existingVoices={props.existingVoices}
    />,
  )
  return { onSave, onClose }
}

const card = (name: string) => screen.getByText(name, { selector: "p" }).closest("li") as HTMLElement

describe("NewVoiceModal Characters tab", () => {
  it("adds a character to the cast in one click, with no engine or Create step", () => {
    const { onSave, onClose } = renderModal()
    fireEvent.click(screen.getByRole("tab", { name: /Characters/ }))
    expect(screen.queryByRole("button", { name: /Create voice/ })).toBeNull()

    fireEvent.click(within(card("Hearth")).getByRole("button", { name: "Add Hearth to the cast" }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Hearth", libraryVoiceId: "narrator-hearth" }))
    const saved = onSave.mock.calls[0][0] as Voice
    expect(saved.provider).toBeUndefined()
    expect(saved.referenceAudioId).toBeUndefined()
    expect(onClose).toHaveBeenCalled()
  })

  it("marks characters already in the cast instead of offering them again", () => {
    renderModal({ existingVoices: [{ id: "v1", name: "Hearth", libraryVoiceId: "narrator-hearth" }] })
    fireEvent.click(screen.getByRole("tab", { name: /Characters/ }))
    expect(within(card("Hearth")).getByRole("button", { name: "Hearth is already in the cast" })).toBeDisabled()
    expect(within(card("Willow")).getByRole("button", { name: "Add Willow to the cast" })).toBeEnabled()
  })

  it("narrows the grid with filter chips", () => {
    renderModal()
    fireEvent.click(screen.getByRole("tab", { name: /Characters/ }))
    fireEvent.click(screen.getByRole("button", { name: "Child" }))
    expect(screen.getByText("Poppy")).toBeInTheDocument()
    expect(screen.queryByText("Hearth")).toBeNull()
  })

  it("editing a character voice re-points it and keeps the user's name", () => {
    const voice: Voice = { id: "v1", name: "Grandpa", color: "#475569", libraryVoiceId: "narrator-hearth" }
    const { onSave } = renderModal({ voice })
    expect(screen.queryByRole("tab", { name: /Characters/ })).toBeNull()
    fireEvent.click(within(card("Oak")).getByRole("button", { name: "Use Oak" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith({ id: "v1", name: "Grandpa", color: "#475569", libraryVoiceId: "elder-oak" })
  })
})
