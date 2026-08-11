import { describe, it, expect, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider, useT } from "./I18nProvider"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { readStoredLocale } from "./store"

/**
 * Drive the real switcher: open the globe menu, then choose a locale by its
 * endonym. Endonym rather than code on purpose — that is what a speaker of the
 * language actually sees and scans for.
 */
async function pickLanguage(endonym: string) {
  await userEvent.click(screen.getByRole("button", { name: "Language" }))
  await userEvent.click(
    // Regex: the item's accessible name is "Switch language to <endonym>",
    // so match on the endonym rather than pinning the whole phrase.
    await screen.findByRole("menuitemradio", { name: new RegExp(endonym) }),
  )
}

function Probe() {
  const t = useT()
  return <span data-testid="label">{t("nav.projects")}</span>
}

function Harness() {
  return (
    <I18nProvider>
      <LanguageSwitcher />
      <Probe />
    </I18nProvider>
  )
}

describe("I18nProvider + LanguageSwitcher", () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute("dir")
    document.documentElement.removeAttribute("lang")
  })

  it("defaults to English / LTR and renders translated chrome via t()", () => {
    render(<Harness />)
    expect(screen.getByTestId("label")).toHaveTextContent("Projects")
    expect(document.documentElement.lang).toBe("en")
    expect(document.documentElement.dir).toBe("ltr")
  })

  it("switching to an RTL locale mirrors <html dir> and persists the choice", async () => {
    render(<Harness />)
    await pickLanguage("العربية")
    expect(document.documentElement.dir).toBe("rtl")
    expect(document.documentElement.lang).toBe("ar")
    expect(readStoredLocale()).toBe("ar")
  })

  it("an untranslated locale still shows English text, never a raw key", async () => {
    render(<Harness />)
    await pickLanguage("မြန်မာ")
    // `my` catalog is empty today → English fallback, not the key.
    expect(screen.getByTestId("label")).toHaveTextContent("Projects")
    expect(document.documentElement.dir).toBe("ltr")
  })

  it("resolves English with no provider mounted, instead of throwing", () => {
    // ~240 components are about to call t(), and most of their existing test
    // files never mount a provider — nor do the prerendered marketing entries,
    // by design. Throwing there would buy nothing: English is already the
    // documented per-key fallback, so a provider-less read gives the same answer.
    render(<Probe />)
    expect(screen.getByTestId("label")).toHaveTextContent("Projects")
  })

  it("does not mutate <html> when no provider is mounted", () => {
    // The fallback must stay inert: a provider-less render is usually a test or
    // a prerender pass, and neither should be reaching into the document.
    render(<Probe />)
    expect(document.documentElement.getAttribute("lang")).toBeNull()
    expect(document.documentElement.getAttribute("dir")).toBeNull()
  })
})
