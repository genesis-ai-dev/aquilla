import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./is-tauri", () => ({ isTauriRuntime: () => true }))

let mod: typeof import("./launch-resume")
beforeEach(async () => {
  vi.resetModules()
  mod = await import("./launch-resume")
})

describe("launch-resume", () => {
  it("is pending until the launch decides, then not", async () => {
    const pending = mod.pendingOfflineLaunchResume()
    expect(pending).not.toBeNull()
    mod.settleOfflineLaunchResume(true)
    await expect(pending).resolves.toBe(true)
    expect(mod.pendingOfflineLaunchResume()).toBeNull()
  })

  it("keeps the first decision", async () => {
    mod.settleOfflineLaunchResume(false)
    mod.settleOfflineLaunchResume(true)
    await expect(mod.whenOfflineLaunchResumeSettled()).resolves.toBe(false)
  })
})
