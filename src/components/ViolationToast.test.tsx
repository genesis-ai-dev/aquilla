import { afterEach, describe, expect, it, vi } from "vitest"
import { StrictMode, type ComponentProps } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ViolationToast } from "./ViolationToast"
import { Toaster, toast } from "@/components/ui/toast"
import type { RuleInfraction, RuleWaiver } from "@/lib/parsers/types"

const infraction: RuleInfraction = {
  ruleId: "r1",
  cellId: "c1",
  fileId: "f1",
  reason: "target-forbids",
  spans: [{ side: "target", start: 0, end: 3, matchedText: "bad" }],
}

const defaultProps = {
  open: true,
  infraction,
  ruleName: "No bad",
  waivers: [] as RuleWaiver[],
  onOpenChange: vi.fn(),
  onOpenRule: vi.fn(),
  onWaive: vi.fn(),
  onUnwaive: vi.fn(),
}

afterEach(() => {
  toast.close()
  vi.clearAllMocks()
})

function renderToast(
  props: Partial<ComponentProps<typeof ViolationToast>> = {},
) {
  return render(
    <>
      <Toaster />
      <ViolationToast {...defaultProps} {...props} />
    </>,
  )
}

describe("ViolationToast", () => {
  it("renders in the standard bottom-right toast viewport", async () => {
    renderToast()

    expect(await screen.findByText("No bad")).toBeInTheDocument()
    expect(screen.getByText(/forbidden pattern/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /waive/i })).toBeInTheDocument()
    expect(document.querySelector('[data-slot="toast-viewport"]')).toHaveClass(
      "bottom-4",
      "sm:right-4",
      "sm:left-auto",
    )
  })

  it("remains open when React replays effects in StrictMode", async () => {
    render(
      <StrictMode>
        <Toaster />
        <ViolationToast {...defaultProps} />
      </StrictMode>,
    )

    expect(await screen.findByText("No bad")).toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1)
    expect(defaultProps.onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("explains a missing terminology rendering in plain language", async () => {
    renderToast({
      infraction: {
        ...infraction,
        ruleId: "term:concept-1:approved",
        reason: "source-requires-target",
      },
      ruleName: "Term: grace",
    })

    expect(await screen.findByText("Term: grace")).toBeInTheDocument()
    expect(screen.getByText(
      "This term is in the source, but the translation doesn't use a required rendering",
    )).toBeInTheDocument()
  })

  it("explains a terminology count mismatch", async () => {
    renderToast({
      infraction: {
        ...infraction,
        ruleId: "term:concept-1:approved",
        reason: "source-requires-target",
        reasonParams: { sourceCount: "2", targetCount: "1" },
      },
      ruleName: "Term: grace",
    })

    expect(await screen.findByText(
      "This term doesn't add up: 2 in the source, 1 in the translation",
    )).toBeInTheDocument()
  })

  it("shows the waiver summary and Unwaive action", async () => {
    renderToast({
      waivers: [{
        ruleId: "r1",
        reason: "agreed",
        waivedAt: "2026-04-24T00:00:00Z",
      }],
    })

    expect(await screen.findByText(/Waived/)).toBeInTheDocument()
    expect(screen.getByText(/agreed/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /unwaive/i })).toBeInTheDocument()
  })

  it("waives the rule from the toast action", async () => {
    const onWaive = vi.fn()
    renderToast({ onWaive })

    await userEvent.click(await screen.findByRole("button", { name: /waive/i }))

    expect(onWaive).toHaveBeenCalledWith({ ruleId: "r1" })
    await waitFor(() => {
      expect(document.querySelector('[data-slot="toast"]')).toBeNull()
    })
  })

  it("opens the rule when its title is selected", async () => {
    const onOpenRule = vi.fn()
    renderToast({ onOpenRule })

    await userEvent.click(await screen.findByRole("button", { name: "No bad" }))

    expect(onOpenRule).toHaveBeenCalledWith("r1")
  })
})
