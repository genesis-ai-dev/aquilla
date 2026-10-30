// AQU-2259: the drafting settings used to live only in each browser. The
// first person who may change project settings to open the project uploads
// their browser's values once, when they differ from the defaults and the
// team has none yet. After that the shared value is the only one read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useProjectSettings } from "./useProjectSettings"
import { resetDraftingSettingsUploadsForTests } from "./useDraftingSettingsUpload"
import * as restClient from "@/lib/sync/project-settings"
import { getProject } from "@/lib/store/project-index"
import type { CompletionSettings, ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "ryder" } }),
}))
vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(),
  patchProject: vi.fn(async (_id: string, fn: (p: unknown) => unknown) => fn({ id: "p1" })),
}))

const TUNED: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  apiKey: "sk-browser-key",
  model: "",
  maxTokens: 16384,
  temperature: 0.3,
  systemPrompt: "",
  top_k: 17,
  contextSize: "large",
  main_chat_language: "",
  fewShotExampleFormat: "source-and-target",
}

function localRecord(completionSettings?: CompletionSettings): ProjectRecord {
  return {
    id: "p1", name: "P", files: [], sourceLanguage: "en", targetLanguage: "fr", createdAt: "",
    ...(completionSettings ? { completionSettings } : {}),
  } as unknown as ProjectRecord
}

function row(settings: restClient.ProjectWideSettings, version = 3): restClient.ProjectSettingsResponse {
  return { version, updatedAt: "x", updatedBy: null, settings }
}

let putSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  resetDraftingSettingsUploadsForTests()
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  putSpy = vi.spyOn(restClient, "patchProjectSettings").mockImplementation(
    async (_jwt, _id, settings, version) => ({ kind: "ok", value: row(settings, version + 1) }),
  )
})
afterEach(() => vi.restoreAllMocks())

describe("the one-time upload of a browser's drafting settings (AQU-2259)", () => {
  it("uploads a maintainer's tuned values when the team has none, without the key", async () => {
    vi.mocked(getProject).mockResolvedValue(localRecord(TUNED))
    vi.spyOn(restClient, "fetchProjectSettingsResult").mockResolvedValue({ ok: true, value: row({ validationCount: 2 }) })
    renderHook(() => useProjectSettings("p1", 600))
    await waitFor(() => expect(putSpy).toHaveBeenCalled())
    const [, , sent, version] = putSpy.mock.calls[0]
    expect(version).toBe(3)
    expect(sent.validationCount).toBe(2)
    expect(sent.draftingSettings).toMatchObject({ top_k: 17, contextSize: "large" })
    expect(JSON.stringify(sent)).not.toContain("sk-browser-key")
  })

  it("leaves it alone for someone who can't change project settings", async () => {
    vi.mocked(getProject).mockResolvedValue(localRecord(TUNED))
    vi.spyOn(restClient, "fetchProjectSettingsResult").mockResolvedValue({ ok: true, value: row({}) })
    const { result } = renderHook(() => useProjectSettings("p1", 500))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(putSpy).not.toHaveBeenCalled()
  })

  it("never replaces drafting settings the team already has (first one wins)", async () => {
    vi.mocked(getProject).mockResolvedValue(localRecord(TUNED))
    vi.spyOn(restClient, "fetchProjectSettingsResult").mockResolvedValue({
      ok: true, value: row({ draftingSettings: { top_k: 4 } }),
    })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(putSpy).not.toHaveBeenCalled()
  })

  it("stops when someone else got there between the read and the write", async () => {
    vi.mocked(getProject).mockResolvedValue(localRecord(TUNED))
    vi.spyOn(restClient, "fetchProjectSettingsResult")
      .mockResolvedValueOnce({ ok: true, value: row({}) })
      .mockResolvedValue({ ok: true, value: row({ draftingSettings: { top_k: 4 } }, 4) })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.settings.draftingSettings).toEqual({ top_k: 4 }))
    expect(putSpy).not.toHaveBeenCalled()
  })

  it("uploads nothing when the browser holds only the defaults", async () => {
    vi.mocked(getProject).mockResolvedValue(localRecord({ ...TUNED, top_k: 10, contextSize: "medium" }))
    vi.spyOn(restClient, "fetchProjectSettingsResult").mockResolvedValue({ ok: true, value: row({}) })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(putSpy).not.toHaveBeenCalled()
  })
})
