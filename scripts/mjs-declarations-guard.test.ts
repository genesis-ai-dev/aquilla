import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// tsconfig.node.json typechecks scripts/**/*.ts without allowJs, so a `.mjs`
// module is only typed through a sibling `.d.mts` (or `.mts`). Forgetting it
// fails `tsc -b`, which is the last step of scripts/ci-build.sh — the command
// behind the "Workers Builds: aquilla-web-preview" check — so dev goes red for
// every PR at once and the only signal is a TS7016 buried in a Cloudflare build
// log (AQU-1379 / AQU-1380). This names the missing file instead.

const SCRIPTS_DIR = import.meta.dirname
const MJS_IMPORT = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)\.mjs["']/g

function typescriptSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...typescriptSources(full))
    else if (/\.(?:ts|mts)$/.test(entry) && !entry.endsWith(".d.ts") && !entry.endsWith(".d.mts")) out.push(full)
  }
  return out.sort()
}

interface MjsImport {
  importer: string
  module: string
}

function mjsImports(): MjsImport[] {
  const found: MjsImport[] = []
  for (const file of typescriptSources(SCRIPTS_DIR)) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(MJS_IMPORT)) {
      found.push({ importer: file, module: path.resolve(path.dirname(file), match[1]) })
    }
  }
  return found
}

const hasDeclaration = (module: string) => existsSync(`${module}.d.mts`) || existsSync(`${module}.mts`)

describe("scripts/*.mjs imported from TypeScript", () => {
  it("each ship a sibling .d.mts so tsc -b (the preview build gate) can type them", () => {
    const missing = mjsImports()
      .filter(({ module }) => !hasDeclaration(module))
      .map(({ importer, module }) => `${path.relative(SCRIPTS_DIR, importer)} imports ./${path.basename(module)}.mjs but scripts/${path.basename(module)}.d.mts does not exist`)
    expect(missing).toEqual([])
  })

  it("scan still sees the existing .mjs imports (a regex or layout change must not turn this into a no-op)", () => {
    const modules = new Set(mjsImports().map(({ module }) => path.basename(module)))
    expect(modules).toContain("release-plan")
    expect(modules).toContain("tag-metadata")
    expect(modules.size).toBeGreaterThanOrEqual(10)
  })
})
