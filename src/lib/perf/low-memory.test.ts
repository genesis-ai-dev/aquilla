import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  isConstrainedDevice,
  LOW_MEMORY_DEVICE_MEMORY_GB,
  LOW_MEMORY_HEAP_LIMIT_BYTES,
} from "./low-memory"

/** The mode and the detection result are cached at module load, so each case
 *  that depends on either re-imports after arranging globals/storage. */
async function load() {
  vi.resetModules()
  return import("./low-memory")
}

function stubDeviceMemory(gb: number | undefined): void {
  if (gb === undefined) {
    delete (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    return
  }
  Object.defineProperty(navigator, "deviceMemory", {
    value: gb,
    configurable: true,
    writable: true,
  })
}

function stubHeapLimit(bytes: number | undefined): void {
  if (bytes === undefined) {
    delete (performance as Performance & { memory?: unknown }).memory
    return
  }
  Object.defineProperty(performance, "memory", {
    value: { jsHeapSizeLimit: bytes },
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  localStorage.clear()
  stubDeviceMemory(undefined)
  stubHeapLimit(undefined)
})

describe("isConstrainedDevice", () => {
  it("calls a device at or below the reported-RAM threshold constrained", () => {
    expect(isConstrainedDevice({ deviceMemoryGb: LOW_MEMORY_DEVICE_MEMORY_GB })).toBe(true)
    expect(isConstrainedDevice({ deviceMemoryGb: 0.5 })).toBe(true)
  })

  it("leaves a roomy device alone", () => {
    expect(isConstrainedDevice({ deviceMemoryGb: 8 })).toBe(false)
    expect(isConstrainedDevice({ jsHeapSizeLimitBytes: 4 * LOW_MEMORY_HEAP_LIMIT_BYTES })).toBe(false)
  })

  it("leaves the wide 4 GiB bucket alone — it is an ordinary laptop, not a field device", () => {
    // `deviceMemory` rounds down to a power of two, so 4 means anything from
    // 4 GB to just under 8 GB. Auto must not quietly strip the editor there.
    expect(isConstrainedDevice({ deviceMemoryGb: 4 })).toBe(false)
  })

  it("trips on a small heap ceiling even when RAM reads roomy", () => {
    expect(
      isConstrainedDevice({ deviceMemoryGb: 8, jsHeapSizeLimitBytes: LOW_MEMORY_HEAP_LIMIT_BYTES }),
    ).toBe(true)
  })

  it("treats an unreported signal as silence, not as a roomy device", () => {
    // Firefox and Safari report neither — auto must not dial back a device it
    // cannot measure, and a zero is a bad reading rather than "no memory".
    expect(isConstrainedDevice({})).toBe(false)
    expect(isConstrainedDevice({ deviceMemoryGb: 0, jsHeapSizeLimitBytes: 0 })).toBe(false)
  })
})

describe("low-memory mode", () => {
  it("defaults to auto, and auto follows the device", async () => {
    stubDeviceMemory(2)
    const mod = await load()
    expect(mod.getLowMemoryMode()).toBe("auto")
    expect(mod.isConstrainedDeviceDetected()).toBe(true)
    expect(mod.isLowMemoryActive()).toBe(true)
  })

  it("is off on an unmeasurable device, so nothing is dialed back by guesswork", async () => {
    const mod = await load()
    expect(mod.isLowMemoryActive()).toBe(false)
  })

  it('"off" wins over a device that reports itself constrained', async () => {
    stubDeviceMemory(1)
    const mod = await load()
    expect(mod.isLowMemoryActive()).toBe(true)
    mod.setLowMemoryMode("off")
    expect(mod.isLowMemoryActive()).toBe(false)
  })

  it('"on" wins over a device that reports itself roomy', async () => {
    stubDeviceMemory(8)
    const mod = await load()
    expect(mod.isLowMemoryActive()).toBe(false)
    mod.setLowMemoryMode("on")
    expect(mod.isLowMemoryActive()).toBe(true)
  })

  it("persists an override across reloads and clears back to auto", async () => {
    stubDeviceMemory(8)
    const first = await load()
    first.setLowMemoryMode("on")
    expect(localStorage.getItem("low-memory-mode")).toBe("on")

    const afterReload = await load()
    expect(afterReload.getLowMemoryMode()).toBe("on")
    expect(afterReload.isLowMemoryActive()).toBe(true)

    afterReload.setLowMemoryMode("auto")
    expect(localStorage.getItem("low-memory-mode")).toBe(null)
    expect((await load()).getLowMemoryMode()).toBe("auto")
  })

  it("notifies subscribers on a change and not on a no-op set", async () => {
    const mod = await load()
    const listener = vi.fn()
    const unsubscribe = mod.subscribeLowMemory(listener)

    mod.setLowMemoryMode("on")
    expect(listener).toHaveBeenCalledTimes(1)
    mod.setLowMemoryMode("on")
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    mod.setLowMemoryMode("off")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("ignores an unrecognized stored value rather than failing closed", async () => {
    localStorage.setItem("low-memory-mode", "yes-please")
    const mod = await load()
    expect(mod.getLowMemoryMode()).toBe("auto")
  })
})
