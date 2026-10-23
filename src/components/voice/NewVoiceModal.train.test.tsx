/**
 * NewVoiceModal — the Train voice tab: a custom voice from the organization's own
 * recordings. Nothing starts until there is enough speech AND the maintainer
 * confirms the speaker's consent on the organization's behalf.
 */
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
// Every picked file "lasts" 3 minutes.
vi.mock("@/lib/import", async (orig) => ({
  ...(await orig<typeof import("@/lib/import")>()),
  probeDurationMsSafe: vi.fn(async () => 3 * 60_000),
}))
const startCustomVoiceTraining = vi.fn(async () => ({
  voiceId: "c-0123456789abcdef", audioMinutes: 6, attestedAt: "2026-10-23T10:00:00Z", statementVersion: "2026-10-23",
}))
vi.mock("@/lib/audio/custom-voice", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/custom-voice")>()),
  startCustomVoiceTraining: (...a: unknown[]) => startCustomVoiceTraining(...(a as [])),
}))

function renderModal(voice: Voice | null = null) {
  const onSave = vi.fn()
  render(
    <NewVoiceModal
      open onClose={vi.fn()} voice={voice} provider="inworld" isDefault={false} paletteIndex={0} cells={[]}
      onSave={onSave} projectId="p1" fileId="f1" session={{ jwt: "j", username: "dev", createdAt: "" }}
    />,
  )
  return { onSave }
}

const pick = (n: number) => {
  const files = Array.from({ length: n }, (_, i) => new File([new Uint8Array([1])], `take-${i}.wav`, { type: "audio/wav" }))
  fireEvent.change(screen.getByLabelText("Add recordings of the speaker"), { target: { files } })
}

describe("NewVoiceModal Train voice tab", () => {
  it("says plainly that consent is the organization's responsibility and the applicable law", () => {
    renderModal()
    fireEvent.click(screen.getByRole("tab", { name: /Train voice/ }))
    expect(screen.getByText("Consent is your organization's responsibility")).toBeInTheDocument()
    expect(screen.getByText(/Your organization must obtain and keep that consent/)).toBeInTheDocument()
    expect(screen.getByText(/follow the laws and agreements that apply to you and to the speaker/)).toBeInTheDocument()
  })

  it("won't start until there is enough speech and consent is confirmed", async () => {
    const { onSave } = renderModal()
    fireEvent.click(screen.getByRole("tab", { name: /Train voice/ }))
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Ana" } })
    const start = () => screen.getByRole("button", { name: "Start training" })

    pick(1) // 3 min — under the 5 min minimum
    await screen.findByText(/3\.0 min of speech/)
    fireEvent.click(screen.getByRole("checkbox"))
    expect(start()).toBeDisabled()

    pick(1) // 6 min total
    await screen.findByText(/6\.0 min of speech/)
    fireEvent.click(screen.getByRole("checkbox")) // untick
    expect(start()).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox"))
    expect(start()).toBeEnabled()

    fireEvent.click(start())
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(startCustomVoiceTraining).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1", speakerName: "Ana", consentConfirmed: true,
    }))
    expect(onSave.mock.calls[0][0]).toMatchObject({
      name: "Ana", libraryVoiceId: "c-0123456789abcdef", customVoice: { consentAttestedBy: "dev" },
    })
  })

  it("editing a trained voice only renames it", () => {
    const voice: Voice = {
      id: "v1", name: "Ana", libraryVoiceId: "c-0123456789abcdef",
      customVoice: { speakerName: "Ana", consentAttestedAt: "x", consentAttestedBy: "dev", consentStatementVersion: "2026-10-23", trainingStartedAt: "x" },
    }
    const { onSave } = renderModal(voice)
    expect(screen.queryByRole("button", { name: "Start training" })).toBeNull()
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Ana Lima" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith({ ...voice, name: "Ana Lima" })
  })
})
