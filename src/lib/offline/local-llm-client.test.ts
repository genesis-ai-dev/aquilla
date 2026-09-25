import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let tauriRuntime = false
vi.mock("./is-tauri", () => ({
  isTauriRuntime: () => tauriRuntime,
}))

let onlineValue: boolean | null = null
vi.mock("./connectivity", () => ({
  isOnline: async () => onlineValue,
}))

let storedSettings = { endpoint: "http://localhost:11434", model: "llama3" }
vi.mock("./llm-settings", () => ({
  getLocalLlmSettings: () => storedSettings,
}))

import {
  LOCAL_LLM_MODELS_URL,
  LOCAL_LLM_PROXY_URL,
  completeWithLocalLlm,
  listLocalLlmModels,
  shouldUseLocalLlm,
  testLocalLlmConnection,
} from "./local-llm-client"

const settings = { endpoint: "http://localhost:11434", model: "llama3" }

describe("shouldUseLocalLlm", () => {
  beforeEach(() => {
    tauriRuntime = false
    onlineValue = null
  })

  it("is false outside Tauri regardless of connectivity", async () => {
    onlineValue = false
    expect(await shouldUseLocalLlm()).toBe(false)
  })

  it("is false inside Tauri while online", async () => {
    tauriRuntime = true
    onlineValue = true
    expect(await shouldUseLocalLlm()).toBe(false)
  })

  it("is false inside Tauri when connectivity is unknown (null)", async () => {
    tauriRuntime = true
    onlineValue = null
    expect(await shouldUseLocalLlm()).toBe(false)
  })

  it("is true inside Tauri while offline", async () => {
    tauriRuntime = true
    onlineValue = false
    expect(await shouldUseLocalLlm()).toBe(true)
  })
})

describe("completeWithLocalLlm", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    storedSettings = settings
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("posts the OpenAI-shaped chat request with the endpoint as a query param, and parses message.content", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${LOCAL_LLM_PROXY_URL}?endpoint=${encodeURIComponent(settings.endpoint)}`)
      const body = JSON.parse(init.body as string)
      expect(body).toEqual({
        model: "llama3",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      })
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello there" } }] }),
        { status: 200 },
      )
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await completeWithLocalLlm([{ role: "user", content: "hi" }])
    expect(result).toBe("hello there")
  })

  it("throws with status and body text on a non-ok response", async () => {
    global.fetch = vi.fn(async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch
    await expect(completeWithLocalLlm([{ role: "user", content: "hi" }])).rejects.toThrow(/404/)
  })
})

describe("testLocalLlmConnection", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("reports ok with the reply on success", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 }),
    ) as unknown as typeof fetch
    const result = await testLocalLlmConnection(settings)
    expect(result.ok).toBe(true)
    expect(result.message).toContain("pong")
  })

  it("reports failure with the error message on a network error", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const result = await testLocalLlmConnection(settings)
    expect(result.ok).toBe(false)
    expect(result.message).toBe("ECONNREFUSED")
  })

  it("tests the endpoint passed in, not whatever is separately persisted", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain(encodeURIComponent("http://localhost:9999"))
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await testLocalLlmConnection({ endpoint: "http://localhost:9999", model: "llama3" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("listLocalLlmModels", () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  it("fetches /llm/models with the endpoint as a query param and returns model ids", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${LOCAL_LLM_MODELS_URL}?endpoint=${encodeURIComponent("http://localhost:1234")}`)
      return new Response(
        JSON.stringify({ data: [{ id: "qwen/qwen2.5-coder-14b", object: "model" }] }),
        { status: 200 },
      )
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const models = await listLocalLlmModels("http://localhost:1234")
    expect(models).toEqual(["qwen/qwen2.5-coder-14b"])
  })

  it("filters out malformed entries missing a string id", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "good" }, {}, { id: 42 }, { id: "" }] }), { status: 200 }),
    ) as unknown as typeof fetch

    expect(await listLocalLlmModels("http://localhost:1234")).toEqual(["good"])
  })

  it("returns an empty list when the response has no data array", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    expect(await listLocalLlmModels("http://localhost:1234")).toEqual([])
  })

  it("throws with status and body text on a non-ok response", async () => {
    global.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
    await expect(listLocalLlmModels("http://localhost:1234")).rejects.toThrow(/404/)
  })
})
