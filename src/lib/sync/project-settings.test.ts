import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchProjectSettings,
  patchProjectSettings,
  PROJECT_SETTINGS_VERSION_INITIAL,
} from "./project-settings"

const API = "https://api.example.com"

afterEach(() => vi.restoreAllMocks())

describe("fetchProjectSettings", () => {
  it("returns parsed settings on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        version: 4,
        updatedAt: "2026-04-29T10:00:00Z",
        updatedBy: { id: 7, username: "ryder" },
        settings: { sourceLanguage: "en" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ))
    const got = await fetchProjectSettings("jwt", "p1", API)
    expect(got).toEqual({
      version: 4,
      updatedAt: "2026-04-29T10:00:00Z",
      updatedBy: { id: 7, username: "ryder" },
      settings: { sourceLanguage: "en" },
    })
  })

  it("returns null on 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }))
    expect(await fetchProjectSettings("jwt", "p1", API)).toBeNull()
  })

  it("returns null on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    expect(await fetchProjectSettings("jwt", "p1", API)).toBeNull()
  })
})

describe("patchProjectSettings", () => {
  it("returns the new state on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        version: 5,
        updatedAt: "2026-04-29T10:01:00Z",
        updatedBy: { id: 7, username: "ryder" },
        settings: { sourceLanguage: "en", systemPrompt: "x" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ))
    const got = await patchProjectSettings("jwt", "p1", { systemPrompt: "x" }, 4, API)
    expect(got.kind).toBe("ok")
    if (got.kind === "ok") expect(got.value.version).toBe(5)
  })

  it("returns conflict + latest on 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        error: "version mismatch",
        latest: {
          version: 7,
          updatedAt: "2026-04-29T10:02:00Z",
          updatedBy: { id: 12, username: "alex" },
          settings: { sourceLanguage: "fr" },
        },
      }),
      { status: 409, headers: { "content-type": "application/json" } }
    ))
    const got = await patchProjectSettings("jwt", "p1", { sourceLanguage: "en" }, 4, API)
    expect(got.kind).toBe("conflict")
    if (got.kind === "conflict") {
      expect(got.latest.version).toBe(7)
      expect(got.latest.updatedBy?.username).toBe("alex")
    }
  })

  it("returns forbidden + required level on 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: "forbidden", required: 500, role: 400 }),
      { status: 403, headers: { "content-type": "application/json" } }
    ))
    const got = await patchProjectSettings("jwt", "p1", { sourceLanguage: "en" }, 0, API)
    expect(got.kind).toBe("forbidden")
    if (got.kind === "forbidden") {
      expect(got.required).toBe(500)
      expect(got.role).toBe(400)
    }
  })
})

it("PROJECT_SETTINGS_VERSION_INITIAL is 0", () => {
  expect(PROJECT_SETTINGS_VERSION_INITIAL).toBe(0)
})
