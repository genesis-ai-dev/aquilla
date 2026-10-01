import { beforeEach, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { getTranscriptionProvider } from "@/lib/audio/transcription-preference"
import { requestAiModelConsent, WHISPER_MODEL } from "@/lib/audio/ai-consent"
import { LocalModelsSection } from "./LocalModelsSection"

const prefetch = vi.fn(async (..._args: unknown[]) => undefined)
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { username: "alice" } }),
}))
vi.mock("@/lib/audio/prefetch", () => ({
  hydratePrefetchStatus: vi.fn(async () => undefined),
  prefetchAiModels: (...args: unknown[]) => prefetch(...args),
  clearPrefetchStatus: vi.fn(),
  useModelStatus: () => ({ kind: "idle" }),
}))
beforeEach(() => { localStorage.clear(); prefetch.mockClear() })
const content = () => <I18nProvider><LocalModelsSection /></I18nProvider>
it("defaults to hosted transcription without downloading a model", () => {
  render(content())
  expect(screen.getByRole("radio", { name: /Aquilla hosted Whisper/ })).toBeChecked()
  expect(screen.getByRole("radio", { name: /Local Whisper in this browser/ }))
    .not.toBeChecked()
  expect(prefetch).not.toHaveBeenCalled()
})
it("persists the local choice for this account and lets the user load Whisper", async () => {
  const user = userEvent.setup()
  const view = render(content())
  await user.click(screen.getByRole("radio", { name: /Local Whisper in this browser/ }))
  expect(getTranscriptionProvider("alice")).toBe("local")
  expect(getTranscriptionProvider("bob")).toBe("hosted")
  expect(prefetch).not.toHaveBeenCalled()
  await user.click(screen.getAllByRole("button", { name: "Download" })[0])
  expect(prefetch).toHaveBeenCalledWith({ models: ["whisper"] })
  await expect(requestAiModelConsent(WHISPER_MODEL)).resolves.toBe(true)
  view.unmount()
  render(content())
  expect(screen.getByRole("radio", { name: /Local Whisper in this browser/ }))
    .toBeChecked()
  await user.click(screen.getByRole("radio", { name: /Aquilla hosted Whisper/ }))
  expect(getTranscriptionProvider("alice")).toBe("hosted")
})
it("describes Whisper with the shared consent copy", () => {
  render(content())
  expect(screen.getByText(/after you save a recording/i)).toBeInTheDocument()
  expect(screen.queryByText(/karaoke/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/word-level timing/i)).not.toBeInTheDocument()
})
