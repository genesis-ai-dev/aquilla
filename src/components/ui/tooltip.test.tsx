import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Button } from "@/components/ui/button"
import { AppTooltip, TooltipProvider } from "@/components/ui/tooltip"

describe("AppTooltip", () => {
  it("honors an immediate per-tooltip delay override", async () => {
    render(
      <TooltipProvider delay={600}>
        <AppTooltip content="Deadline details" delay={0}>
          <button type="button">Deadline status</button>
        </AppTooltip>
      </TooltipProvider>,
    )

    const trigger = screen.getByRole("button", { name: "Deadline status" })
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("Deadline details")
    }, { timeout: 250 })
    expect(screen.getByRole("tooltip").closest("[data-side]")).toHaveAttribute(
      "data-side",
      "bottom",
    )
  })

  it("right-aligns the popup when align is end", async () => {
    render(
      <TooltipProvider delay={0}>
        <AppTooltip content="Refresh" side="bottom" align="end">
          <button type="button">Refresh</button>
        </AppTooltip>
      </TooltipProvider>,
    )

    const trigger = screen.getByRole("button", { name: "Refresh" })
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      expect(screen.getByRole("tooltip").closest("[data-align]")).toHaveAttribute("data-align", "end")
    })
  })

  it("keeps the trigger mounted when disabled toggles (popover-anchor stability)", () => {
    const { rerender } = render(
      <TooltipProvider delay={0}>
        <AppTooltip content="Summary" disabled={false}>
          <button type="button" data-testid="anchor">Ring</button>
        </AppTooltip>
      </TooltipProvider>,
    )
    const before = screen.getByTestId("anchor")
    rerender(
      <TooltipProvider delay={0}>
        <AppTooltip content="Summary" disabled>
          <button type="button" data-testid="anchor">Ring</button>
        </AppTooltip>
      </TooltipProvider>,
    )
    // Early-returning children on disable remounted PopoverTriggers and flashed
    // anchored popovers at (0,0). disabled must pass through without remount.
    expect(screen.getByTestId("anchor")).toBe(before)
  })

  /**
   * AQU-959 — a greyed-out control must still say why.
   *
   * These assertions are deliberately STRUCTURAL. happy-dom dispatches pointer
   * events on disabled elements, so a hover-based test passes against the very
   * bug it is meant to catch: in a real browser a `disabled` element fires no
   * pointer events (and `buttonVariants` adds `disabled:pointer-events-none`),
   * so a disabled trigger's tooltip never opens. What has to hold is that the
   * element carrying the tooltip's listeners is NOT the disabled control.
   */
  describe("a natively-disabled trigger (AQU-959)", () => {
    function renderDisabled(extra?: { disabledTriggerClassName?: string }) {
      render(
        <TooltipProvider delay={0}>
          <AppTooltip
            content="Contributors cannot perform this action — you need at least Maintainer access."
            disabledTriggerClassName={extra?.disabledTriggerClassName}
          >
            <Button type="button" className="w-full" disabled>
              New voice
            </Button>
          </AppTooltip>
        </TooltipProvider>,
      )
      return screen.getByRole("button", { name: "New voice" })
    }

    it("hands the tooltip a stand-in trigger instead of the disabled control", () => {
      const button = renderDisabled()
      // The control itself keeps its native semantics — not clickable.
      expect(button).toBeDisabled()

      const standIn = document.querySelector('[data-slot="tooltip-disabled-trigger"]')
      expect(standIn).not.toBeNull()
      // The listeners must sit on something that can actually receive events.
      expect(standIn).not.toHaveAttribute("disabled")
      expect(standIn).toContainElement(button)
    })

    it("keeps the explanation reachable by keyboard (a disabled button takes no focus)", () => {
      renderDisabled()
      expect(document.querySelector('[data-slot="tooltip-disabled-trigger"]')).toHaveAttribute(
        "tabindex",
        "0",
      )
    })

    it("echoes the child's width onto the stand-in so layout is unchanged", () => {
      renderDisabled({ disabledTriggerClassName: "w-full" })
      // Without this the `w-full` button resolves against a shrink-to-fit span.
      expect(document.querySelector('[data-slot="tooltip-disabled-trigger"]')).toHaveClass(
        "inline-flex",
        "w-full",
      )
    })

    it("opens on the stand-in trigger, carrying the reason", async () => {
      renderDisabled()
      const standIn = document.querySelector('[data-slot="tooltip-disabled-trigger"]')!
      fireEvent.pointerEnter(standIn, { pointerType: "mouse" })
      fireEvent.mouseEnter(standIn)

      await waitFor(() => {
        expect(screen.getByRole("tooltip")).toHaveTextContent(/at least Maintainer access/)
      })
    })

    /**
     * The control turning enabled or disabled while on screen swaps the
     * element the tooltip is attached to: the stand-in span one moment, the
     * button the next. Base UI binds its hover listeners to the trigger
     * element ONCE, when the trigger mounts, so after the swap they stayed on
     * the old element and hover never opened the tooltip again; focus still
     * did, because focus handlers are React props on whatever is rendered.
     *
     * Live: select rows with the row checkboxes starting on a line "Validate
     * text" cannot take (it renders disabled), shift-click to a line it can
     * (it turns enabled) — and hovering the button showed nothing.
     */
    describe("when the control turns enabled or disabled after mounting", () => {
      const tip = "Validate 3 of 10 selected cells"
      function Bar({ disabled }: { disabled: boolean }) {
        return (
          <TooltipProvider delay={0}>
            <AppTooltip content={tip}>
              <Button type="button" disabled={disabled}>Validate text</Button>
            </AppTooltip>
          </TooltipProvider>
        )
      }

      it("opens on hover after a disabled control becomes enabled", async () => {
        const { rerender } = render(<Bar disabled />)
        rerender(<Bar disabled={false} />)
        const button = screen.getByRole("button", { name: "Validate text" })
        expect(document.querySelector('[data-slot="tooltip-disabled-trigger"]')).toBeNull()
        fireEvent.pointerEnter(button, { pointerType: "mouse" })
        fireEvent.mouseEnter(button)

        await waitFor(() => {
          expect(screen.getByRole("tooltip")).toHaveTextContent(tip)
        }, { timeout: 500 })
      })

      it("opens on hover after an enabled control becomes disabled", async () => {
        const { rerender } = render(<Bar disabled={false} />)
        rerender(<Bar disabled />)
        const standIn = document.querySelector('[data-slot="tooltip-disabled-trigger"]')!
        expect(standIn).not.toBeNull()
        fireEvent.pointerEnter(standIn, { pointerType: "mouse" })
        fireEvent.mouseEnter(standIn)

        await waitFor(() => {
          expect(screen.getByRole("tooltip")).toHaveTextContent(tip)
        }, { timeout: 500 })
      })
    })

    it("does NOT wrap an enabled trigger — no extra tab stop, no layout shim", () => {
      render(
        <TooltipProvider delay={0}>
          <AppTooltip content="Add a voice">
            <Button type="button">New voice</Button>
          </AppTooltip>
        </TooltipProvider>,
      )
      expect(document.querySelector('[data-slot="tooltip-disabled-trigger"]')).toBeNull()
    })
  })
})
