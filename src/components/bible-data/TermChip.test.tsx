/**
 * AQU-1700 — a key term's title in a Chinese interface.
 *
 * Pack 1.2.0 keys Chinese by script: `cmn` is Traditional (Translation
 * Words' `zht` titles), `cmn-Hans` Simplified. What this protects: a
 * Simplified Chinese reader gets the Simplified title when the pack has one,
 * and otherwise the Traditional title, said to be in Traditional characters
 * and marked `zh-Hant` so the browser draws it with Traditional glyphs. A
 * Traditional reader gets the Traditional title as their own script.
 * The term is real pack data: tw:forsaken, on עָזְבֵךְ in RUT 1:16.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { TermChip } from "./TermChip"
import { rutTerms } from "@/lib/bible-data/__fixtures__/ot-pack12"
import type { BkpTerm } from "@/lib/bible-data/pack-types"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"
import { resetBibleDataViewPrefsCacheForTests } from "@/lib/store/bible-data-view-prefs"

const forsaken = rutTerms().terms["tw:forsaken"]

function renderChip(locale: string, term: BkpTerm): HTMLElement {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  render(
    <I18nProvider>
      <TermChip term={{ id: "tw:forsaken", term }} />
    </I18nProvider>,
  )
  return screen.getByTestId("term-chip")
}

/** The chip's title, as shown, with its language. */
function titleOf(chip: HTMLElement): { text: string | null; lang: string | null } {
  const span = chip.querySelector("[lang]")
  return { text: span?.textContent ?? null, lang: span?.getAttribute("lang") ?? null }
}

async function openDetails(chip: HTMLElement): Promise<HTMLElement> {
  act(() => chip.focus())
  return screen.findByTestId("term-details")
}

beforeEach(() => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
})

afterEach(() => {
  cleanup()
})

describe("a key term's title in Chinese", () => {
  it("gives a Simplified interface the Traditional title when that is all the pack has, and says so", async () => {
    expect(forsaken.titles).not.toHaveProperty("cmn-Hans")
    const chip = renderChip("zh-Hans", forsaken)
    expect(titleOf(chip)).toEqual({ text: forsaken.titles?.cmn, lang: "zh-Hant" })
    const details = await openDetails(chip)
    expect(screen.getByTestId("term-other-script")).toBeTruthy()
    expect(details.querySelector("[lang]")?.getAttribute("lang")).toBe("zh-Hant")
  })

  it("prefers the Simplified title for a Simplified interface, with no note", async () => {
    const chip = renderChip("zh-Hans", { ...forsaken, titles: { ...forsaken.titles, "cmn-Hans": "离弃" } })
    expect(titleOf(chip)).toEqual({ text: "离弃", lang: "zh-Hans" })
    await openDetails(chip)
    expect(screen.queryByTestId("term-other-script")).toBeNull()
  })

  it("gives a Traditional interface the Traditional title as its own script", async () => {
    const chip = renderChip("zh-Hant", { ...forsaken, titles: { ...forsaken.titles, "cmn-Hans": "离弃" } })
    expect(titleOf(chip)).toEqual({ text: forsaken.titles?.cmn, lang: "zh-Hant" })
    await openDetails(chip)
    expect(screen.queryByTestId("term-other-script")).toBeNull()
  })
})
