// AQU-2090: translator notes stay out of the browser build.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { stripNamespaceContext } from "./vite-strip-i18n-context"

const SAMPLE = `import { defineNamespace, plural } from "./types"

export const sample = defineNamespace({
  keys: {
    "sample.save": "Save",
    "sample.count": plural({ one: "{count} file", other: "{count} files" }, "count"),
  },
  context: {
    _context: { description: "Sample namespace", screenshot: "sample-shot" },
    keys: {
      "sample.save": { description: "Button that saves the file.", maxLength: 12 },
      "sample.count": { description: "How many files.", placeholders: { count: "A number." } },
    },
  },
  surfaces: [{ id: "sample-shot", title: "Sample", route: "/x", notes: "Look here." }],
})
`

describe("stripNamespaceContext", () => {
  it("keeps every string and empties the translator notes and screenshot surfaces", () => {
    const out = stripNamespaceContext(SAMPLE)
    expect(out).toContain('"sample.save": "Save"')
    expect(out).toContain('plural({ one: "{count} file", other: "{count} files" }, "count")')
    expect(out).toContain('context: { _context: { description: "" } }')
    expect(out).toContain("surfaces: []")
    expect(out).not.toContain("Button that saves the file.")
    expect(out).not.toContain("Look here.")
  })

  it("leaves a module with no defineNamespace call alone", () => {
    const code = 'export const x = { context: "keep" }\n'
    expect(stripNamespaceContext(code)).toBe(code)
  })

  it("shrinks a real namespace module and keeps it valid", () => {
    const real = readFileSync(resolve(import.meta.dirname, "../src/lib/i18n/namespaces/projectSettings.ts"), "utf8")
    const out = stripNamespaceContext(real)
    expect(out.length).toBeLessThan(real.length * 0.8)
    expect(out).toContain('"projectSettings.monday.wizardBoardTitle": "Which board?"')
    expect(out).not.toContain("Title of step 1 of the Monday.com setup")
  })
})
