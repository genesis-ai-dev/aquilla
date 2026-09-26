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
 * ⚠️ AQU-959 — this helper cannot prove a *disabled* control explains itself.
 * happy-dom dispatches pointer events on disabled elements; a real browser does
 * not, and `buttonVariants` adds `disabled:pointer-events-none` on top. So
 * hovering a disabled trigger opens the tooltip here and stays silent in
 * production — which is exactly how a partner met a dead "New voice" mid-demo
 * while this helper reported the tooltip reachable. `AppTooltip` now wraps a
 * natively-disabled child in a focusable, non-disabled stand-in trigger; assert
 * THAT (`[data-slot="tooltip-disabled-trigger"]`, and that the trigger is not
 * itself `[disabled]`), because asserting the hover is a false green.
 */
export async function expectTooltip(trigger: Element, expected: string | RegExp) {
  // Await the complete browser hover sequence (pointerover/enter/move plus
  // mouseover/enter/move) inside React's async boundary. Manually firing only
  // the two enter events intermittently left Base UI's delay group unopened
  // when the full Cloudflare suite was under load (AQU-824).
  await userEvent.setup().hover(trigger)
  await waitFor(() => {
    const text = stripBidiControls(screen.getByRole("tooltip").textContent ?? "")
    if (typeof expected === "string") expect(text).toContain(expected)
    else expect(text).toMatch(expected)
  })
}

/**
 * Drop Unicode bidi controls before comparing tooltip text.
 *
 * Tooltips that interpolate a number into translated prose wrap it in isolates
 * (`bidiIsolate` in `@/lib/i18n/format`) so Arabic's bidi algorithm cannot drag
 * the digits out of place. Those are zero-width formatting characters: they
 * change nothing a reader sees, so a test asserting the visible sentence should
 * not have to spell them out — and every such assertion would otherwise break
 * the moment a string gains isolation.
 */
function stripBidiControls(s: string): string {
  return s.replace(/[⁦-⁩‎‏؜]/g, "")
}
