import { describe, it, expect } from "vitest"
import { render, screen, within, fireEvent } from "@testing-library/react"
import { OutboxInspectorPopover } from "./OutboxInspectorPopover"
import type { OutboxRecord } from "@/lib/sync/outbox"
import { nav } from "@/lib/i18n/namespaces/nav"
import { isPluralMessage } from "@/lib/i18n/plurals"

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

/** A record in a non-edit bucket of the summary. */
function makeKindRecord(i: number, kind: string): OutboxRecord {
  const base = makeRecord(i)
  return {
    ...base,
    id: `${kind}-${i}`,
    event: { ...base.event, kind, payload: {} },
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
    // The count is substituted into the sentence as a styled NODE, so the
    // sentence's own "{count}" is the only place it can appear. String
    // extraction once put a "{count} {noun}" template beside a hardcoded count
    // span, rendering "3 3 text edits" — an unexplainable number in the one
    // surface whose whole job is telling the user what is still unsaved.
    const summary = await screen.findByLabelText("Pending changes")
    expect(summary.textContent).toContain("3 edits")
    expect(summary.textContent).not.toContain("3 3 edits")
  })

  it("renders the count as a styled numeral inside the sentence", async () => {
    render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={Array.from({ length: 3 }, (_, i) => makeRecord(i))}
        pendingCount={3}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))
    const summary = await screen.findByLabelText("Pending changes")

    // Moving the count INTO the translated string (so the translator can place
    // the numeral) must not cost it its typography: a plain-text {count}
    // interpolation would read "3 edits" all in muted body weight, and the
    // digits would stop being tabular, so the summary jitters as counts change.
    // Assert the element, not just the text — the text passes either way.
    const numerals = summary.querySelectorAll("span.tabular-nums.font-medium")
    const edits = [...numerals].find((n) => n.textContent === "3")
    expect(edits, "the count 3 is not rendered by a styled numeral span").toBeTruthy()
  })

  it("puts the count placeholder in the string, so the translator orders it", () => {
    // The order fix, asserted on the catalog rather than on English output:
    // English happens to want numeral-then-noun, so no rendering of the English
    // string can distinguish "translator controls the order" from "JSX hardcodes
    // it". What distinguishes them is that the count is a {placeholder} in the
    // sentence — Burmese and Arabic move it, and a bare-noun key could not.
    for (const key of [
      "nav.outbox.summaryEdits",
      "nav.outbox.summaryValidations",
      "nav.outbox.summaryComments",
      "nav.outbox.summaryOther",
    ] as const) {
      const value = nav.keys[key]
      expect(isPluralMessage(value), `${key} must be count-governed`).toBe(true)
      if (!isPluralMessage(value)) continue
      for (const [category, form] of Object.entries(value.forms)) {
        expect(form, `${key}.${category} must contain {count}`).toContain("{count}")
      }
    }
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
    // The noun is count-governed (`nav.outbox.summaryEdits`), not chosen by a
    // `count === 1` branch at the call site: the number handed to `<RichMessage>`
    // selects the plural form. Drop it and every queue reads "1 edits", in every
    // locale — and Arabic, with six forms, cannot be served by a call-site branch
    // at all.
    expect(summary.textContent).toContain("1 edit")
    expect(summary.textContent).not.toContain("1 edits")
  })

  it("inflects the validation and catch-all nouns with their counts", async () => {
    // These two buckets were bare invariant nouns ("validation", "other"), so a
    // queue of three read "3 validation · 3 other" — ungrammatical in English and
    // untranslatable into a language that inflects after a numeral, because there
    // was no count-governed key for a translator to fill forms into.
    const { unmount } = render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={[
          ...Array.from({ length: 3 }, (_, i) => makeKindRecord(i, "cell.validate")),
          ...Array.from({ length: 3 }, (_, i) => makeKindRecord(i, "file.create")),
        ]}
        pendingCount={6}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))
    let summary = await screen.findByLabelText("Pending changes")
    expect(summary.textContent).toContain("3 validations")
    expect(summary.textContent).toContain("3 other changes")
    unmount()

    render(
      <OutboxInspectorPopover
        trigger={<button type="button">open inspector</button>}
        records={[makeKindRecord(0, "cell.unvalidate"), makeKindRecord(0, "file.create")]}
        pendingCount={2}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /open inspector/i }))
    summary = await screen.findByLabelText("Pending changes")
    expect(summary.textContent).toContain("1 validation")
    expect(summary.textContent).not.toContain("1 validations")
    expect(summary.textContent).toContain("1 other change")
    expect(summary.textContent).not.toContain("1 other changes")
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
