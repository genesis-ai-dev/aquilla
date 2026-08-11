/**
 * Test helpers for AppTooltip-based labels.
 *
 * The shadcn/base-ui migration moved descriptive hover text off the native
 * `title` attribute and onto AppTooltip, which portals its content and only
 * mounts it once the trigger is hovered. Two consequences for unit tests:
 *
 *   1. `getByTitle()` / `toHaveAttribute("title", …)` no longer see the text —
 *      AppTooltip deliberately strips `title` so the browser's own tooltip
 *      can't compete with ours.
 *   2. AppTooltip's delayed open needs a TooltipProvider ancestor. App.tsx
 *      mounts one around the whole tree, so a component rendered bare in a
 *      test has no provider and the tooltip never opens.
 *
 * `renderWithTooltips` supplies the provider with `delay={0}` so assertions
 * depend on the tooltip opening, never on elapsed time.
 */
import { expect } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"

/** `render()` with the TooltipProvider that App.tsx mounts in production. */
export function renderWithTooltips(ui: ReactElement) {
  return render(<TooltipProvider delay={0}>{ui}</TooltipProvider>)
}

/**
 * Hover `trigger` and assert the tooltip that opens carries `expected`.
 *
 * base-ui opens the tooltip even for a `disabled` trigger, which is what keeps
 * a gated control's "why is this disabled?" explanation reachable.
 */
export async function expectTooltip(trigger: Element, expected: string | RegExp) {
  // Await the complete browser hover sequence (pointerover/enter/move plus
  // mouseover/enter/move) inside React's async boundary. Manually firing only
  // the two enter events intermittently left Base UI's delay group unopened
  // when the full Cloudflare suite was under load (AQU-824).
  await userEvent.setup().hover(trigger)
  await waitFor(() => {
    expect(screen.getByRole("tooltip")).toHaveTextContent(expected)
  })
}
