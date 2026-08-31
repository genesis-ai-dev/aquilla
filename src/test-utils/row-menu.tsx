/**
 * Test helper for the ⋯ row-actions menu (`DataTableRowActionsButton`).
 *
 * The ⋯ button is a real Base UI menu trigger, and Base UI wires a trigger to
 * its popup in a post-mount effect: until that effect has flushed, the button
 * is in the DOM and findable by role, but it carries no `aria-expanded` and a
 * click on it is simply dropped — it is not queued and replayed once the menu
 * root catches up.
 *
 * A table whose rows arrive from an awaited fetch lands the row and that effect
 * on different ticks, so a test that clicks the ⋯ button on the first tick after
 * the row appears is racing the wiring. Which side wins depends on how many
 * microtasks the preceding query happened to burn — `findByTestId` on the
 * surrounding panel resolves a tick earlier than `findByText` on the row, so the
 * same assertion passed or failed depending on how the test waited (AQU-1045).
 *
 * `openRowMenu` waits for the documented trigger contract (`aria-expanded`,
 * which the button only carries once Base UI owns it) before pressing, then
 * waits for the menu to actually report itself open. Assertions then depend on
 * the menu opening, never on elapsed time.
 */
import { expect } from "vitest"
import { screen, waitFor, fireEvent } from "@testing-library/react"

/**
 * Open a row's ⋯ menu by its accessible name and resolve once it is open.
 *
 * Returns the trigger so callers can assert on its open chrome.
 */
export async function openRowMenu(triggerName: string): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: triggerName })

  // Present only once Base UI has adopted the button as its trigger.
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"))

  fireEvent.click(trigger)
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"))

  return trigger
}
