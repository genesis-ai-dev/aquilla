import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { I18nProvider, useT } from "./I18nProvider"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { readStoredLocale } from "./store"

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

  it("switching to an RTL locale mirrors <html dir> and persists the choice", () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ar" } })
    expect(document.documentElement.dir).toBe("rtl")
    expect(document.documentElement.lang).toBe("ar")
    expect(readStoredLocale()).toBe("ar")
  })

  it("an untranslated locale still shows English text, never a raw key", () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "my" } })
    // `my` catalog is empty today → English fallback, not the key.
    expect(screen.getByTestId("label")).toHaveTextContent("Projects")
    expect(document.documentElement.dir).toBe("ltr")
  })
})
