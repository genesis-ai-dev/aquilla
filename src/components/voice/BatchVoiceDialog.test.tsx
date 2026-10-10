/**
 * BatchVoiceDialog.test.tsx — AQU-1722.
 *
 * The dialog's whole job is to make a batch's scope and cost legible BEFORE
 * any credits are spent, so these tests are about what it PROMISES: the count,
 * the estimate, the skip clauses, the explicit choice over lines that already
 * have audio, and that the run it fires matches the plan it showed.
 *
 * `planBatchVoice` is kept real (it is the thing on screen); only the run and
 * the billing fetch are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BatchVoiceDialog } from "./BatchVoiceDialog"
import { runBatchVoice } from "@/lib/audio/batch-voice"
import { getOrgBilling } from "@/lib/sync/billing"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

vi.mock("@/lib/audio/batch-voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio/batch-voice")>()),
  runBatchVoice: vi.fn(async () => ({
    generated: 2,
    failures: [],
    skipped: [],
    notAttempted: [],
    cancelled: false,
    stoppedAtCap: false,
  })),
}))

vi.mock("@/lib/sync/billing", () => ({ getOrgBilling: vi.fn(async () => null) }))

vi.mock("@/lib/audio/tts", () => ({
  ttsStatusKey: (id: string) => `synth:${id}`,
  getTtsStatus: vi.fn(() => ({ kind: "idle" as const })),
  setTtsStatus: vi.fn(),
}))

const mockRun = vi.mocked(runBatchVoice)
const mockBilling = vi.mocked(getOrgBilling)

const cell = (id: string, overrides: Partial<CellData> = {}): CellData =>
  ({
    id,
    fileId: "f1",
    original: "Hello",
    translated: "one two three",
    context: "LUK 1:1",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    group: "",
    type: "text",
    ...overrides,
  }) as CellData

const project = {
  id: "p1",
  orgId: 7,
  sourceLanguage: "en",
  ttsSettings: {
    defaultVoiceId: "v-anna",
    voices: [
      { id: "v-anna", name: "Anna" },
      { id: "v-clone", name: "Joel clone", referenceAudioId: "ref.webm" },
    ],
  },
} as unknown as ProjectRecord

const session = { jwt: "tok", username: "u" } as unknown as FrontierSession

const renderDialog = (cells: CellData[], onClose = vi.fn()) => {
  render(
    <BatchVoiceDialog
      project={project}
      cells={cells}
      session={session}
      username="u"
      nameCell={(c) => c.context ?? ""}
      onClose={onClose}
    />,
  )
  return onClose
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBilling.mockImplementation(async () => null)
  mockRun.mockImplementation(async () => ({
    generated: 2,
    failures: [],
    skipped: [],
    notAttempted: [],
    cancelled: false,
    stoppedAtCap: false,
  }))
})

describe("BatchVoiceDialog", () => {
  it("prices the batch up front: lines, words and credits", async () => {
    renderDialog([cell("a"), cell("b")])
    expect(await screen.findByText(/2 lines · about 6 words · about/i)).toBeTruthy()
  })

  it("names the chosen voice on the confirm button", async () => {
    renderDialog([cell("a"), cell("b")])
    expect(await screen.findByRole("button", { name: /Generate 2 lines in Anna/i })).toBeTruthy()
  })

  it("lets the reader switch to a cloned voice and generates in it", async () => {
    const onClose = renderDialog([cell("a"), cell("b")])
    await userEvent.click(await screen.findByRole("button", { name: /Joel clone/i }))
    await userEvent.click(await screen.findByRole("button", { name: /Generate 2 lines in Joel clone/i }))
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1))
    expect(mockRun.mock.calls[0][0].voiceId).toBe("v-clone")
    // The shared progress banner owns progress from here, so the modal gets
    // out of the way rather than covering the lines filling in behind it.
    expect(onClose).toHaveBeenCalled()
  })

  it("reports an untranslated line in the plan rather than dropping it", async () => {
    renderDialog([cell("a"), cell("b", { translated: "", context: "LUK 1:2" })])
    expect(await screen.findByText(/1 line skipped — not translated yet/i)).toBeTruthy()
    expect(screen.getByText(/LUK 1:2/)).toBeTruthy()
    expect(screen.getByText(/1 line · about 3 words/i)).toBeTruthy()
  })

  it("offers no skip/overwrite choice when no selected line has audio", async () => {
    renderDialog([cell("a")])
    await screen.findByText(/1 line · about 3 words/i)
    expect(screen.queryByText(/already have generated audio/i)).toBeNull()
  })

  it("makes overwriting an existing take an explicit choice", async () => {
    renderDialog([cell("a"), cell("b", { selectedGeneratedVoiceAudioId: "aud1", context: "LUK 1:2" })])
    // Default is to leave it alone, and it says so.
    expect(await screen.findByText(/1 line skipped — it already has generated audio/i)).toBeTruthy()
    expect(screen.getByText(/1 line · about 3 words/i)).toBeTruthy()

    await userEvent.click(screen.getByRole("radio", { name: /Generate them again/i }))
    expect(await screen.findByText(/2 lines · about 6 words/i)).toBeTruthy()
    expect(screen.queryByText(/already has generated audio/i)).toBeNull()
  })

  it("will not fire a run with nothing to do", async () => {
    renderDialog([cell("a", { translated: "" })])
    const button = await screen.findByRole("button", { name: /Generate 0 lines/i })
    expect(button).toHaveProperty("disabled", true)
  })

  it("stops at the word allowance and says which lines it will not reach", async () => {
    mockBilling.mockImplementation(async () => ({
      remainingWords: 4,
      wordsPerCredit: 100,
    } as unknown as Awaited<ReturnType<typeof getOrgBilling>>))
    renderDialog([cell("a"), cell("b", { context: "LUK 1:2" })])
    expect(await screen.findByText(/1 line is past your remaining word allowance/i)).toBeTruthy()
    expect(screen.getByText(/1 line · about 3 words/i)).toBeTruthy()
  })

  it("says plainly when the allowance leaves room for nothing at all", async () => {
    mockBilling.mockImplementation(async () => ({
      remainingWords: 0,
      wordsPerCredit: 100,
    } as unknown as Awaited<ReturnType<typeof getOrgBilling>>))
    renderDialog([cell("a")])
    expect(await screen.findByText(/allowance for this period is used up/i)).toBeTruthy()
    const button = screen.getByRole("button", { name: /Generate 0 lines/i })
    expect(button).toHaveProperty("disabled", true)
  })

  it("treats a 403 on the billing endpoint as unmetered rather than blocking", async () => {
    mockBilling.mockImplementation(async () => null)
    renderDialog([cell("a"), cell("b")])
    expect(await screen.findByText(/2 lines · about 6 words/i)).toBeTruthy()
    expect(screen.queryByText(/word allowance/i)).toBeNull()
  })

  it("passes the active lane through so takes land on that lane", async () => {
    render(
      <BatchVoiceDialog
        project={project}
        cells={[cell("a")]}
        session={session}
        username="u"
        targetLang="swh"
        nameCell={(c) => c.context ?? ""}
        onClose={vi.fn()}
      />,
    )
    await userEvent.click(await screen.findByRole("button", { name: /Generate 1 line in Anna/i }))
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1))
    expect(mockRun.mock.calls[0][0].targetLang).toBe("swh")
  })
})
