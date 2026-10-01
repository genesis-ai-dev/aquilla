/**
 * Test helper for picking an option out of a Base UI `Combobox` that is opened
 * from a trigger and searched from an input inside its popup — the shape every
 * searchable picker in this app uses (LaneCombobox, OrgSwitcher,
 * ProjectCombobox).
 *
 * Activation has the same pointer-sequence contract as `Select` (see
 * test-utils/select.tsx, AQU-1202): `ComboboxItem` guards its commit on a
 * click that actually *started* on the item, so a synthetic `click` with no
 * preceding `pointerdown` is dropped. Drive the option the way a mouse does.
 */
import { expect } from "vitest"
import { screen, waitFor, fireEvent } from "@testing-library/react"

/** Open the picker named `triggerName` and return its search input. */
export async function openCombobox(
  triggerName: RegExp | string,
  searchName: RegExp | string,
): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }))
  return await screen.findByRole("combobox", { name: searchName })
}

/**
 * Open the picker named `triggerName` and pick the option named `optionName`,
 * optionally narrowing the list by typing `search` first.
 *
 * Resolves once the popup has closed, which is how a single-value combobox
 * reports that the choice was committed. Returns the trigger so callers can
 * assert on the label it now renders.
 */
export async function pickComboboxOption(
  triggerName: RegExp | string,
  optionName: RegExp | string,
  options: { search?: string; searchName?: RegExp | string } = {},
): Promise<HTMLElement> {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)

  if (options.search !== undefined) {
    const searchName = options.searchName ?? /search/i
    const input = await screen.findByRole("combobox", { name: searchName })
    fireEvent.change(input, { target: { value: options.search } })
  }

  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerEnter(option, { pointerType: "mouse" })
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
  fireEvent.click(option, { detail: 1 })

  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())

  return trigger
}
