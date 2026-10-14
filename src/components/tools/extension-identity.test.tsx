/**
 * AQU-1937: Smart Extensions' visual identity is host-drawn and reserved.
 *   - every VISIBLE extension iframe is mounted inside ExtensionFrame (the only
 *     sandboxed iframes outside it are the off-screen headless and smoke frames);
 *   - the reserved --extension-accent token appears only in ExtensionFrame,
 *     ExtensionMarker and its CSS definition — never forwarded into frames;
 *   - ExtensionFrame draws the full and quiet variants with icon + name + label.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { THEME_VARS, readThemeVars } from "@/lib/tools/srcdoc"
import { ExtensionFrame } from "./ExtensionFrame"
import { ExtensionMarker } from "./ExtensionMarker"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}
const SOURCES = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "shared"))]
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/")

describe("every visible extension mount is framed", () => {
  it("each component that mounts a sandboxed tool iframe wraps it in ExtensionFrame, or keeps it off-screen", () => {
    const mounting = SOURCES.filter((p) => p.endsWith(".tsx") && /sandbox=\{TOOL_SANDBOX\}|setAttribute\("sandbox", TOOL_SANDBOX\)/.test(readFileSync(p, "utf8")))
    expect(mounting.map(rel).sort()).toEqual([
      "src/components/tools/HeadlessRuns.tsx",
      "src/components/tools/ToolFrame.tsx",
      "src/components/tools/builder/ExtensionPreview.tsx",
    ])
    for (const p of mounting) {
      const src = readFileSync(p, "utf8")
      if (rel(p).endsWith("HeadlessRuns.tsx")) expect(src, "headless frames stay off-screen").toMatch(/left: "-10000px"/)
      else expect(src, `${rel(p)} must render <ExtensionFrame>`).toMatch(/<ExtensionFrame\b/)
    }
  })
})

describe("the reserved identity color", () => {
  it("is used only by ExtensionFrame, ExtensionMarker and its own definition", () => {
    const users = SOURCES.filter((p) => readFileSync(p, "utf8").includes("--extension-accent")).map(rel).sort()
    expect(users).toEqual([
      "src/components/tools/ExtensionFrame.tsx",
      "src/components/tools/ExtensionMarker.tsx",
      "src/index.css",
    ])
  })

  it("is never forwarded into an extension frame", () => {
    expect(THEME_VARS.some((v) => v.includes("extension"))).toBe(false)
    document.documentElement.style.setProperty("--extension-accent", "red")
    expect(Object.keys(readThemeVars()).some((k) => k.includes("extension"))).toBe(false)
  })
})

describe("ExtensionFrame and ExtensionMarker", () => {
  it("draws the full frame with the icon, name and label, linking to the extension's page", () => {
    render(
      <MemoryRouter>
        <ExtensionFrame name="Glossary" href="/project/p/extensions/t">
          <iframe title="x" />
        </ExtensionFrame>
      </MemoryRouter>,
    )
    const frame = screen.getByTestId("extension-frame")
    expect(frame.dataset.extensionFrame).toBe("full")
    const tab = screen.getByTestId("extension-frame-tab")
    expect(tab.textContent).toContain("Glossary")
    expect(tab.textContent).toContain("Smart Extension")
    expect(tab.getAttribute("href")).toBe("/project/p/extensions/t")
    expect(tab.querySelector("svg")).not.toBeNull()
    expect(frame.querySelector("iframe")).not.toBeNull()
  })

  it("draws the quiet variant for the default editor", () => {
    render(
      <MemoryRouter>
        <ExtensionFrame name="Aquilla editor (Smart Extension)" variant="quiet">
          <div />
        </ExtensionFrame>
      </MemoryRouter>,
    )
    expect(screen.getByTestId("extension-frame").dataset.extensionFrame).toBe("quiet")
    expect(screen.getByTestId("extension-frame-tab").textContent).toContain("Smart Extension")
  })

  it("never marks with color alone: the marker carries the icon and a label", () => {
    const { container } = render(<ExtensionMarker />)
    expect(container.textContent).toContain("Smart Extension")
    expect(container.querySelector("svg")).not.toBeNull()
    const iconOnly = render(<ExtensionMarker iconOnly />).container.querySelector("[data-extension-marker]")
    expect(iconOnly?.getAttribute("aria-label")).toBe("Smart Extension")
  })
})
