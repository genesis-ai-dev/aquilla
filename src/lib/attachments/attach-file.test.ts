// AQU-777: the attach/remove orchestration.
//
// The ORDER is the contract these tests exist to pin, in both directions:
//   - attach PUTs the bytes, THEN emits, so a projected row always points at
//     an object that exists — and deletes the object if the emit throws,
//     rather than leaking it;
//   - remove emits FIRST, then deletes, so a failed emit can never leave every
//     collaborator holding a link to a 404.
// Reversing either is a silent data bug, not a test failure, so it is written
// down here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { FrontierSession } from "@/lib/frontier/types"

const uploadCellAttachment = vi.fn()
const deleteCellAttachment = vi.fn()
const emitCellAttachmentAdd = vi.fn()
const emitCellAttachmentRemove = vi.fn()

vi.mock("@/lib/attachments/upload", async () => {
  const actual = await vi.importActual<typeof import("@/lib/attachments/upload")>(
    "@/lib/attachments/upload",
  )
  return {
    ...actual,
    uploadCellAttachment: (...args: unknown[]) => uploadCellAttachment(...args),
    deleteCellAttachment: (...args: unknown[]) => deleteCellAttachment(...args),
  }
})

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAttachmentAdd: (...args: unknown[]) => emitCellAttachmentAdd(...args),
  emitCellAttachmentRemove: (...args: unknown[]) => emitCellAttachmentRemove(...args),
}))

vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "test-token",
}))

const {
  ACCEPT,
  attachFileToCell,
  removeAttachmentFromCell,
  resolveAttachmentContentType,
  validateAttachmentFile,
} = await import("./attach-file")

const session = { jwt: "jwt", username: "ana" } as unknown as FrontierSession

function makeFile(
  name: string,
  type: string,
  size = 1024,
): File {
  const file = new File([new Uint8Array(1)], name, { type })
  // File's size is derived from its parts; override so a test can describe a
  // 40 MB pick without allocating 40 MB.
  Object.defineProperty(file, "size", { value: size })
  return file
}

const baseArgs = {
  session,
  projectId: "p1",
  fileId: "f1",
  cellId: "GEN 1:1",
  username: "ana",
}

beforeEach(() => {
  uploadCellAttachment.mockReset().mockResolvedValue({ objectName: "x.png", sizeBytes: 1024 })
  deleteCellAttachment.mockReset().mockResolvedValue(undefined)
  emitCellAttachmentAdd.mockReset().mockResolvedValue("evt-1")
  emitCellAttachmentRemove.mockReset().mockResolvedValue("evt-2")
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("resolveAttachmentContentType", () => {
  it("takes the declared type when it is on the allow-list", () => {
    expect(resolveAttachmentContentType(makeFile("a.png", "image/png"))).toBe("image/png")
    expect(resolveAttachmentContentType(makeFile("a.png", "image/PNG; x=1"))).toBe("image/png")
  })

  it("recovers from the extension when the browser reports no type", () => {
    // Mobile browsers routinely report an empty type for a camera-roll pick;
    // refusing those outright would break the feature's main use case.
    expect(resolveAttachmentContentType(makeFile("shot.JPG", ""))).toBe("image/jpeg")
    expect(resolveAttachmentContentType(makeFile("scan.pdf", ""))).toBe("application/pdf")
  })

  it("recovers only INTO the allow-list — a mislabelled svg stays refused", () => {
    // The recovery path must not become a way in for active content: an
    // attacker controls both the declared type and the filename.
    expect(resolveAttachmentContentType(makeFile("x.svg", "image/svg+xml"))).toBeNull()
    expect(resolveAttachmentContentType(makeFile("x.svg", "image/png"))).toBe("image/png")
    expect(resolveAttachmentContentType(makeFile("x.html", ""))).toBeNull()
  })
})

describe("validateAttachmentFile", () => {
  it("accepts an ordinary screenshot", () => {
    expect(validateAttachmentFile(makeFile("a.png", "image/png"))).toBeNull()
  })

  it("refuses an empty file", () => {
    expect(validateAttachmentFile(makeFile("a.png", "image/png", 0))).toMatch(/empty/i)
  })

  it("refuses an unsupported type, naming what is supported", () => {
    const msg = validateAttachmentFile(makeFile("a.svg", "image/svg+xml"))
    expect(msg).toMatch(/PNG/)
  })

  it("refuses an oversize pick, naming both sizes", () => {
    const msg = validateAttachmentFile(makeFile("a.png", "image/png", 40 * 1024 * 1024))
    expect(msg).toMatch(/40 MB/)
    expect(msg).toMatch(/25 MB/)
  })
})

describe("ACCEPT", () => {
  it("lists extensions as well as types, for mobile pickers", () => {
    // `image/*` alone hides camera-roll files whose type the browser gets
    // wrong — the same reason the audio picker lists extensions.
    expect(ACCEPT).toContain("image/png")
    expect(ACCEPT).toContain(".png")
    expect(ACCEPT).not.toContain("svg")
  })
})

describe("attachFileToCell", () => {
  it("uploads the bytes BEFORE emitting the event", async () => {
    const order: string[] = []
    uploadCellAttachment.mockImplementation(async () => {
      order.push("upload")
      return { objectName: "x.png", sizeBytes: 1024 }
    })
    emitCellAttachmentAdd.mockImplementation(async () => {
      order.push("emit")
      return "evt-1"
    })

    await attachFileToCell({ ...baseArgs, file: makeFile("a.png", "image/png") })

    expect(order).toEqual(["upload", "emit"])
  })

  it("names the R2 object from the VALIDATED type, not the filename", () => {
    // A filename-derived extension would put `screenshot.svg` in R2 under an
    // .svg name even though the bytes were validated and stored as a PNG.
    return attachFileToCell({
      ...baseArgs,
      file: makeFile("screenshot.svg", "image/png"),
    }).then((result) => {
      expect(result.objectName).toMatch(/\.png$/)
      expect(result.objectName).not.toMatch(/svg/)
      expect(uploadCellAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: "image/png" }),
      )
    })
  })

  it("emits the payload the projection expects, with the picked filename", async () => {
    await attachFileToCell({
      ...baseArgs,
      file: makeFile("chapter-3-layout.png", "image/png", 20_480),
    })
    expect(emitCellAttachmentAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        fileId: "f1",
        cellId: "GEN 1:1",
        name: "chapter-3-layout.png",
        mimeType: "image/png",
        sizeBytes: 20_480,
        author: "ana",
      }),
    )
    const payload = emitCellAttachmentAdd.mock.calls[0][0] as { attachmentId: string; objectName: string }
    expect(payload.objectName).toBe(`${payload.attachmentId}.png`)
  })

  it("deletes the uploaded object when the emit fails, instead of leaking it", async () => {
    emitCellAttachmentAdd.mockRejectedValue(new Error("outbox is full"))

    await expect(
      attachFileToCell({ ...baseArgs, file: makeFile("a.png", "image/png") }),
    ).rejects.toThrow("outbox is full")

    // The cleanup must name the object the UPLOAD was given, not whatever the
    // upload echoed back — those are the bytes actually sitting in R2.
    const uploaded = uploadCellAttachment.mock.calls[0][0] as { objectName: string }
    expect(deleteCellAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        fileId: "f1",
        objectName: uploaded.objectName,
      }),
    )
  })

  it("refuses an invalid pick before touching the network", async () => {
    await expect(
      attachFileToCell({ ...baseArgs, file: makeFile("a.svg", "image/svg+xml") }),
    ).rejects.toThrow(/PNG/)
    expect(uploadCellAttachment).not.toHaveBeenCalled()
    expect(emitCellAttachmentAdd).not.toHaveBeenCalled()
  })

  it("refuses offline up front rather than failing mid-upload", async () => {
    // Bytes can never be queued: the outbox carries JSON events only. Going
    // ahead would be three doomed retries ending in a raw fetch TypeError.
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    await expect(
      attachFileToCell({ ...baseArgs, file: makeFile("a.png", "image/png") }),
    ).rejects.toThrow(/offline/i)
    expect(uploadCellAttachment).not.toHaveBeenCalled()
  })

  it("refuses without a session", async () => {
    await expect(
      attachFileToCell({ ...baseArgs, session: null, file: makeFile("a.png", "image/png") }),
    ).rejects.toThrow(/Sign in/)
    expect(uploadCellAttachment).not.toHaveBeenCalled()
  })
})

describe("removeAttachmentFromCell", () => {
  const removeArgs = {
    ...baseArgs,
    attachmentId: "att-1",
    objectName: "att-1.png",
  }

  it("emits the removal BEFORE deleting the bytes", async () => {
    // The mirror of attach's order, for the mirror reason: never leave a live
    // row pointing at bytes that are already gone.
    const order: string[] = []
    emitCellAttachmentRemove.mockImplementation(async () => {
      order.push("emit")
      return "evt-2"
    })
    deleteCellAttachment.mockImplementation(async () => {
      order.push("delete")
    })

    await removeAttachmentFromCell(removeArgs)

    expect(order).toEqual(["emit", "delete"])
  })

  it("leaves the bytes alone when the emit fails", async () => {
    emitCellAttachmentRemove.mockRejectedValue(new Error("offline"))
    await expect(removeAttachmentFromCell(removeArgs)).rejects.toThrow("offline")
    expect(deleteCellAttachment).not.toHaveBeenCalled()
  })

  it("refuses without a session", async () => {
    await expect(
      removeAttachmentFromCell({ ...removeArgs, session: null }),
    ).rejects.toThrow(/Sign in/)
    expect(emitCellAttachmentRemove).not.toHaveBeenCalled()
  })
})
