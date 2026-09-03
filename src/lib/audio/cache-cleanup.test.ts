import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetOpfsAvailabilityForTests,
  isOpfsAvailable,
} from "@/lib/storage/opfs-availability"
import { purgeAudioCachesOnSignOut } from "./cache-cleanup"

describe("purgeAudioCachesOnSignOut", () => {
  let originalStorageDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    __resetOpfsAvailabilityForTests()
    originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, "storage")
  })

  afterEach(() => {
    if (originalStorageDescriptor) {
      Object.defineProperty(navigator, "storage", originalStorageDescriptor)
    } else {
      Reflect.deleteProperty(navigator, "storage")
    }
    vi.restoreAllMocks()
  })

  function installStorage(getDirectory: () => Promise<FileSystemDirectoryHandle>) {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { ...navigator.storage, getDirectory },
    })
  }

  it("treats Safari Private Browsing's unavailable OPFS as having no cache to purge", async () => {
    const getDirectory = vi.fn().mockRejectedValue(
      new DOMException(
        "The operation failed for an unknown transient reason (e.g. out of memory).",
        "UnknownError",
      ),
    )
    installStorage(getDirectory)

    await expect(purgeAudioCachesOnSignOut({ strict: true })).resolves.toBeUndefined()

    expect(getDirectory).toHaveBeenCalledOnce()
    expect(isOpfsAvailable()).toBe(false)
  })

  it("still blocks strict cleanup when an accessible OPFS root cannot be purged, then retries", async () => {
    const removeEntry = vi.fn()
      .mockRejectedValueOnce(new DOMException("busy", "InvalidStateError"))
      .mockResolvedValue(undefined)
    const root = { removeEntry } as unknown as FileSystemDirectoryHandle
    installStorage(vi.fn().mockResolvedValue(root))

    await expect(purgeAudioCachesOnSignOut({ strict: true })).rejects.toThrow(/busy/i)
    await expect(purgeAudioCachesOnSignOut({ strict: true })).resolves.toBeUndefined()

    expect(removeEntry).toHaveBeenCalledTimes(4)
    expect(removeEntry).toHaveBeenNthCalledWith(1, "audio-peaks", { recursive: true })
    expect(removeEntry).toHaveBeenNthCalledWith(2, "audio-peaks", { recursive: true })
    expect(removeEntry).toHaveBeenNthCalledWith(3, "lfs-cache", { recursive: true })
    expect(removeEntry).toHaveBeenNthCalledWith(4, "audio-bytes", { recursive: true })
    expect(isOpfsAvailable()).toBe(true)
  })
})
