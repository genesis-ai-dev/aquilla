import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  claimLegacyClientLocalStorage,
  localStorageKeyForOwner,
  resetClientLocalStorageOwnerForTests,
} from "@/lib/frontier/client-local-storage"
import { migrateLegacyCodexLocalStorageKeys } from "./legacy-codex-keys"

beforeEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

afterEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("AQU-1555 legacy codex localStorage keys", () => {
  it("carries each separator form over to the aquilla namespace, value unchanged", () => {
    localStorage.setItem("codex:onboardingComplete", "true")
    localStorage.setItem("codex.setupInProgress.p1", "1")
    localStorage.setItem("codex-theme", "dark")
    localStorage.setItem("codex:timelineAudibility:f1", JSON.stringify({ source: false, target: true }))

    expect(migrateLegacyCodexLocalStorageKeys()).toBe(4)

    expect(localStorage.getItem("aquilla:onboardingComplete")).toBe("true")
    expect(localStorage.getItem("aquilla.setupInProgress.p1")).toBe("1")
    expect(localStorage.getItem("aquilla-theme")).toBe("dark")
    expect(JSON.parse(localStorage.getItem("aquilla:timelineAudibility:f1")!)).toEqual({
      source: false,
      target: true,
    })
  })

  it("leaves no codex-named key behind after a single load", () => {
    localStorage.setItem("codex:dockRailPosition", "left")
    localStorage.setItem("codex.checklistTooltipShown", "1")

    migrateLegacyCodexLocalStorageKeys()

    const remaining = Object.keys(localStorage).filter((key) => key.startsWith("codex"))
    expect(remaining).toEqual([])
  })

  it("keeps the value already stored under the current name and drops the legacy copy", () => {
    localStorage.setItem("aquilla:translatorProfile", "current")
    localStorage.setItem("codex:translatorProfile", "stale")

    expect(migrateLegacyCodexLocalStorageKeys()).toBe(0)

    expect(localStorage.getItem("aquilla:translatorProfile")).toBe("current")
    expect(localStorage.getItem("codex:translatorProfile")).toBeNull()
  })

  it("is idempotent — a second run writes nothing", () => {
    localStorage.setItem("codex:timelineSnap", "off")
    expect(migrateLegacyCodexLocalStorageKeys()).toBe(1)

    localStorage.setItem("aquilla:timelineSnap", "on")
    expect(migrateLegacyCodexLocalStorageKeys()).toBe(0)
    expect(localStorage.getItem("aquilla:timelineSnap")).toBe("on")
  })

  it("no-ops on a browser with nothing to migrate", () => {
    localStorage.setItem("aquilla:onboardingComplete", "true")
    localStorage.setItem("org:active", "acme")

    expect(migrateLegacyCodexLocalStorageKeys()).toBe(0)

    expect(localStorage.getItem("aquilla:onboardingComplete")).toBe("true")
    expect(localStorage.getItem("org:active")).toBe("acme")
  })

  it("drops a retired key instead of renaming it", () => {
    localStorage.setItem("codex-color-theme", "violet")

    expect(migrateLegacyCodexLocalStorageKeys()).toBe(0)

    expect(localStorage.getItem("codex-color-theme")).toBeNull()
    expect(localStorage.getItem("aquilla-color-theme")).toBeNull()
  })

  it("leaves keys that merely contain or equal 'codex' alone", () => {
    localStorage.setItem("codex", "a file kind, not a namespace")
    localStorage.setItem("aquilla:lastCodexImport", "keep")

    expect(migrateLegacyCodexLocalStorageKeys()).toBe(0)

    expect(localStorage.getItem("codex")).toBe("a file kind, not a namespace")
    expect(localStorage.getItem("aquilla:lastCodexImport")).toBe("keep")
  })

  it("renames early enough for the account-scoping bridge to claim the value", () => {
    localStorage.setItem("codex:userProviderOverride", JSON.stringify({ apiKey: "mine" }))

    migrateLegacyCodexLocalStorageKeys()
    claimLegacyClientLocalStorage("alice")

    const scoped = localStorageKeyForOwner("alice", "aquilla:userProviderOverride")
    expect(JSON.parse(localStorage.getItem(scoped)!)).toEqual({ apiKey: "mine" })
    expect(localStorage.getItem("aquilla:userProviderOverride")).toBeNull()
  })
})
