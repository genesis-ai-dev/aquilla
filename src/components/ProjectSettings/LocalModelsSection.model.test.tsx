// The hosted model choice: Automatic by default, zero-shot only by opt-in and
// only where the org allows it, and choosing it starts the slow model early.

import { beforeEach, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { getTranscriptionModel, setTranscriptionModel } from "@/lib/audio/transcription-model"
import { LocalModelsSection } from "./LocalModelsSection"

const org = vi.hoisted(() => ({ settings: {} as { transcription?: { zeroShotEnabled?: boolean } } }))
const warm = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { username: "alice", jwt: "jwt" } }),
}))
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => ({ settings: org.settings }) }))
vi.mock("@/context/OrgContext", () => ({ useActiveOrgOptional: () => ({ activeOrgId: 1, activeOrg: null }) }))
vi.mock("@/lib/audio/omni-warmup", () => ({ warmZeroShot: warm }))
vi.mock("@/lib/audio/prefetch", () => ({
  hydratePrefetchStatus: vi.fn(async () => undefined),
  prefetchAiModels: vi.fn(),
  clearPrefetchStatus: vi.fn(),
  useModelStatus: () => ({ kind: "idle" }),
}))
beforeEach(() => {
  localStorage.clear()
  warm.mockClear()
  org.settings = {}
})
const content = () => <I18nProvider><LocalModelsSection /></I18nProvider>

it("defaults to Automatic, and choosing zero-shot stores it and warms the model", async () => {
  const user = userEvent.setup()
  render(content())
  expect(screen.getByRole("radio", { name: /^Automatic/ })).toBeChecked()
  await user.click(screen.getByRole("radio", { name: /Omnilingual Zero-Shot/ }))
  expect(getTranscriptionModel("alice")).toBe("zs")
  expect(getTranscriptionModel("bob")).toBe("auto")
  expect(warm).toHaveBeenCalledWith("jwt")
})

it("hides zero-shot when the org has turned it off, even for an account that chose it", () => {
  org.settings = { transcription: { zeroShotEnabled: false } }
  setTranscriptionModel("alice", "zs")
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
