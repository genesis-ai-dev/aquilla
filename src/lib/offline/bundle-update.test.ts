import { afterEach, describe, expect, it, vi } from "vitest"

// The browser SPA imports these wrappers too (DesktopUpdatePrompt mounts in
// every build), so outside Tauri they must resolve without ever touching
// @tauri-apps/api — there is no IPC bridge, and the dynamic import would drag
// Tauri into the browser bundle.
const invoke = vi.fn()
const listen = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen }))
const getVersion = vi.fn()
vi.mock("@tauri-apps/api/app", () => ({ getVersion }))

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

async function load() {
  return import("./bundle-update")
}

describe("bundle-update outside Tauri", () => {
  it("every wrapper is a no-op that never invokes the IPC bridge", async () => {
    const mod = await load()
    await expect(mod.checkBundleUpdate()).resolves.toBeNull()
    await expect(mod.getBundleStatus()).resolves.toBeNull()
    await expect(mod.getDesktopVersions()).resolves.toBeNull()
    await expect(mod.bundleBooted()).resolves.toBeUndefined()
    await expect(mod.restartApp()).resolves.toBeUndefined()
    const onEvent = vi.fn()
    const unsubscribe = mod.subscribeBundleEvent("bundle://staged", onEvent)
    expect(typeof unsubscribe).toBe("function")
    unsubscribe()
    // Give any stray dynamic import a tick to land.
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
    expect(getVersion).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
  })
})

describe("bundle-update inside Tauri", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI__
  })

  it("forwards the commands and treats an undefined staged result as null", async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI__ = {}
    invoke.mockResolvedValueOnce(undefined)
    const mod = await load()
    await expect(mod.checkBundleUpdate()).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledWith("check_bundle_update")
    await mod.bundleBooted()
    expect(invoke).toHaveBeenCalledWith("bundle_booted")
    await mod.restartApp()
    expect(invoke).toHaveBeenCalledWith("restart_app")
  })

  it("reports the installed shell's version, not the one the web bundle was built from", async () => {
    // A hot bundle outlives the shell it was built beside, so the footer's
    // version has to come from the shell that is actually running.
    ;(window as unknown as Record<string, unknown>).__TAURI__ = {}
    getVersion.mockResolvedValue("0.4.0")
    invoke.mockResolvedValue({ version: "2026.11.03.01", sha: "abc", source: "downloaded", staged: null, lastRollback: null })
    const mod = await load()
    await expect(mod.getDesktopVersions()).resolves.toEqual({ shell: "0.4.0", bundle: "2026.11.03.01" })
    await mod.getDesktopVersions()
    expect(getVersion).toHaveBeenCalledTimes(1)
  })

  it("still reports the shell when the bundle status cannot be read, and null when the shell cannot", async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI__ = {}
    getVersion.mockResolvedValue("0.4.0")
    invoke.mockRejectedValue(new Error("no store"))
    await expect((await load()).getDesktopVersions()).resolves.toEqual({ shell: "0.4.0", bundle: null })

    vi.resetModules()
    getVersion.mockRejectedValue(new Error("no bridge"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect((await load()).getDesktopVersions()).resolves.toBeNull()
    warn.mockRestore()
  })

  it("delivers event payloads and detaches even when unsubscribed before the listener landed", async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI__ = {}
    const stop = vi.fn()
    let handler: ((event: { payload: unknown }) => void) | undefined
    let resolveListen: ((stop: () => void) => void) | undefined
    listen.mockImplementation((_name: string, cb: (event: { payload: unknown }) => void) => {
      handler = cb
      return new Promise<() => void>((resolve) => {
        resolveListen = resolve
      })
    })
    const mod = await load()
    const onEvent = vi.fn()
    const unsubscribe = mod.subscribeBundleEvent("bundle://rolled-back", onEvent)
    await vi.waitFor(() => expect(listen).toHaveBeenCalledWith("bundle://rolled-back", expect.any(Function)))

    handler?.({ payload: { version: "2026.11.05.02" } })
    expect(onEvent).toHaveBeenCalledWith({ version: "2026.11.05.02" })

    // Unsubscribe while Tauri's listen() is still pending: a leaked listener
    // would keep firing toasts after the component unmounted.
    unsubscribe()
    resolveListen?.(stop)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  })
})
