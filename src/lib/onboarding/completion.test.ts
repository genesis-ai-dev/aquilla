import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  LOCAL_ONBOARDING_COMPLETE_KEY,
  ONBOARDING_COMPLETE_KEY,
  PRODUCT_TOUR_ELIGIBLE_KEY,
  isAccountOnboardingComplete,
  isLocalOnboardingComplete,
  markLocalOnboardingComplete,
  migrateLegacyOnboardingCompletion,
} from "./completion"
import { clearAllLocalData, createProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

function localProject(): ProjectRecord {
  return {
    id: "local-project",
    name: "Local project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
  }
}

beforeEach(async () => {
  localStorage.clear()
  await clearAllLocalData()
})

describe("onboarding completion scoping", () => {
  it("writes new local-only completion to an unambiguous key", () => {
    markLocalOnboardingComplete()

    expect(isLocalOnboardingComplete()).toBe(true)
    expect(localStorage.getItem(LOCAL_ONBOARDING_COMPLETE_KEY)).toBe("true")
    expect(localStorage.getItem(ONBOARDING_COMPLETE_KEY)).toBeNull()
  })

  it("migrates a legacy marker to the hydrated account", async () => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true")

    await expect(migrateLegacyOnboardingCompletion("alice")).resolves.toBe(false)

    expect(isAccountOnboardingComplete("alice")).toBe(true)
    expect(isLocalOnboardingComplete()).toBe(false)
    expect(localStorage.getItem(ONBOARDING_COMPLETE_KEY)).toBeNull()
    expect(localStorage.getItem(PRODUCT_TOUR_ELIGIBLE_KEY)).toBe("true")
  })

  it("preserves signed-out legacy local mode when a local project proves it", async () => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true")
    await createProject(localProject())

    await expect(migrateLegacyOnboardingCompletion(null)).resolves.toBe(true)

    expect(isLocalOnboardingComplete()).toBe(true)
    expect(localStorage.getItem(ONBOARDING_COMPLETE_KEY)).toBeNull()
  })

  it("retires an ambiguous signed-out marker when there is no local data", async () => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true")

    await expect(migrateLegacyOnboardingCompletion(null)).resolves.toBe(false)

    expect(isLocalOnboardingComplete()).toBe(false)
    expect(localStorage.getItem(ONBOARDING_COMPLETE_KEY)).toBeNull()
  })

  it("times out a blocked legacy lookup without retiring its marker", async () => {
    vi.useFakeTimers()
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true")
    try {
      const migration = migrateLegacyOnboardingCompletion(null, {
        listProjectsFn: () => new Promise(() => {}),
        timeoutMs: 50,
      })
      const rejection = expect(migration).rejects.toThrow(/did not respond/i)
      await vi.advanceTimersByTimeAsync(50)
      await rejection
      expect(localStorage.getItem(ONBOARDING_COMPLETE_KEY)).toBe("true")
    } finally {
      vi.useRealTimers()
    }
  })
})
