import { describe, expect, it, vi } from "vitest"
import { claimOfflineGeneration, NewerOfflineDataError, type GenerationMarker } from "./generation-guard"

function memoryMarker(initial: number | null): GenerationMarker & { value: number | null; writes: number } {
  const marker = {
    value: initial,
    writes: 0,
    read: async () => marker.value,
    write: async (generation: number) => {
      marker.writes += 1
      marker.value = generation
    },
  }
  return marker
}

describe("claimOfflineGeneration", () => {
  it("claims a device that has no marker yet", async () => {
    const marker = memoryMarker(null)
    await claimOfflineGeneration(marker, 2)
    expect(marker.value).toBe(2)
  })

  it("raises an older marker to this build's generation", async () => {
    const marker = memoryMarker(1)
    await claimOfflineGeneration(marker, 2)
    expect(marker.value).toBe(2)
  })

  it("leaves a matching marker alone", async () => {
    const marker = memoryMarker(2)
    await claimOfflineGeneration(marker, 2)
    expect(marker.writes).toBe(0)
  })

  it("refuses data a newer build wrote, without lowering the marker", async () => {
    const marker = memoryMarker(3)
    await expect(claimOfflineGeneration(marker, 2)).rejects.toBeInstanceOf(NewerOfflineDataError)
    await expect(claimOfflineGeneration(marker, 2)).rejects.toMatchObject({ storedGeneration: 3, buildGeneration: 2 })
    expect(marker.value).toBe(3)
    expect(marker.writes).toBe(0)
  })

  it("opens anyway when the marker can't be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const marker = memoryMarker(null)
    marker.read = async () => {
      throw new Error("garbage")
    }
    await expect(claimOfflineGeneration(marker, 2)).resolves.toBeUndefined()
    expect(marker.value).toBe(2)
  })

  it("opens anyway when the marker can't be written", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const marker = memoryMarker(null)
    marker.write = async () => {
      throw new Error("quota")
    }
    await expect(claimOfflineGeneration(marker, 2)).resolves.toBeUndefined()
  })
})
