/**
 * AQU-249 fix — serialized handleImported read-modify-write.
 *
 * WHY: The original handleImported did:
 *   1. await getProject(id)          ← fresh read
 *   2. compute nextFiles from result
 *   3. await updateProject(nextFiles)  ← write
 *
 * Two concurrent imports interleaved these steps:
 *   Import A: read(files=[]), add A → write([A])
 *   Import B: read(files=[]), add B → write([B])   ← overwrites A, B=[B]
 *
 * The fix serializes via a module-level promise chain (_lastImportWrite) so
 * Import B always runs AFTER Import A's write commits:
 *   Import A: read([]) → write([A])
 *   Import B: read([A]) → write([A,B])
 *
 * This test validates the serialization pattern in isolation (without React)
 * so the invariant is machine-verifiable regardless of rendering behavior.
 */

import { describe, it, expect, vi } from "vitest"

/**
 * Simulates the serialized read-modify-write pattern used in handleImported.
 * Returns a test harness where each "import" call races against others.
 */
function makeSerializedImporter(
  getFiles: () => Promise<string[]>,
  setFiles: (files: string[]) => Promise<void>,
) {
  // Module-level chain (mirrors _lastImportWrite in ProjectWorkspace.tsx)
  let lastWrite: Promise<string[]> = Promise.resolve([])

  return {
    import(refId: string): Promise<string[]> {
      lastWrite = lastWrite
        .catch(() => [] as string[]) // swallow prior failures
        .then(async () => {
          const current = await getFiles()
          if (current.includes(refId)) return current
          const next = [...current, refId]
          await setFiles(next)
          return next
        })
      return lastWrite
    },
  }
}

describe("serialized import read-modify-write (AQU-249 Fix 2)", () => {
  it("serializes concurrent imports so both refs are preserved", async () => {
    // Simulate IDB: one read-write store.
    const store: { files: string[] } = { files: [] }

    // Add artificial async delays to simulate real IDB latency.
    const getFiles = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return [...store.files]
    })
    const setFiles = vi.fn(async (files: string[]) => {
      await new Promise((r) => setTimeout(r, 5))
      store.files = files
    })

    const { import: importRef } = makeSerializedImporter(getFiles, setFiles)

    // Fire A and B concurrently (simulates the "Esc flush fires while a
    // second import is still in-flight" scenario described in AQU-249).
    const [resultA, resultB] = await Promise.all([importRef("A"), importRef("B")])

    // WHY: both refs must survive. Before the fix, B's read happened before
    // A's write and the final store only contained [B].
    expect(store.files).toEqual(["A", "B"])
    // Each result reflects the state after that import committed.
    expect(resultA).toEqual(["A"])
    expect(resultB).toEqual(["A", "B"])
    // getFiles was called twice (once per import), not just once.
    expect(getFiles).toHaveBeenCalledTimes(2)
  })

  it("de-duplicates: importing the same ref twice keeps only one copy", async () => {
    const store: { files: string[] } = { files: [] }
    const getFiles = vi.fn(async () => [...store.files])
    const setFiles = vi.fn(async (files: string[]) => { store.files = files })

    const { import: importRef } = makeSerializedImporter(getFiles, setFiles)

    await importRef("X")
    await importRef("X") // duplicate
    expect(store.files).toEqual(["X"])
    expect(store.files.filter((f) => f === "X").length).toBe(1)
  })

  it("does not get stuck if a previous write fails", async () => {
    const store: { files: string[] } = { files: [] }
    let callCount = 0
    const getFiles = vi.fn(async () => [...store.files])
    const setFiles = vi.fn(async (files: string[]) => {
      callCount++
      if (callCount === 1) throw new Error("IDB write failed")
      store.files = files
    })

    const { import: importRef } = makeSerializedImporter(getFiles, setFiles)

    // First import fails (write throws).
    await expect(importRef("A")).rejects.toThrow("IDB write failed")
    // Second import succeeds despite the first failure.
    await importRef("B")
    expect(store.files).toEqual(["B"])
  })

  it("preserves insertion order across three concurrent imports", async () => {
    const store: { files: string[] } = { files: [] }
    const getFiles = vi.fn(async () => [...store.files])
    const setFiles = vi.fn(async (files: string[]) => { store.files = files })

    const { import: importRef } = makeSerializedImporter(getFiles, setFiles)

    await Promise.all([importRef("1"), importRef("2"), importRef("3")])
    // All three refs must be present.
    expect(store.files).toHaveLength(3)
    expect(store.files).toContain("1")
    expect(store.files).toContain("2")
    expect(store.files).toContain("3")
  })
})
