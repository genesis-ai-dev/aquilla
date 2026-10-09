// AQU-1565 follow-up: `role: "source"` on cell.audio.attach.
//
// WHY: the role is what keeps the shared programme recording from being read
// as a dub on every row, so it has to survive the emit boundary. And the
// server refuses it below Project Lead, so the client must refuse it too,
// BEFORE the outbox: a certain 403 parked in the durable queue is retried
// forever and blocks everything queued behind it.

import { beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => ({ roleLevel: null as number | null }))
vi.mock("./cqrs-bridge", () => ({
  getCqrsOutboxBridge: () => ({ projectId: "p1", activeFileId: "f1", username: "u", roleLevel: bridge.roleLevel }),
}))
vi.mock("./outbox", () => ({ enqueueOutboxEvent: vi.fn(async () => {}) }))

import { emitCellAudioAttach, InsufficientRoleError, type CellAudioAttachInput } from "./events-emit"
import { enqueueOutboxEvent } from "./outbox"
import { ROLE } from "@/lib/frontier/roles"

const mockEnqueue = enqueueOutboxEvent as unknown as ReturnType<typeof vi.fn>
beforeEach(() => {
  mockEnqueue.mockClear()
  bridge.roleLevel = null
})

const base: CellAudioAttachInput = {
  projectId: "p1",
  fileId: "f1",
  cellId: "c1",
  audioId: "f1-clip.wav",
  url: "frontier-audio://f1-clip.wav",
  slot: "recording",
  author: "u",
}

function lastPayload(): Record<string, unknown> {
  return (mockEnqueue.mock.calls.at(-1)![0] as { payload: Record<string, unknown> }).payload
}

describe("cell.audio.attach role", () => {
  it("forwards role: source", async () => {
    bridge.roleLevel = ROLE.PROJECT_LEAD
    await emitCellAudioAttach({ ...base, role: "source" })
    expect(lastPayload().role).toBe("source")
  })

  it("leaves the role out of an ordinary take, which the server stores as a dub", async () => {
    bridge.roleLevel = ROLE.CONTRIBUTOR
    await emitCellAudioAttach(base)
    expect(lastPayload()).not.toHaveProperty("role")
  })

  it("refuses role: source below Project Lead without touching the outbox", async () => {
    bridge.roleLevel = ROLE.CONTRIBUTOR
    await expect(emitCellAudioAttach({ ...base, role: "source" })).rejects.toBeInstanceOf(InsufficientRoleError)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("fails open on an unknown role (the server stays authoritative)", async () => {
    bridge.roleLevel = null
    await emitCellAudioAttach({ ...base, role: "source" })
    expect(lastPayload().role).toBe("source")
  })
})
