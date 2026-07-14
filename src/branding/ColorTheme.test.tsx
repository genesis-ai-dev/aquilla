import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { COLOR_THEMES, ColorThemeProvider } from "./ColorTheme"

// Regression guard for AQU-362: "Blue" must actually read blue (not grey), and
// every color-theme preset must apply a consistent, intentional chrome tint — no
// theme falls through to the near-neutral base :root background.

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8")

/** Parse an `oklch(L C H ...)` triple. Returns null if not an oklch() literal. */
function parseOklch(value: string): { l: number; c: number; h: number } | null {
  const m = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (!m) return null
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) }
}

/** Extract a light (non-`.dark`) `html[data-color-theme="X"]` block body. */
function lightBlock(theme: string): string {
  const re = new RegExp(`html\\[data-color-theme="${theme}"\\]\\s*\\{([^}]*)\\}`)
  const m = css.match(re)
  return m ? m[1] : ""
}

function token(block: string, name: string): { l: number; c: number; h: number } | null {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`))
  return m ? parseOklch(m[1].trim()) : null
}

describe("color theme presets (AQU-362)", () => {
  const themes = COLOR_THEMES.map((t) => t.id)

  it("defines every picker theme as an explicit CSS preset", () => {
    for (const t of themes) {
      expect(lightBlock(t), `missing html[data-color-theme="${t}"] block`).not.toBe("")
    }
  })

  it("gives every theme a tinted chrome background (none falls through to neutral base)", () => {
    for (const t of themes) {
      const bg = token(lightBlock(t), "background")
      expect(bg, `${t} has no --background`).not.toBeNull()
      // Base :root is near-neutral at chroma ~0.002; a real tint must clear that.
      expect(bg!.c, `${t} background is not tinted (chroma ${bg!.c})`).toBeGreaterThanOrEqual(0.006)
    }
  })

  it("makes 'Blue' actually read blue in both the chrome and the primary", () => {
    const block = lightBlock("blue")
    const bg = token(block, "background")!
    const primary = token(block, "primary")!
    // Blue hue band (cool blues sit ~220–280 in oklch).
    expect(bg.h).toBeGreaterThanOrEqual(220)
    expect(bg.h).toBeLessThanOrEqual(280)
    // Primary must carry enough chroma to read as blue, not the old grey (~0.07).
    expect(primary.c).toBeGreaterThanOrEqual(0.1)
    expect(primary.h).toBeGreaterThanOrEqual(220)
    expect(primary.h).toBeLessThanOrEqual(280)
  })

  it("uses a blue picker swatch that reads blue", () => {
    const blue = COLOR_THEMES.find((t) => t.id === "blue")!
    const swatch = parseOklch(blue.swatch)!
    expect(swatch.c).toBeGreaterThanOrEqual(0.1)
    expect(swatch.h).toBeGreaterThanOrEqual(220)
    expect(swatch.h).toBeLessThanOrEqual(280)
  })
})

describe("ColorThemeProvider default (AQU-362)", () => {
  afterEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute("data-color-theme")
  })

  it("sets data-color-theme='blue' by default rather than removing the attribute", () => {
    window.localStorage.clear()
    render(
      <ColorThemeProvider>
        <div />
      </ColorThemeProvider>,
    )
    // Regression: blue must resolve to the explicit tinted preset, not the
    // untinted base :root chrome (which is what removing the attribute did).
    expect(document.documentElement.getAttribute("data-color-theme")).toBe("blue")
  })
})
