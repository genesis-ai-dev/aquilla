// AQU-2304: the org's configurable import floor at the EMIT boundary.
//
// WHY THIS AND NOT ONLY A UI GATE: the outbox is durable. An org that has
// reserved source imports for maintainers will have the server 403 a project
// lead's `file.create`, and a certain 403 parked in the durable queue is
// retried forever and blocks everything queued behind it. So the mirror has
// to refuse the event before it is written — the same reason the static role
// table is mirrored client-side at all.
//
// The floor is NOT a row in that static table (it is per-org, and the table is
// static): it rides the workspace bridge, resolved by the server onto the
// project's own settings response. An absent floor therefore means "unknown",
// not "Project lead", and the gate must stay fail-open on it — a bridge that
// has not loaded the floor yet may only be more permissive, never wrongly
// closed, because the server remains the security boundary.

import { beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => ({
  roleLevel: null as number | null,
  importMinRole: null as number | null,
}))
vi.mock("./cqrs-bridge", () => ({
  getCqrsOutboxBridge: () => ({
    projectId: "p1",
    activeFileId: "f1",
    username: "u",
    roleLevel: bridge.roleLevel,
    importMinRole: bridge.importMinRole,
  }),
}))
vi.mock("./outbox", () => ({
  enqueueOutboxEvent: vi.fn(async () => {}),
  enqueueOutboxEvents: vi.fn(async () => {}),
}))

import { enqueueEvent, enqueueEvents, InsufficientRoleError } from "./events-emit"
import { enqueueOutboxEvent, enqueueOutboxEvents } from "./outbox"
import { ROLE } from "@/lib/frontier/roles"

const mockOne = enqueueOutboxEvent as unknown as ReturnType<typeof vi.fn>
const mockMany = enqueueOutboxEvents as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockOne.mockClear()
  mockMany.mockClear()
  bridge.roleLevel = null
  bridge.importMinRole = null
})

const fileCreate = () => ({
  kind: "file.create" as const,
  projectId: "p1",
  fileId: "f-new",
  cellId: null,
  author: "u",
  payload: { name: "Genesis.md", fileType: "markdown" },
}) as unknown as Parameters<typeof enqueueEvent>[0]

describe("file.create against the org's import floor (AQU-2304)", () => {
  it("refuses a project lead's import without touching the outbox", async () => {
    bridge.roleLevel = ROLE.PROJECT_LEAD
    bridge.importMinRole = ROLE.MAINTAINER
    await expect(enqueueEvent(fileCreate())).rejects.toBeInstanceOf(InsufficientRoleError)
    expect(mockOne).not.toHaveBeenCalled()
  })

  it("names the org's floor on the refusal, not the static Project-lead bar", async () => {
    bridge.roleLevel = ROLE.PROJECT_LEAD
    bridge.importMinRole = ROLE.MAINTAINER
    await expect(enqueueEvent(fileCreate())).rejects.toMatchObject({
      required: ROLE.MAINTAINER,
      roleLevel: ROLE.PROJECT_LEAD,
    })
  })

  it("admits a maintainer's import under the same floor", async () => {
    bridge.roleLevel = ROLE.MAINTAINER
    bridge.importMinRole = ROLE.MAINTAINER
    await enqueueEvent(fileCreate())
    expect(mockOne).toHaveBeenCalledTimes(1)
  })

  it("admits a project lead's import when the org never raised the floor", async () => {
    // An org that never touches the setting sees no behaviour change.
    bridge.roleLevel = ROLE.PROJECT_LEAD
    bridge.importMinRole = ROLE.PROJECT_LEAD
    await enqueueEvent(fileCreate())
    expect(mockOne).toHaveBeenCalledTimes(1)
  })

  it("fails OPEN on an unknown floor — the server stays authoritative", async () => {
    // A server predating the carried field, or a response not landed yet.
    bridge.roleLevel = ROLE.PROJECT_LEAD
    bridge.importMinRole = null
    await enqueueEvent(fileCreate())
    expect(mockOne).toHaveBeenCalledTimes(1)
  })

  it("fails open on an unknown role too, like every other gate here", async () => {
    bridge.roleLevel = null
    bridge.importMinRole = ROLE.MAINTAINER
    await enqueueEvent(fileCreate())
    expect(mockOne).toHaveBeenCalledTimes(1)
  })

  it("still refuses a contributor at the static bar, floor or no floor", async () => {
    bridge.roleLevel = ROLE.CONTRIBUTOR
    bridge.importMinRole = null
    await expect(enqueueEvent(fileCreate())).rejects.toMatchObject({
      required: ROLE.PROJECT_LEAD,
    })
    expect(mockOne).not.toHaveBeenCalled()
  })

  it("refuses a whole batch rather than half-queuing it", async () => {
    // A multi-book scripture import emits one `file.create` per book
    // (AQU-1187); the batch is one outbox transaction, so one refused entry
    // must take the lot — a half-written import is worse than none.
    bridge.roleLevel = ROLE.PROJECT_LEAD
    bridge.importMinRole = ROLE.MAINTAINER
    await expect(
      enqueueEvents([fileCreate(), fileCreate()] as Parameters<typeof enqueueEvents>[0]),
    ).rejects.toBeInstanceOf(InsufficientRoleError)
    expect(mockMany).not.toHaveBeenCalled()
  })

  it("leaves every other event kind alone", async () => {
    // The floor is scoped to `file.create`. A rename of a file already here
    // creates nothing and keeps its own contributor bar.
    bridge.roleLevel = ROLE.CONTRIBUTOR
    bridge.importMinRole = ROLE.MAINTAINER
    await enqueueEvent({
      kind: "file.rename",
      projectId: "p1",
      fileId: "f1",
      cellId: null,
      author: "u",
      payload: { name: "Exodus.md" },
    } as unknown as Parameters<typeof enqueueEvent>[0])
    expect(mockOne).toHaveBeenCalledTimes(1)
  })
})
