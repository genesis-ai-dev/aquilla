import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { Concept } from "@/lib/terminology/types"
import { mergeConcepts } from "@/lib/terminology/store"
import type { ProjectRecord } from "@/lib/parsers/types"
import { TerminologyMergeDialog } from "./TerminologyMergeDialog"

function concept(p: Partial<Concept>): Concept {
  return {
    id: "c1",
    sourceTerm: "grace",
    renderings: [{ rendering: "favor", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...p,
  }
}

const CONCEPTS: Concept[] = [
  concept({ id: "c1", notes: "from list A" }),
  concept({
    id: "c2",
    renderings: [
      { rendering: "Favor", status: "admitted" },
      { rendering: "mercy", status: "forbidden" },
    ],
    notes: "from list B",
  }),
  concept({ id: "c3", sourceTerm: "wrath", renderings: [], notes: "from list A" }),
]

function renderDialog(onMerge = vi.fn(async (_mergeIds: string[], _survivorId: string) => {})) {
  const onOpenChange = vi.fn()
  render(
    <TerminologyMergeDialog open onOpenChange={onOpenChange} concepts={CONCEPTS} onMerge={onMerge} />,
  )
  const dialog = screen.getByRole("dialog")
  const rows = within(dialog).getAllByTestId("merge-concept-row")
  return { dialog, rows, onMerge, onOpenChange }
}

describe("TerminologyMergeDialog (AQU-1337)", () => {
  it("lists every concept and keeps Preview merge off until two are selected (T-27)", () => {
    const { dialog, rows } = renderDialog()
    expect(rows).toHaveLength(3)
    const preview = within(dialog).getByRole("button", { name: "Preview merge" })

    expect(preview).toBeDisabled()
    fireEvent.click(rows[0])
    expect(preview).toBeDisabled()
    fireEvent.click(rows[1])
    expect(preview).toBeEnabled()
    // Deselecting drops back below the minimum.
    fireEvent.click(rows[1])
    expect(preview).toBeDisabled()
  })

  it("makes the FIRST selected concept the survivor, whatever its list position", async () => {
    const { dialog, rows, onMerge } = renderDialog()

    fireEvent.click(rows[1])
    fireEvent.click(rows[0])
    expect(within(rows[1]).getByText("survivor")).toBeInTheDocument()
    expect(within(rows[0]).queryByText("survivor")).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole("button", { name: "Preview merge" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm merge" }))

    await waitFor(() => expect(onMerge).toHaveBeenCalledWith(["c2", "c1"], "c2"))
  })

  it("promotes the next selection to survivor when the survivor is deselected", () => {
    const { rows } = renderDialog()

    fireEvent.click(rows[0])
    fireEvent.click(rows[2])
    fireEvent.click(rows[0])

    expect(within(rows[2]).getByText("survivor")).toBeInTheDocument()
  })

  it("previews exactly what mergeConcepts will write", () => {
    const { dialog, rows } = renderDialog()
    fireEvent.click(rows[0])
    fireEvent.click(rows[1])
    fireEvent.click(rows[2])
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview merge" }))

    const merged = mergeConcepts(
      { id: "p1", terminology: CONCEPTS } as unknown as ProjectRecord,
      ["c1", "c2", "c3"],
      "c1",
    ).terminology?.find((c) => c.id === "c1")
    // Case-insensitive union with the survivor's entry winning; notes deduped.
    expect(merged?.renderings.map((r) => r.rendering)).toEqual(["favor", "mercy"])
    expect(merged?.notes).toBe("from list A | from list B")

    const preview = within(dialog).getByTestId("merge-preview")
    for (const r of merged?.renderings ?? []) {
      expect(within(preview).getByText(r.rendering)).toBeInTheDocument()
    }
    expect(within(preview).queryByText("Favor")).not.toBeInTheDocument()
    expect(within(preview).getByText("from list A | from list B")).toBeInTheDocument()
    // Both losers are named as removals; the survivor heads the card.
    expect(within(preview).getAllByText("grace")).toHaveLength(2)
    expect(within(preview).getByText("wrath")).toBeInTheDocument()
  })

  it("goes back to the selection with the picks intact", () => {
    const { dialog, rows } = renderDialog()
    fireEvent.click(rows[0])
    fireEvent.click(rows[1])
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview merge" }))

    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }))

    expect(within(dialog).getByRole("button", { name: "Preview merge" })).toBeEnabled()
    expect(within(dialog).getAllByText("survivor")).toHaveLength(1)
  })

  it("closes after a successful merge", async () => {
    const { dialog, rows, onOpenChange } = renderDialog()
    fireEvent.click(rows[0])
    fireEvent.click(rows[1])
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview merge" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm merge" }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("stays open with the failure when the merge is rejected, and lets the user retry", async () => {
    const onMerge = vi.fn(async (_mergeIds: string[], _survivorId: string) => {})
    onMerge.mockRejectedValueOnce(new Error("Concept not found: c2"))
    const { dialog, rows, onOpenChange } = renderDialog(onMerge)
    fireEvent.click(rows[0])
    fireEvent.click(rows[1])
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview merge" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm merge" }))

    expect(await within(dialog).findByText("Concept not found: c2")).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()

    const confirm = within(dialog).getByRole("button", { name: "Confirm merge" })
    await waitFor(() => expect(confirm).toBeEnabled())
    fireEvent.click(confirm)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onMerge).toHaveBeenCalledTimes(2)
  })
})
