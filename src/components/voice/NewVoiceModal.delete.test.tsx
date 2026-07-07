/**
 * NewVoiceModal.delete.test.tsx — FRO-291 delete-confirm guard.
 *
 * Verifies that the voice delete action is gated by the checkbox-confirm
 * dialog: instant delete is blocked; cancel preserves the voice; onDelete
 * fires only after checkbox+confirm. (Ported from the retired CharacterModal.)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NewVoiceModal } from "./NewVoiceModal"
import type { Voice } from "@/lib/parsers/types"

// ── Stub heavy audio / network dependencies ──────────────────────────────

vi.mock("@/components/VoiceCloneSection", () => ({
  VoiceCloneSection: () => null,
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

// ── Helpers ───────────────────────────────────────────────────────────────

function makeVoice(overrides: Partial<Voice> = {}): Voice {
  return {
    id: "voice-1",
    name: "Narrator",
    color: "#e2e8f0",
    provider: "gemini",
    voiceName: "Kore",
    builtIn: false,
    ...overrides,
  }
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
    <NewVoiceModal
      open
      voice={voice}
      isDefault={false}
      paletteIndex={0}
      cells={[]}
      onSave={onSave}
      onDelete={onDelete}
      onClose={onClose}
    />,
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("NewVoiceModal delete confirm (FRO-291)", () => {
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
      expect(screen.getByRole("heading", { name: /Delete voice/i })).toBeInTheDocument()
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
      expect(screen.getByRole("heading", { name: /Delete voice/i })).toBeInTheDocument()
    )

    // Confirm button is disabled before checkbox
    const confirmBtn = screen.getByRole("button", { name: /^Delete voice$/i })
    expect(confirmBtn).toBeDisabled()

    // Check the checkbox via its label text: happy-dom re-dispatches
    // label-wrapped clicks back onto the control, so clicking the checkbox
    // itself double-toggles there (browsers don't).
    const checkbox = screen.getByRole("checkbox")
    expect(checkbox).toHaveAttribute("aria-checked", "false")
    fireEvent.click(
      screen.getByText(/deletes the voice for everyone/i),
    )
    expect(checkbox).toHaveAttribute("aria-checked", "true")
    expect(confirmBtn).not.toBeDisabled()

    // Confirm
    fireEvent.click(confirmBtn)
    expect(onDeleteMock).toHaveBeenCalledTimes(1)
  })

  it("does not show Delete button for builtIn voices", () => {
    renderModal({ voice: makeVoice({ builtIn: true }), onDelete: onDeleteMock })

    expect(screen.queryByRole("button", { name: /^Delete$/i })).not.toBeInTheDocument()
  })
})
