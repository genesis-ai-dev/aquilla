// A step's name, as the History panel, the Undo and Redo tooltips and the
// toasts say it. The history follows the person to their other devices, which
// may run another version of the app, so a step can name a message this
// version doesn't have.
import { describe, expect, it } from "vitest"
import { translate } from "@/lib/i18n/translate"
import { en } from "@/lib/i18n/messages/en"
import { stepLabel } from "./step-label"

const t = (key: string, params?: Record<string, string | number>) => translate(en, key as never, params)

describe("a step's name", () => {
  it("reads a step this version knows, with its parts", () => {
    expect(stepLabel(t as never, { labelKey: "editor.history.stepAddRow" })).toBe("Add row")
  })

  it("names a step a newer version recorded, instead of failing", () => {
    expect(stepLabel(t as never, { labelKey: "editor.history.stepFromALaterVersion" })).toBe(
      "A change made in a newer version of Aquilla",
    )
  })

  it("names a newer version's step that carries parts, instead of failing", () => {
    expect(stepLabel(t as never, { labelKey: "editor.history.stepFromALaterVersion", labelParams: { count: 3 } })).toBe(
      "A change made in a newer version of Aquilla",
    )
  })
})
