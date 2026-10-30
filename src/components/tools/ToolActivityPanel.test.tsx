// AQU-2260 (Sam, Oct 29): "Undo these changes" is a labelled button, so what
// it does (and that it skips cells edited since) is in an (i) beside it, opened
// on click; the button says nothing on hover.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import type { ToolSummary } from "@/lib/tools/tools-api"
import { ToolActivityPanel } from "./ToolActivityPanel"

vi.mock("@/context/OutboxContext", () => ({ useOutbox: () => ({ flushNow: vi.fn(async () => {}) }) }))
vi.mock("@/lib/tools/tools-api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/tools/tools-api")>()),
  fetchToolActivity: vi.fn(async () => ({ events: [], writes: [], cells: [], truncated: false })),
}))

const tool = { id: "t1", name: "Glossary" } as unknown as ToolSummary

describe("ToolActivityPanel undo", () => {
  it("explains Undo behind an (i), and the button says nothing on hover", async () => {
    renderWithTooltips(<ToolActivityPanel projectId="p1" tool={tool} jwt="jwt" author="anna" />)
    const undo = await screen.findByRole("button", { name: /^Undo these changes$/ })
    await userEvent.setup().hover(undo.closest('[data-slot="tooltip-disabled-trigger"]') ?? undo)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("tooltip")).toBeNull()
    await expectClickNote(screen.getByRole("button", { name: "About Undo these changes" }), /Cells edited since by someone else are skipped/)
  })
})
