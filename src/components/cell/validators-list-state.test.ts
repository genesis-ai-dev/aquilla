import { describe, expect, it } from "vitest"

import { nextValidatorsListState } from "./validators-list-state"

const closed = { open: false, pinned: false, pressValidates: false, hasValidatorInfo: true }
const hoverOpen = { ...closed, open: true }
const pinned = { ...closed, open: true, pinned: true }

describe("nextValidatorsListState", () => {
  // The 2026-10-02 bug: hover opened the list and the next click closed it.
  it("refuses a click's close and pins the list instead", () => {
    expect(nextValidatorsListState({ open: false, reason: "trigger-press" }, hoverOpen))
      .toEqual({ cancel: true, open: true, pinned: true })
    expect(nextValidatorsListState({ open: false, reason: "trigger-press" }, pinned))
      .toEqual({ cancel: true, open: true, pinned: true })
  })

  it("keeps a pinned list open when the pointer leaves", () => {
    expect(nextValidatorsListState({ open: false, reason: "trigger-hover" }, pinned))
      .toEqual({ cancel: true, open: true, pinned: true })
  })

  it("lets an unpinned, hover-opened list close when the pointer leaves", () => {
    expect(nextValidatorsListState({ open: false, reason: "trigger-hover" }, hoverOpen))
      .toEqual({ cancel: false, open: false, pinned: false })
  })

  it.each(["escape-key", "outside-press", "focus-out", "close-press", "imperative-action"])(
    "closes and unpins on %s",
    (reason) => {
      expect(nextValidatorsListState({ open: false, reason }, pinned))
        .toEqual({ cancel: false, open: false, pinned: false })
    },
  )

  it("opens and pins on a click or key press", () => {
    for (const reason of ["trigger-press", "keyboard"]) {
      expect(nextValidatorsListState({ open: true, reason }, closed))
        .toEqual({ cancel: false, open: true, pinned: true })
    }
  })

  // The button's own handler adds the vote; the list must not open over it.
  it("refuses to open when the press is a vote", () => {
    expect(nextValidatorsListState({ open: true, reason: "trigger-press" }, { ...closed, pressValidates: true }))
      .toEqual({ cancel: true, open: false, pinned: false })
  })

  it("opens on hover without pinning, and only when there is something to list", () => {
    expect(nextValidatorsListState({ open: true, reason: "trigger-hover" }, closed))
      .toEqual({ cancel: false, open: true, pinned: false })
    expect(nextValidatorsListState({ open: true, reason: "trigger-hover" }, { ...closed, hasValidatorInfo: false }))
      .toEqual({ cancel: true, open: false, pinned: false })
  })
})
