/**
 * CharacterModal.delete.test.tsx — FRO-291 delete-confirm guard.
 *
 * Verifies that the voice character delete action is gated by the
 * checkbox-confirm dialog: instant delete is blocked; cancel preserves the
 * character; onDelete fires only after checkbox+confirm.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { CharacterModal } from "./CharacterModal"
import type { Voice } from "@/lib/parsers/types"

// ── Stub heavy audio / network dependencies ──────────────────────────────

vi.mock("@/lib/audio/tts", () => ({
  synthesizeToWavBlob: vi.fn(),
}))
vi.mock("@/lib/audio/tts-providers", () => ({
  normalizeVoiceForProvider: vi.fn((v: Voice) => v),
  defaultVoiceNameForProvider: vi.fn(() => "en-US-Standard-A"),
  TTS_PROVIDER_INFOS: [],
}))
vi.mock("@/lib/audio/gemini-tts", () => ({
  GEMINI_TTS_VOICES: [],
}))
vi.mock("@/lib/audio/voices", () => ({
  newVoiceId: vi.fn(() => "voice-new"),
  VOICE_PALETTE: ["#e2e8f0"],
}))
vi.mock("@/lib/audio/mms-languages", () => ({
  HAS_EXTENDED_MMS_MODELS: false,
  POPULAR_MMS_LANGUAGES: [],
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: vi.fn(),
}))
vi.mock("@/lib/audio/voice-clone", () => ({
  buildVoiceReferenceId: vi.fn(),
  uploadVoiceReference: vi.fn(),
}))
vi.mock("@/lib/audio/upload", () => ({
  parseFrontierAudioUrl: vi.fn(),
  fetchCellAudio: vi.fn(),
}))
vi.mock("@/components/VoiceCloneSection", () => ({
  VoiceCloneSection: () => null,
}))

// ── Helpers ───────────────────────────────────────────────────────────────

function makeVoice(overrides: Partial<Voice> = {}): Voice {
  return {
    id: "voice-1",
    name: "Narrator",
    color: "#e2e8f0",
    provider: "gemini",
    voiceName: "en-US-Standard-A",
    builtIn: false,
    ...overrides,
  } as Voice
}

function renderModal({
  voice = makeVoice(),
  onDelete = vi.fn(),
  onSave = vi.fn(),
  onClose = vi.fn(),
}: {
  voice?: Voice
  onDelete?: () => void
  onSave?: (v: Voice) => void
  onClose?: () => void
} = {}) {
  return render(
    <CharacterModal
      open
      voice={voice}
      provider="gemini"
      apiKey="test-key"
      isDefault={false}
      cells={[]}
      onSave={onSave}
      onDelete={onDelete}
      onClose={onClose}
    />,
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("CharacterModal delete confirm (FRO-291)", () => {
  let onDeleteMock: Mock<() => void>

  beforeEach(() => {
    onDeleteMock = vi.fn<() => void>()
  })

  it("does NOT call onDelete immediately when Delete button is clicked", async () => {
    renderModal({ onDelete: onDeleteMock })

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }))

    expect(onDeleteMock).not.toHaveBeenCalled()
  })

  it("shows confirm dialog with consequence copy after clicking Delete", async () => {
    renderModal({ onDelete: onDeleteMock })

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }))

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Delete character/i })).toBeInTheDocument()
    })
    expect(screen.getAllByText(/everyone in the project/i).length).toBeGreaterThan(0)
  })

  it("cancel leaves onDelete uncalled and closes dialog", async () => {
    renderModal({ onDelete: onDeleteMock })

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }))
    await waitFor(() => expect(screen.getAllByRole("dialog").length).toBeGreaterThanOrEqual(1))

    // Click Cancel inside the confirm dialog (the second dialog)
    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/i })
    fireEvent.click(cancelBtns[cancelBtns.length - 1])

    expect(onDeleteMock).not.toHaveBeenCalled()
  })

  it("calls onDelete only after checkbox is checked and confirm button is clicked", async () => {
    renderModal({ onDelete: onDeleteMock })

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }))
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Delete character/i })).toBeInTheDocument()
    )

    // Confirm button is disabled before checkbox
    const confirmBtn = screen.getByRole("button", { name: /^Delete character$/i })
    expect(confirmBtn).toBeDisabled()

    // Check the checkbox via its label text: happy-dom re-dispatches
    // label-wrapped clicks back onto the control, so clicking the checkbox
    // itself double-toggles there (browsers don't).
    const checkbox = screen.getByRole("checkbox")
    expect(checkbox).toHaveAttribute("aria-checked", "false")
    fireEvent.click(
      screen.getByText(/deletes the voice character for everyone/i),
    )
    expect(checkbox).toHaveAttribute("aria-checked", "true")
    expect(confirmBtn).not.toBeDisabled()

    // Confirm
    fireEvent.click(confirmBtn)
    expect(onDeleteMock).toHaveBeenCalledTimes(1)
  })

  it("does not show Delete button for builtIn characters", () => {
    renderModal({ voice: makeVoice({ builtIn: true }), onDelete: onDeleteMock })

    // Delete button should not be in DOM for built-in voices
    expect(screen.queryByRole("button", { name: /^Delete$/i })).not.toBeInTheDocument()
  })
})
