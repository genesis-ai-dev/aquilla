import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createProjectServerSide,
  setProjectLanguagePair,
  updateProjectSettings,
} from "../e2e/helpers/frontier-api"

describe("E2E frontier API fixture writes", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("replays project creation after a transient worker-restart response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        "Your worker restarted mid-request. Please try sending the request again.",
        { status: 503 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "project-1",
        name: "Stable fixture",
        orgId: 1,
        role: { level: 700, name: "owner" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(createProjectServerSide("jwt", {
      id: "project-1",
      name: "Stable fixture",
    })).resolves.toMatchObject({ id: "project-1" })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body)
  })

  it("omits stored retired lane keys from a settings PUT", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        settings: {
          sourceLanguage: "en",
          targetLanguage: "sw",
          targetLanes: ["sw"],
          archivedLanes: ["old"],
          rules: [],
        },
        version: 3,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: {}, version: 4 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    vi.stubGlobal("fetch", fetchMock)

    await updateProjectSettings("jwt", "project-1", {
      translationBrief: { parameters: { purpose: "Seeded fixture project" } },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const put = fetchMock.mock.calls[1][1] as { method?: string; body?: string }
    expect(put.method).toBe("PUT")
    const body = JSON.parse(put.body ?? "{}") as {
      settings: Record<string, unknown>
      ifMatchVersion: number
    }
    expect(body.ifMatchVersion).toBe(3)
    expect(body.settings).toEqual({
      rules: [],
      translationBrief: { parameters: { purpose: "Seeded fixture project" } },
    })
    for (const key of ["sourceLanguage", "targetLanguage", "targetLanes", "archivedLanes"]) {
      expect(body.settings).not.toHaveProperty(key)
    }
  })

  it("refuses a caller-supplied retired lane key instead of dropping it", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(updateProjectSettings("jwt", "project-1", {
      sourceLanguage: "en",
      translationBrief: { parameters: { purpose: "nope" } },
    })).rejects.toThrow(/POST \/api\/v2\/projects\/:projectId\/lanes/)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sets the seed language pair on lane rows and puts only the brief", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        lanes: [{
          id: "source-lane",
          role: "source",
          name: null,
          language: "",
          langCode: null,
          legacyTag: null,
          archivedAt: null,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        lane: { id: "source-lane", role: "source", language: "English", legacyTag: null },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        lane: {
          id: "target-lane",
          role: "target",
          language: "Swahili",
          legacyTag: "Swahili",
        },
      }), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        settings: { sourceLanguage: "en", targetLanguage: "sw", targetLanes: ["sw"], archivedLanes: [] },
        version: 1,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: {}, version: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    vi.stubGlobal("fetch", fetchMock)

    await setProjectLanguagePair("jwt", "project-1", {
      sourceLanguage: "English",
      sourceCode: "en",
      targetLanguage: "Swahili",
      targetCode: "sw",
      translationBrief: { parameters: { purpose: "Seeded fixture project" } },
    })

    const calls = fetchMock.mock.calls.map((call) => ({
      url: String(call[0]),
      method: (call[1] as { method?: string }).method ?? "GET",
      body: (call[1] as { body?: string }).body,
    }))
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/v2/projects/project-1/settings",
      "PATCH /api/v2/projects/project-1/lanes/source-lane",
      "POST /api/v2/projects/project-1/lanes",
      "GET /api/v2/projects/project-1/settings",
      "PUT /api/v2/projects/project-1/settings",
    ])
    expect(JSON.parse(calls[1].body ?? "{}")).toEqual({ language: "English", code: "en" })
    expect(JSON.parse(calls[2].body ?? "{}")).toEqual({ name: "", language: "Swahili", code: "sw" })
    const put = JSON.parse(calls[4].body ?? "{}") as { settings: Record<string, unknown> }
    expect(put.settings).toEqual({
      translationBrief: { parameters: { purpose: "Seeded fixture project" } },
    })
  })

  it("leaves a source lane that already has a language and does not add another", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        lanes: [{
          id: "source-lane",
          role: "source",
          name: null,
          language: "English",
          langCode: "en",
          legacyTag: null,
          archivedAt: null,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        lane: { id: "target-lane", role: "target", language: "French", legacyTag: "French" },
      }), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: {}, version: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: {}, version: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    vi.stubGlobal("fetch", fetchMock)

    await setProjectLanguagePair("jwt", "project-1", {
      sourceLanguage: "English",
      sourceCode: "en",
      targetLanguage: "French",
      targetCode: "fr",
      translationBrief: { parameters: { purpose: "Sibling fixture project" } },
    })

    const methods = fetchMock.mock.calls.map((call) => {
      const url = String(call[0])
      const method = (call[1] as { method?: string }).method ?? "GET"
      return `${method} ${new URL(url).pathname}`
    })
    expect(methods).toEqual([
      "GET /api/v2/projects/project-1/settings",
      "POST /api/v2/projects/project-1/lanes",
      "GET /api/v2/projects/project-1/settings",
      "PUT /api/v2/projects/project-1/settings",
    ])
  })
})
