// AQU-2090. WHY: only English ships with the app now, and another language's
// text is fetched the first time someone picks it. On a slow connection that
// takes a moment, and the UI must stay in the language it is in until the new
// one arrives. Showing English in between would flash a third language at
// someone who reads neither of the other two.
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider, useT } from "./I18nProvider"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { answerFromCatalogsForTests } from "./messages"
import { CATALOGS } from "./messages/all"
import { LOCALE_STORAGE_KEY } from "./store"

const download = vi.hoisted(() => ({ held: null as Promise<void> | null }))
// The real catalog store, with Russian's download held open while `held` is set.
vi.mock("./messages", async (importOriginal) => {
  const real = await importOriginal<typeof import("./messages")>()
  return {
    ...real,
    loadCatalog: async (locale: string) => {
      if (locale === "ru" && download.held) {
        await download.held
        const { CATALOGS: all } = await import("./messages/all")
        real.registerCatalog("ru", all.ru)
        return all.ru
      }
      return real.loadCatalog(locale)
    },
  }
})

function Probe() {
  return <span data-testid="label">{useT()("nav.projects")}</span>
}

afterEach(() => {
  answerFromCatalogsForTests(CATALOGS)
  window.localStorage.clear()
  download.held = null
})

describe("I18nProvider — picking a language not yet downloaded (AQU-2090)", () => {
  it("stays in the current language until the new one arrives, never English in between", async () => {
    // French is here; Russian is not.
    answerFromCatalogsForTests({ en: CATALOGS.en, fr: CATALOGS.fr })
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr")
    let release!: () => void
    download.held = new Promise<void>((resolve) => { release = resolve })

    render(<I18nProvider><LanguageSwitcher /><Probe /></I18nProvider>)
    const french = String(CATALOGS.fr["nav.projects"])
    const russian = String(CATALOGS.ru["nav.projects"])
    expect(screen.getByTestId("label")).toHaveTextContent(french)

    await userEvent.click(screen.getAllByRole("button")[0]!)
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Русский/ }))
    expect(screen.getByTestId("label")).toHaveTextContent(french)
    expect(document.documentElement.lang).toBe("fr")

    await act(async () => { release() })
    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent(russian))
    expect(document.documentElement.lang).toBe("ru")
  })
})
