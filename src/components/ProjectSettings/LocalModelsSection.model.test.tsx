// The hosted model picker: Automatic by default, each named model saying
// whether it knows the project's language, zero-shot only by opt-in and only
// where the org allows it, and choosing zero-shot starts the slow model early.

import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { getTranscriptionModel, setTranscriptionModel } from "@/lib/audio/transcription-model"
import { WHISPER_TWO_LETTER } from "@/lib/audio/language"
import { LocalModelsSection } from "./LocalModelsSection"

const org = vi.hoisted(() => ({ settings: {} as { transcription?: { zeroShotEnabled?: boolean } } }))
const warm = vi.hoisted(() => vi.fn(async () => undefined))
const examples = vi.hoisted(() => vi.fn(async () => [{}, {}, {}]))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { username: "alice", jwt: "jwt" } }),
}))
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => ({ settings: org.settings }) }))
vi.mock("@/context/OrgContext", () => ({ useActiveOrgOptional: () => ({ activeOrgId: 1, activeOrg: null }) }))
vi.mock("@/hooks/useProject", () => ({
  useProject: (id: string) => ({
    project: id ? { id, targetLanguage: "tpi", files: [{ id: "f1" }] } : null,
  }),
}))
vi.mock("@/lib/audio/omni-warmup", () => ({ warmZeroShot: warm }))
vi.mock("@/lib/audio/transcription-examples", () => ({ fetchTranscriptionExamples: examples }))
vi.mock("@/lib/audio/prefetch", () => ({
  hydratePrefetchStatus: vi.fn(async () => undefined),
  prefetchAiModels: vi.fn(),
  clearPrefetchStatus: vi.fn(),
  useModelStatus: () => ({ kind: "idle" }),
}))
beforeEach(() => {
  localStorage.clear()
  warm.mockClear()
  examples.mockClear()
  org.settings = {}
})
afterEach(() => window.history.replaceState(null, "", "/"))
const content = () => <I18nProvider><LocalModelsSection /></I18nProvider>
const row = (name: RegExp) => screen.getByRole("radio", { name }).closest("div") as HTMLElement

it("offers all five models, defaults to Automatic, and warms zero-shot when chosen", async () => {
  window.history.replaceState(null, "", "/preferences/local-models?project=p1")
  const user = userEvent.setup()
  render(content())
  for (const name of [/^Automatic/, /^Whisper/, /^Qwen3-ASR/, /^Omnilingual Meta/, /^Omnilingual Zero-Shot/]) {
    expect(screen.getByRole("radio", { name })).toBeInTheDocument()
  }
  expect(screen.getByRole("radio", { name: /^Automatic/ })).toBeChecked()
  await user.click(screen.getByRole("radio", { name: /Omnilingual Zero-Shot/ }))
  expect(getTranscriptionModel("alice")).toBe("omni-zs")
  expect(getTranscriptionModel("bob")).toBe("auto")
  expect(warm).toHaveBeenCalledWith("jwt", "p1")
})

it("says which models know the project's language, and how many examples zero-shot has", async () => {
  window.history.replaceState(null, "", "/preferences/local-models?project=p1")
  render(content())
  expect(within(row(/^Whisper/)).getByText(/Does not support Tok Pisin/)).toBeInTheDocument()
  expect(within(row(/^Qwen3-ASR/)).getByText(/Does not support Tok Pisin/)).toBeInTheDocument()
  expect(await within(row(/^Omnilingual Meta/)).findByText(/^Supports Tok Pisin/)).toBeInTheDocument()
  expect(await screen.findByText("3 usable examples in this project")).toBeInTheDocument()
  expect(examples).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", fileId: "f1", limit: 10 }))
})

it("lists and searches each model's languages", async () => {
  const user = userEvent.setup()
  render(content())
  const whisper = row(/^Whisper/)
  await user.click(within(whisper).getByText(`See all ${WHISPER_TWO_LETTER.size} languages`))
  await user.type(within(whisper).getByRole("textbox", { name: "Search languages" }), "swa")
  expect(within(whisper).getByText("Swahili")).toBeInTheDocument()
  expect(within(whisper).queryByText("French")).not.toBeInTheDocument()
})

it("hides zero-shot when the org has turned it off, even for an account that chose it", () => {
  org.settings = { transcription: { zeroShotEnabled: false } }
  setTranscriptionModel("alice", "omni-zs")
  render(content())
  expect(screen.queryByRole("radio", { name: /Omnilingual Zero-Shot/ })).not.toBeInTheDocument()
  expect(screen.getByRole("radio", { name: /^Automatic/ })).toBeChecked()
})

it("shows no model choice for local Whisper", async () => {
  const user = userEvent.setup()
  render(content())
  await user.click(screen.getByRole("radio", { name: /Local Whisper in this browser/ }))
  expect(screen.queryByRole("radio", { name: /^Automatic/ })).not.toBeInTheDocument()
})
