// AQU-2262: each setting saves the moment it changes. The shared patch keeps
// its version check, and learns two things a one-setting write needs:
// - the value the person saw, so a change made over someone else's newer
//   change to the SAME setting is refused and theirs is kept;
// - a field of an object setting (the drafting settings), merged into the
//   object as the server has it, so another person's change to a different
//   field of it is not wiped.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useProjectSettings, type PatchOutcome } from "./useProjectSettings"
import * as restClient from "@/lib/sync/project-settings"

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "ryder" } }),
}))
vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => ({
    id: "p1", name: "P", sourceLanguage: "en", targetLanguage: "swh",
    files: [], members: [], createdAt: "",
    syncRole: { level: 700, name: "owner", source: "creator", fetchedAt: "" },
  })),
  patchProject: vi.fn(async (id: string, fn: (p: Record<string, unknown>) => unknown) => fn({ id })),
}))

/** The server's row: what the page first read, then what a GET finds later. */
function serverRow(first: restClient.ProjectSettingsResponse) {
  let row = first
  vi.spyOn(restClient, "fetchProjectSettingsResult").mockImplementation(async () => ({ ok: true, value: row }))
  return { set: (next: restClient.ProjectSettingsResponse) => { row = next } }
}

beforeEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
})
afterEach(() => vi.restoreAllMocks())

describe("a one-setting write", () => {
  it("is refused when someone else changed that setting since the page read it, and their value is kept", async () => {
    const row = serverRow({ version: 1, updatedAt: "x", updatedBy: { id: 1, username: "ryder" }, settings: { validationRoleFloor: "reviewer" } })
    const write = vi.spyOn(restClient, "patchProjectSettings")
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.version).toBe(1))
    row.set({ version: 2, updatedAt: "y", updatedBy: { id: 9, username: "alex" }, settings: { validationRoleFloor: "maintainer" } })
    let out!: PatchOutcome
    await act(async () => {
      out = await result.current.patch(
        { validationRoleFloor: "project_lead" },
        { expect: [{ key: "validationRoleFloor", value: "reviewer" }] },
      )
    })
    expect(out.kind).toBe("conflict")
    if (out.kind === "conflict") expect(restClient.settingsEditorName(out.latest.updatedBy)).toBe("alex")
    expect(write).not.toHaveBeenCalled()
    expect((result.current.settings as Record<string, unknown>).validationRoleFloor).toBe("maintainer")
  })

  it("goes ahead over someone else's change to a different setting", async () => {
    const row = serverRow({ version: 1, updatedAt: "x", updatedBy: null, settings: { validationRoleFloor: "reviewer", smartQuotes: false } })
    const write = vi.spyOn(restClient, "patchProjectSettings").mockImplementation(async (_j, _p, settings, v) => ({
      kind: "ok",
      value: { version: v + 1, updatedAt: "z", updatedBy: { id: 1, username: "ryder" }, settings },
    }))
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.version).toBe(1))
    row.set({ version: 2, updatedAt: "y", updatedBy: { id: 9, username: "alex" }, settings: { validationRoleFloor: "maintainer", smartQuotes: false } })
    let out!: PatchOutcome
    await act(async () => {
      out = await result.current.patch({ smartQuotes: true }, { expect: [{ key: "smartQuotes", value: false }] })
    })
    expect(out.kind).toBe("ok")
    expect(write).toHaveBeenCalledWith("test-jwt", "p1", { validationRoleFloor: "maintainer", smartQuotes: true }, 2)
  })

  it("merges one field of the drafting settings into the server's copy instead of replacing it", async () => {
    const row = serverRow({ version: 1, updatedAt: "x", updatedBy: null, settings: { draftingSettings: { temperature: 0.3 } } })
    const write = vi.spyOn(restClient, "patchProjectSettings").mockImplementation(async (_j, _p, settings, v) => ({
      kind: "ok",
      value: { version: v + 1, updatedAt: "z", updatedBy: { id: 1, username: "ryder" }, settings },
    }))
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.version).toBe(1))
    // Someone set the model meanwhile.
    row.set({ version: 2, updatedAt: "y", updatedBy: { id: 9, username: "alex" }, settings: { draftingSettings: { temperature: 0.3, model: "gpt-4o" } } })
    await act(async () => {
      await result.current.patch(
        { draftingSettings: { temperature: 0.5 } },
        { mergeKeys: ["draftingSettings"], expect: [{ key: "draftingSettings", field: "temperature", value: 0.3 }] },
      )
    })
    expect(write).toHaveBeenCalledWith("test-jwt", "p1", { draftingSettings: { temperature: 0.5, model: "gpt-4o" } }, 2)
    expect(result.current.settings.draftingSettings).toEqual({ temperature: 0.5, model: "gpt-4o" })
  })
})
