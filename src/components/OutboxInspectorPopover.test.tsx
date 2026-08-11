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

describe("OutboxInspectorPopover queue summary (AQU-511)", () => {
  it("states each pending count exactly once", async () => {
    render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={Array.from({ length: 3 }, (_, i) => makeRecord(i))}
        pendingCount={3}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))

    // Asserted on the region's full text, not via getByText: the count sits in
    // its own styled child span, and the default matcher only sees an element's
    // direct text nodes.
    //
    // The count has that styled span, so the noun key must not interpolate it as
    // well. String extraction briefly swapped the bare noun for a
    // "{count} {noun}" template while leaving the span in place, rendering
    // "3 3 text edits" — an unexplainable number in the one surface whose whole
    // job is telling the user what is still unsaved.
    const summary = await screen.findByLabelText("Pending changes")
    expect(summary.textContent).toContain("3 edits")
    expect(summary.textContent).not.toContain("3 3 edits")
  })

  it("uses the singular noun for a queue of one", async () => {
    render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={[makeRecord(0)]}
        pendingCount={1}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))
    const summary = await screen.findByLabelText("Pending changes")
    // The noun is count-governed (`nav.outbox.editsNoun`), not chosen by a
    // `count === 1` branch at the call site, so the count has to reach `t()` even
    // though the string interpolates nothing — that argument is what selects the
    // form. Drop it and every queue reads "1 edits", in every locale.
    expect(summary.textContent).toContain("1 edit")
    expect(summary.textContent).not.toContain("1 edits")
  })
})

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

// ── SUB-9: failed (quarantined) records render with their reason + actions ──

function makeFailedRecord(i: number, reason = "self-validation is not allowed on this project"): OutboxRecord {
  return {
    ...makeRecord(i),
    id: `fail-${i}`,
    event: { ...makeRecord(i).event, id: `fail-${i}`, kind: "cell.validate", payload: { editEventId: "e1" } },
    attempts: 1,
    lastAttemptAt: 2_000 + i,
    lastError: { status: 403, reason },
    status: "failed",
  } as unknown as OutboxRecord
}

describe("OutboxInspectorPopover failed records (SUB-9)", () => {
  it("renders a quarantined record with Retry and Discard instead of claiming all-caught-up", async () => {
    render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={[makeFailedRecord(1)]}
        pendingCount={0}
        onRetryNow={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))

    // No "caught up" lie while a refusal exists.
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^All synced$/)).not.toBeInTheDocument()
    // Header counts the refusal as failed, not pending.
    expect(await screen.findByText(/1 failed/i)).toBeInTheDocument()
    // The row is present; per-row actions live behind the row's expander.
    const list = screen.getByRole("list")
    const rows = within(list).getAllByRole("listitem")
    expect(rows.length).toBe(1)
    fireEvent.click(within(rows[0]).getAllByRole("button")[0]) // expand the row
    expect(await within(rows[0]).findByText(/self-validation/)).toBeInTheDocument()
    expect(within(rows[0]).getByRole("button", { name: /retry/i })).toBeInTheDocument()
    expect(within(rows[0]).getByRole("button", { name: /discard this change/i })).toBeInTheDocument()
  })

  it("counts mixed pending + failed separately in the header", async () => {
    render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={[makeRecord(1), makeRecord(2), makeFailedRecord(3)]}
        pendingCount={2}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))
    expect(await screen.findByText(/2 pending · 1 failed/i)).toBeInTheDocument()
  })
})
