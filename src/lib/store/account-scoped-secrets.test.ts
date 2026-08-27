import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  resetClientLocalStorageOwnerForTests,
  setClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"
import { loadProjectTts, saveProjectTts } from "./project-tts-store"
import {
  getUserProviderOverride,
  setUserProviderOverride,
} from "./user-provider-override"

beforeEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

afterEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("account-scoped credential stores", () => {
  it("isolates personal provider bearer tokens", () => {
    setClientLocalStorageOwner("alice")
    setUserProviderOverride({ endpoint: "https://alice.example/v1", apiKey: "alice-token" })

    setClientLocalStorageOwner("bob")
    expect(getUserProviderOverride()).toBeNull()
    setUserProviderOverride({ endpoint: "https://bob.example/v1", apiKey: "bob-token" })

    setClientLocalStorageOwner("alice")
    expect(getUserProviderOverride()?.apiKey).toBe("alice-token")
  })

  it("isolates project TTS keys even when both accounts can open the project", () => {
    setClientLocalStorageOwner("alice")
    saveProjectTts("shared-project", { provider: "gemini", apiKey: "alice-gemini-key" })

    setClientLocalStorageOwner("bob")
    expect(loadProjectTts("shared-project")).toBeUndefined()
    saveProjectTts("shared-project", { provider: "gemini", apiKey: "bob-gemini-key" })

    setClientLocalStorageOwner("alice")
    expect(loadProjectTts("shared-project")?.apiKey).toBe("alice-gemini-key")
  })
})
