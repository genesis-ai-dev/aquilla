import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  claimLegacyClientLocalStorage,
  ownerScopedLocalStorageKey,
  resetClientLocalStorageOwnerForTests,
  setClientLocalStorageOwner,
  subscribeClientLocalStorageOwner,
} from "./client-local-storage"

beforeEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

afterEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("account-scoped localStorage", () => {
  it("isolates account and local-only namespaces and notifies on owner changes", () => {
    const changed = vi.fn()
    const unsubscribe = subscribeClientLocalStorageOwner(changed)

    expect(ownerScopedLocalStorageKey("secret")).toBe("secret")
    setClientLocalStorageOwner("alice@example.com")
    expect(ownerScopedLocalStorageKey("secret")).toBe(
      "owner:account:alice%40example.com:secret",
    )
    setClientLocalStorageOwner("bob")
    expect(ownerScopedLocalStorageKey("secret")).toBe("owner:account:bob:secret")
    setClientLocalStorageOwner(null)
    expect(ownerScopedLocalStorageKey("secret")).toBe("owner:local:secret")
    expect(changed).toHaveBeenCalledTimes(3)

    unsubscribe()
  })

  it("does not let a failing UI subscriber interrupt an owner switch", () => {
    subscribeClientLocalStorageOwner(() => { throw new Error("render listener failed") })
    expect(() => setClientLocalStorageOwner("alice")).not.toThrow()
    expect(ownerScopedLocalStorageKey("secret")).toBe("owner:account:alice:secret")
  })

  it("moves sensitive legacy values to only the first resolved owner", () => {
    localStorage.setItem("frontier:user-api-key:completion", "legacy-key")
    localStorage.setItem("frontier:project-tts:p", "legacy-tts")
    localStorage.setItem("aquilla:translatorProfile", "legacy-profile")
    localStorage.setItem("aquilla:userProviderOverride", "legacy-provider")
    localStorage.setItem("comment-draft:p:c:t", "legacy-draft")
    localStorage.setItem("bt:p:c", "legacy-reading")
    localStorage.setItem("unrelated-preference", "keep")
    localStorage.setItem("owner:account:alice:aquilla:translatorProfile", "newer-profile")

    claimLegacyClientLocalStorage("alice")

    expect(localStorage.getItem("owner:account:alice:frontier:user-api-key:completion"))
      .toBe("legacy-key")
    expect(localStorage.getItem("owner:account:alice:frontier:project-tts:p"))
      .toBe("legacy-tts")
    expect(localStorage.getItem("owner:account:alice:aquilla:translatorProfile"))
      .toBe("newer-profile")
    expect(localStorage.getItem("owner:account:alice:aquilla:userProviderOverride"))
      .toBe("legacy-provider")
    expect(localStorage.getItem("owner:account:alice:comment-draft:p:c:t"))
      .toBe("legacy-draft")
    expect(localStorage.getItem("owner:account:alice:bt:p:c")).toBe("legacy-reading")
    expect(localStorage.getItem("unrelated-preference")).toBe("keep")
    expect(localStorage.getItem("frontier:user-api-key:completion")).toBeNull()
    expect(localStorage.getItem("frontier:project-tts:p")).toBeNull()
    expect(localStorage.getItem("aquilla:translatorProfile")).toBeNull()
    expect(localStorage.getItem("aquilla:userProviderOverride")).toBeNull()
    expect(localStorage.getItem("comment-draft:p:c:t")).toBeNull()
    expect(localStorage.getItem("bt:p:c")).toBeNull()
  })
})
