import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { liveStoreStorageFormatVersion } from "@livestore/common"
import { opfsStoreDir, waitForOpfsFilesFree, type OpfsDir, type OpfsFile } from "./opfs-handles"

const busyError = () => new DOMException("held elsewhere", "NoModificationAllowedError")

function file(name: string, isBusy: () => boolean = () => false): OpfsFile & { opened: number } {
  const f = {
    kind: "file" as const,
    name,
    opened: 0,
    createSyncAccessHandle: async () => {
      if (isBusy()) throw busyError()
      f.opened++
      return { close: () => {} }
    },
  }
  return f
}

function dir(name: string, entries: Array<OpfsFile | OpfsDir>): OpfsDir {
  return {
    kind: "directory",
    name,
    values: async function* () {
      yield* entries
    },
  }
}

const noSleep = () => Promise.resolve()

describe("waitForOpfsFilesFree", () => {
  it("names LiveStore's directory for the store", () => {
    // Read from the installed LiveStore rather than restated: if a version bump
    // renames the directory, the wait would match nothing and silently pass.
    const dist = dirname(createRequire(import.meta.url).resolve("@livestore/adapter-web"))
    const source = readFileSync(join(dist, "web-worker/common/persisted-sqlite.js"), "utf8")
    // Just the template, so a reformat or renamed const upstream doesn't fail this.
    expect(source).toContain("`livestore-${storeId}@${liveStoreStorageFormatVersion}`")
    expect(opfsStoreDir("aquilla-offline")).toBe(`livestore-aquilla-offline@${liveStoreStorageFormatVersion}`)
  })

  it("resolves at once when every pool file opens, and closes what it opened", async () => {
    const a = file("a")
    const b = file("b")
    const root = dir("", [dir("livestore-s@6", [a, b])])
    const onBusy = vi.fn()
    await waitForOpfsFilesFree("s", { root: async () => root, onBusy, sleep: noSleep })
    expect(a.opened).toBe(1)
    expect(b.opened).toBe(1)
    expect(onBusy).not.toHaveBeenCalled()
  })

  it("probes only the pool: not archive/, older formats or other directories", async () => {
    const busy = () => file("x", () => true)
    const archived = file("archived")
    const root = dir("", [
      dir("livestore-s@6", [file("pool-1"), dir("archive", [archived, busy()])]),
      dir("livestore-s@5", [busy()]),
      dir("unrelated", [busy()]),
      busy(),
    ])
    const onBusy = vi.fn()
    await waitForOpfsFilesFree("s", { root: async () => root, onBusy, sleep: noSleep })
    expect(archived.opened).toBe(0)
    expect(onBusy).not.toHaveBeenCalled()
  })

  it("resolves when the store has no directory yet", async () => {
    await expect(waitForOpfsFilesFree("s", { root: async () => dir("", []), onBusy: () => {} })).resolves.toBeUndefined()
  })

  it("leaves a missing OPFS to LiveStore's own fallback", async () => {
    const root = () => Promise.reject(new DOMException("no", "SecurityError"))
    await expect(waitForOpfsFilesFree("s", { root, onBusy: () => {} })).resolves.toBeUndefined()
  })

  it("skips a file the old leader removed after it was listed", async () => {
    const gone: OpfsFile = {
      kind: "file",
      name: "pool-1",
      createSyncAccessHandle: () => Promise.reject(new DOMException("gone", "NotFoundError")),
    }
    const next = file("pool-2")
    const root = dir("", [dir("livestore-s@6", [gone, next])])
    await waitForOpfsFilesFree("s", { root: async () => root, onBusy: () => {}, sleep: noSleep })
    expect(next.opened).toBe(1)
  })

  it("waits while another leader has a file open, and says which", async () => {
    let busyFor = 3
    const held = file("pool-1", () => busyFor-- > 0)
    const root = dir("", [dir("livestore-s@6", [held])])
    const onBusy = vi.fn()
    const sleep = vi.fn((_ms: number) => noSleep())
    await waitForOpfsFilesFree("s", { root: async () => root, onBusy, sleep, retryMs: 10 })
    expect(onBusy).toHaveBeenCalledOnce()
    expect(onBusy).toHaveBeenCalledWith("livestore-s@6/pool-1")
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20, 40])
    expect(held.opened).toBe(1)
  })

  it("gives up after the timeout instead of hanging the boot", async () => {
    let t = 0
    const root = dir("", [dir("livestore-s@6", [file("pool-1", () => true)])])
    await expect(
      waitForOpfsFilesFree("s", {
        root: async () => root,
        onBusy: () => {},
        timeoutMs: 1000,
        now: () => t,
        sleep: async (ms) => {
          t += ms
        },
      }),
    ).rejects.toThrow(/pool-1 is still open in another leader after 1000 ms/)
  })

  it("passes on errors other than a busy file", async () => {
    const broken: OpfsFile = {
      kind: "file",
      name: "pool-1",
      createSyncAccessHandle: () => Promise.reject(new DOMException("no", "NotAllowedError")),
    }
    const root = dir("", [dir("livestore-s@6", [broken])])
    await expect(waitForOpfsFilesFree("s", { root: async () => root, onBusy: () => {}, sleep: noSleep })).rejects.toMatchObject({
      name: "NotAllowedError",
    })
  })

  it("retries when the pool directory is removed while it's being listed", async () => {
    let listings = 0
    const a = file("a")
    const vanishing: OpfsDir = {
      kind: "directory",
      name: "livestore-s@6",
      values: async function* () {
        listings++
        if (listings === 1) throw new DOMException("gone", "NotFoundError")
        yield a
      },
    }
    const onBusy = vi.fn()
    await waitForOpfsFilesFree("s", { root: async () => dir("", [vanishing]), onBusy, sleep: noSleep })
    expect(listings).toBe(2)
    expect(a.opened).toBe(1)
    expect(onBusy).toHaveBeenCalledWith("livestore-s@6 (changing)")
  })
})
