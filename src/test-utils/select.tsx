/**
 * Test helper for picking an option out of a Base UI `Select`.
 *
 * Base UI renders the trigger as a `combobox` and portals the options into a
 * `listbox`, so a test has to open the popup and then activate an option in it.
 * How that activation must be driven is a contract of the library, and it
 * changed in `@base-ui/react` 1.7.0 (AQU-1202).
 *
 * `SelectItem` commits a choice from its `onClick` handler and guards that
 * handler with `isInvalidMouseClick`, which is true for a mouse click that did
 * not *start* on the item — `onPointerDown` is what sets the item's
 * `allowMouseSelection` ref. Up to 1.6.0 a keyboard activation escaped that
 * guard outright (`isMouseClick` was `event.type === 'click' && …`), so tests
 * could commit by highlighting an option and pressing Enter. In 1.7.0 the guard
 * is `isMouseClick = pointerTypeRef.current !== 'touch'`, so a synthetic Enter
 * with no pointer history now falls into the mouse-click branch and is dropped
 * as a click that never started on the item.
 *
 * The fix is to stop routing around the pointer sequence: drive the option the
 * way a real mouse does — `pointerdown` on the option, then `click`. That
 * satisfies the guard on both versions, and it does not depend on the internal
 * highlight state the old Enter path leaned on. `onMouseUp` deliberately
 * returns early while `allowMouseSelection` is set, so the sequence commits
 * exactly once.
 *
 * The Enter workaround this replaces carried a note that "clicks on options
 * don't commit when the select sits inside a modal Dialog". That diagnosis was
 * wrong: the Dialog was never the cause — a bare `click` with no preceding
 * `pointerdown` never set `allowMouseSelection`, so the guard dropped it. The
 * AssignModal picker, the case that note was written about, commits from a real
 * mouse click in a browser on both 1.6.0 and 1.7.0.
 */
import { expect } from "vitest"
import { screen, waitFor, fireEvent } from "@testing-library/react"

/**
 * Open the Select named `triggerName` and pick the option named `optionName`.
 *
 * Resolves once the popup has closed, which is how a single-value Select
 * reports that the choice was committed. Returns the trigger so callers can
 * assert on the label it now renders.
 */
export async function pickSelectOption(
  triggerName: RegExp | string,
  optionName: RegExp | string,
): Promise<HTMLElement> {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)

  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerEnter(option, { pointerType: "mouse" })
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
  fireEvent.click(option, { detail: 1 })

  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())

  return trigger
}
