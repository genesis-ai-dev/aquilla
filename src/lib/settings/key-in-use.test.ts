// AQU-2263: every place that uses or sets an AI key says which key is in use
// right now. These are the readings, taken from the same rules the requests
// follow (resolveEffectiveCompletionSettings, resolveApiKey), never changed.
import { describe, expect, it } from "vitest"
import { completionKeyInUse, geminiKeyInUse } from "./key-in-use"

const OPENROUTER = "https://openrouter.ai/api/v1"

describe("completionKeyInUse", () => {
  it("a project on the platform provider needs no key", () => {
    expect(completionKeyInUse({ settings: undefined, override: null, personalKey: undefined })).toBe("platform")
    expect(completionKeyInUse({ settings: { provider: "frontier" }, override: null, personalKey: "sk-mine" })).toBe("platform")
  })

  it("a project with its own provider uses this project's key first", () => {
    const settings = { provider: "custom" as const, endpoint: OPENROUTER, apiKey: "sk-project" }
    expect(completionKeyInUse({ settings, override: { endpoint: "http://x", apiKey: "sk-pref" }, personalKey: "sk-mine" })).toBe("project-key")
  })

  it("then your own key saved in this browser", () => {
    const settings = { provider: "custom" as const, endpoint: OPENROUTER, apiKey: "" }
    expect(completionKeyInUse({ settings, override: null, personalKey: "sk-mine" })).toBe("personal-key")
  })

  it("says a key is missing when the provider needs one and none is set", () => {
    const settings = { provider: "custom" as const, endpoint: OPENROUTER }
    expect(completionKeyInUse({ settings, override: null, personalKey: undefined })).toBe("missing")
  })

  it("a local endpoint needs no key", () => {
    const settings = { provider: "custom" as const, endpoint: "http://localhost:11434/v1" }
    expect(completionKeyInUse({ settings, override: null, personalKey: undefined })).toBe("no-key-needed")
  })

  it("a project on the platform provider follows your Preferences override when you have one", () => {
    expect(completionKeyInUse({ settings: { provider: "frontier" }, override: { endpoint: OPENROUTER, apiKey: "sk-pref" }, personalKey: undefined })).toBe("preferences")
    expect(completionKeyInUse({ settings: undefined, override: { endpoint: "http://localhost:8000" }, personalKey: undefined })).toBe("preferences-no-key")
    expect(completionKeyInUse({ settings: undefined, override: { endpoint: OPENROUTER }, personalKey: "sk-mine" })).toBe("personal-key")
    expect(completionKeyInUse({ settings: undefined, override: { endpoint: OPENROUTER }, personalKey: undefined })).toBe("missing")
  })
})

describe("geminiKeyInUse", () => {
  it("this project's key, then your own", () => {
    expect(geminiKeyInUse({ projectKey: "AIza-p", personalKey: "AIza-me", orgHasKey: true })).toBe("project-key")
    expect(geminiKeyInUse({ projectKey: " ", personalKey: "AIza-me", orgHasKey: true })).toBe("personal-key")
  })

  it("an organization key alone is not used: voices never receive it", () => {
    expect(geminiKeyInUse({ projectKey: "", personalKey: undefined, orgHasKey: true })).toBe("org-unused")
  })

  it("nothing at all", () => {
    expect(geminiKeyInUse({ projectKey: undefined, personalKey: undefined, orgHasKey: false })).toBe("missing")
  })
})
