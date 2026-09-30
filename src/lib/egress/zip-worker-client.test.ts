// AQU-1269: org export must DEFLATE off the main thread, and must still export
// when no worker exists. These tests pin both halves — the worker actually
// receives the packaging work, and every infra failure degrades to inline
// packing rather than failing the export.

import { describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import {
  FakeZipWorker,
  replyWithRealZip,
  zipWorkerFactory,
} from "./__fixtures__/fake-zip-worker"
import { createEgressZipPacker } from "./zip-worker-client"

const entries = [
  { path: "fr/f1.txt", data: "text-f1" },
  { path: "fr/f2.txt", data: "text-f2" },
]

describe("createEgressZipPacker", () => {
  it("packs in the worker, not on the main thread, and the zip round-trips", async () => {
    const worker = new FakeZipWorker()
    const packer = createEgressZipPacker(zipWorkerFactory(worker))

    const blob = await packer.pack(entries)

    expect(worker.ops).toEqual(["pack"])
    expect(packer.inline).toBe(false)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(await zip.files["fr/f1.txt"].async("string")).toBe("text-f1")
    expect(await zip.files["fr/f2.txt"].async("string")).toBe("text-f2")
    packer.dispose()
    expect(worker.terminated).toBe(true)
  })

  it("reuses ONE worker across calls and unpacks through it too", async () => {
    const worker = new FakeZipWorker()
    const create = vi.fn(zipWorkerFactory(worker))
    const packer = createEgressZipPacker(create)

    const blob = await packer.pack(entries)
    const round = await packer.unpack(await blob.arrayBuffer())

    expect(create).toHaveBeenCalledTimes(1)
    expect(worker.ops).toEqual(["pack", "unpack"])
    expect(round.map((e) => e.path).sort()).toEqual(["fr/f1.txt", "fr/f2.txt"])
    packer.dispose()
  })

  it("packs inline when no worker can be created — an export must not depend on one", async () => {
    const packer = createEgressZipPacker(async () => null)

    const blob = await packer.pack(entries)

    expect(packer.inline).toBe(true)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(await zip.files["fr/f1.txt"].async("string")).toBe("text-f1")
    packer.dispose()
  })

  it("degrades to inline for the rest of the run after the worker crashes", async () => {
    const worker = new FakeZipWorker((req) => (req.op === "pack" ? "crash" : replyWithRealZip(req)))
    const packer = createEgressZipPacker(zipWorkerFactory(worker))

    const blob = await packer.pack(entries)

    expect(packer.inline).toBe(true)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(await zip.files["fr/f1.txt"].async("string")).toBe("text-f1")
    expect(await zip.files["fr/f2.txt"].async("string")).toBe("text-f2")
    // A second call must not re-try the dead worker.
    const before = worker.requests.length
    await packer.unpack(await blob.arrayBuffer())
    expect(worker.requests.length).toBe(before)
    packer.dispose()
  })

  it("propagates a genuine zip failure instead of silently repacking inline", async () => {
    const worker = new FakeZipWorker(async (req) => ({
      id: req.id,
      ok: false,
      error: "zip exploded",
    }))
    const packer = createEgressZipPacker(zipWorkerFactory(worker))

    await expect(packer.pack(entries)).rejects.toThrow("zip exploded")
    expect(packer.inline).toBe(false)
    packer.dispose()
  })
})
