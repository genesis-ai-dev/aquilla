import { describe, it, expect } from "vitest"
import { render, screen, within, fireEvent } from "@testing-library/react"
import { OutboxInspectorPopover } from "./OutboxInspectorPopover"
import type { OutboxRecord } from "@/lib/sync/outbox"

function makeRecord(i: number): OutboxRecord {
  return {
    id: `evt-${i}`,
    enqueuedAt: 1_000 + i,
    event: {
      id: `evt-${i}`,
      schemaVersion: 1,
      kind: "target.cell.commit",
      projectId: "p1",
      fileId: "f1",
      cellId: `c${i}`,
      parentId: "s1",
      author: "u1",
      payload: { value: `value ${i}` },
      clientTs: 1_000 + i,
    },
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    status: "pending",
  } as unknown as OutboxRecord
}

describe("OutboxInspectorPopover volume guard", () => {
  it("caps the rendered record list at DISPLAY_CAP and shows the true overflow from pendingCount", async () => {
    // 150 records in hand, but the true queue is 5000 (records is capped upstream).
    const records = Array.from({ length: 150 }, (_, i) => makeRecord(i))
    render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={records}
        pendingCount={5000}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))

    // Overflow reflects the TRUE queue size, not just the in-hand slice:
    // 5000 total − 100 shown = 4900 more.
    expect(await screen.findByText(/\+4900 more queued/i)).toBeInTheDocument()

    // The record list renders at most DISPLAY_CAP (100) rows.
    const list = screen.getByRole("list")
    const rows = within(list).getAllByRole("listitem")
    expect(rows.length).toBe(100)
  })

  it("shows no overflow note when everything fits", async () => {
    const records = Array.from({ length: 3 }, (_, i) => makeRecord(i))
    render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={records}
        pendingCount={3}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))

    const list = await screen.findByRole("list")
    expect(within(list).getAllByRole("listitem").length).toBe(3)
    expect(screen.queryByText(/more queued/i)).not.toBeInTheDocument()
  })
})
