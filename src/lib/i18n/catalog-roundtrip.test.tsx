import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CellData } from "@/hooks/useCells"
import { extractJsonStrings, exportJson } from "@/lib/parsers/json-i18n"
import { I18nProvider, useT } from "./I18nProvider"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { buildCatalogSourceJson, parseTranslatedCatalog } from "./catalog-export"
import { CATALOGS } from "./messages"
import type { Catalog } from "./messages/en"

/** Open the globe menu and choose a locale by its endonym, as a user would. */
async function pickLanguage(endonym: string) {
  await userEvent.click(screen.getByRole("button", { name: "Language" }))
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: new RegExp(endonym) }),
  )
}

/**
 * AQU-832 — the loop, end to end and on screen.
 *
 * `catalog-export.test.ts` proves the data round-trips; this proves the result
 * is what the app renders. The catalog here is not hand-written: it is produced
 * by exporting the en catalog, importing it through the real JSON i18n parser,
 * "translating" the cells, and exporting them back — the same path a translator
 * working in an Aquilla project takes. Then it is rendered through the real
 * AQU-511 `I18nProvider` and selected with the real `LanguageSwitcher`.
 */

const ACCENTS: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú" }

function pseudo(source: string): string {
  const body = source
    .split(/(\{\w+\})/g)
    .map((part) =>
      part.startsWith("{") ? part : part.replace(/[aeiou]/g, (c) => ACCENTS[c]),
    )
    .join("")
  return `⟦${body}⟧`
}

function makeCell(original: string, translated: string, context: string): CellData {
  return {
    id: `cell-${context}`,
    fileId: "en-catalog",
    original,
    translated,
    context,
    group: context,
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

/** Run the full export → import → translate → export loop, as the app would. */
async function translateCatalogInAquilla(): Promise<Catalog> {
  const source = buildCatalogSourceJson()
  const cells = extractJsonStrings(source).map((s) =>
    makeCell(s.original, pseudo(s.original), s.context),
  )
  const translatedJson = await exportJson(source, cells, { keyed: true }).text()
  return parseTranslatedCatalog(translatedJson).catalog
}

function Probe() {
  const t = useT()
  return (
    <>
      <span data-testid="nav">{t("nav.projects")}</span>
      <span data-testid="switch">{t("language.switchTo", { language: "ไทย" })}</span>
    </>
  )
}

function Harness() {
  return (
    <I18nProvider>
      <LanguageSwitcher />
      <Probe />
    </I18nProvider>
  )
}

describe("round-tripped catalog renders through the language switcher", () => {
  let original: Catalog

  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute("dir")
    document.documentElement.removeAttribute("lang")
    original = CATALOGS.th
  })

  afterEach(() => {
    CATALOGS.th = original
  })

  it("shows the translated strings after selecting the locale", async () => {
    // Ship the round-tripped catalog exactly as `scripts/i18n-catalog.ts import`
    // would, by writing it into the registry the provider reads.
    CATALOGS.th = await translateCatalogInAquilla()

    render(<Harness />)
    expect(screen.getByTestId("nav")).toHaveTextContent("Projects")

    await pickLanguage("ไทย")

    expect(screen.getByTestId("nav")).toHaveTextContent("⟦Prójécts⟧")
    expect(document.documentElement.lang).toBe("th")
  })

  it("interpolates placeholders that survived the round-trip", async () => {
    CATALOGS.th = await translateCatalogInAquilla()

    render(<Harness />)
    await pickLanguage("ไทย")

    // The `{language}` placeholder came back intact and was filled at render.
    expect(screen.getByTestId("switch")).toHaveTextContent("⟦Swítch lángúágé tó ไทย⟧")
  })

  it("falls back to English for keys the round-trip left untranslated", async () => {
    const partial = await translateCatalogInAquilla()
    delete partial["nav.projects"]
    CATALOGS.th = partial

    render(<Harness />)
    await pickLanguage("ไทย")

    expect(screen.getByTestId("nav")).toHaveTextContent("Projects")
    expect(screen.getByTestId("switch")).toHaveTextContent("⟦Swítch lángúágé tó ไทย⟧")
  })
})
