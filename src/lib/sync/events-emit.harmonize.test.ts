/**
 * FRO-186: Tests for emitCellHarmonize — the cell.commit.harmonize variant.
 *
 * Verifies:
 *  1. emitCellHarmonize enqueues a target.cell.commit with harmonize_origin.
 *  2. canHarmonize client gate respects harmonize_min_role floor.
 *  3. emitCellHarmonize throws InsufficientRoleError when role too low.
 *  4. emitCellHarmonize fails-open when role is unknown (bridge unset).
 */

import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  emitCellHarmonize,
  canHarmonize,
  InsufficientRoleError,
} from "./events-emit"
import {
  outboxPendingCount,
  peekOutboxBatch,
  resetOutboxConnectionForTests,
} from "./outbox"
import { setCqrsOutboxBridge } from "./cqrs-bridge"
import { ROLE } from "./role-policy"

describe("emitCellHarmonize — event variant", () => {
  beforeEach(async () => {
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("enqueues a target.cell.commit with harmonize_origin payload", async () => {
    // Fail-open: no bridge set → role unknown → passes client gate.
    setCqrsOutboxBridge(null)

    await emitCellHarmonize({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      parentId: "evt-parent",
      value: "Corrected text",
      author: "lead",
      ruleOrCheckId: "builtin:double-space",
      proposalKind: "batch-regex",
    })

    expect(await outboxPendingCount()).toBe(1)
    const [record] = await peekOutboxBatch(1)
    expect(record.event.kind).toBe("target.cell.commit")
    const payload = record.event.payload as Record<string, unknown>
    expect(payload.harmonize_origin).toMatchObject({
      rule_or_check_id: "builtin:double-space",
      proposal_kind: "batch-regex",
    })
    expect(payload.value).toBe("Corrected text")
  })

  it("includes parent_proposal_id when provided", async () => {
    setCqrsOutboxBridge(null)

    await emitCellHarmonize({
      projectId: "p1",
      fileId: "f1",
      cellId: "c2",
      parentId: null,
      value: "Fixed",
      author: "lead",
      ruleOrCheckId: "r-abc",
      proposalKind: "cached-regex",
      parentProposalId: "sweep-session-42",
    })

    const [record] = await peekOutboxBatch(1)
    const payload = record.event.payload as Record<string, unknown>
    const origin = payload.harmonize_origin as Record<string, unknown>
    expect(origin.parent_proposal_id).toBe("sweep-session-42")
  })
})

describe("emitCellHarmonize — client role gate", () => {
  beforeEach(async () => {
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("throws InsufficientRoleError when caller is contributor(400) — below project_lead(500) floor", async () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.CONTRIBUTOR })

    await expect(
      emitCellHarmonize({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: null,
        value: "x",
        author: "u",
        ruleOrCheckId: "r",
        proposalKind: "batch-regex",
      }),
    ).rejects.toBeInstanceOf(InsufficientRoleError)
    // Event must NOT reach the outbox.
    expect(await outboxPendingCount()).toBe(0)
  })

  it("allows project_lead(500) with default floor (project_lead)", async () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.PROJECT_LEAD })

    await emitCellHarmonize({
      projectId: "p",
      fileId: "f",
      cellId: "c",
      parentId: null,
      value: "x",
      author: "u",
      ruleOrCheckId: "r",
      proposalKind: "batch-regex",
    })

    expect(await outboxPendingCount()).toBe(1)
  })

  it("rejects project_lead(500) when harmonize_min_role is maintainer(600)", async () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.PROJECT_LEAD })

    await expect(
      emitCellHarmonize(
        {
          projectId: "p",
          fileId: "f",
          cellId: "c",
          parentId: null,
          value: "x",
          author: "u",
          ruleOrCheckId: "r",
          proposalKind: "batch-regex",
        },
        "maintainer",
      ),
    ).rejects.toBeInstanceOf(InsufficientRoleError)
    expect(await outboxPendingCount()).toBe(0)
  })

  it("allows maintainer(600) when harmonize_min_role is maintainer", async () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.MAINTAINER })

    await emitCellHarmonize(
      {
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: null,
        value: "x",
        author: "u",
        ruleOrCheckId: "r",
        proposalKind: "batch-regex",
      },
      "maintainer",
    )

    expect(await outboxPendingCount()).toBe(1)
  })

  it("fails open when bridge is unset (role unknown) — server stays authoritative", async () => {
    setCqrsOutboxBridge(null)

    await emitCellHarmonize({
      projectId: "p",
      fileId: "f",
      cellId: "c",
      parentId: null,
      value: "x",
      author: "u",
      ruleOrCheckId: "r",
      proposalKind: "per-cell",
    })

    expect(await outboxPendingCount()).toBe(1)
  })
})

describe("canHarmonize — client gate helper", () => {
  it("returns true for project_lead(500) with default floor", () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.PROJECT_LEAD })
    expect(canHarmonize()).toBe(true)
  })

  it("returns false for contributor(400) with default floor", () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.CONTRIBUTOR })
    expect(canHarmonize()).toBe(false)
  })

  it("returns false for project_lead(500) when floor is maintainer(600)", () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.PROJECT_LEAD })
    expect(canHarmonize("maintainer")).toBe(false)
  })

  it("returns true for maintainer(600) when floor is maintainer(600)", () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.MAINTAINER })
    expect(canHarmonize("maintainer")).toBe(true)
  })

  it("returns true when bridge is unset (fail-open)", () => {
    setCqrsOutboxBridge(null)
    expect(canHarmonize()).toBe(true)
  })
})
