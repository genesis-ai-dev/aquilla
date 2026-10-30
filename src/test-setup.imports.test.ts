// @vitest-environment node
/**
 * src/test-setup.ts runs before each test file, so every module it imports is
 * evaluated before that file's `vi.mock()` calls take effect, and a module
 * reached that way keeps its real imports for the whole file. On PR #1713
 * test-setup imported person-prefs, whose graph reaches frontier/elevation and
 * bound the real session store before sync-token.test.ts could mock it; the
 * four OPS-44 step-up tests went red with nothing in their own files changed.
 *
 * So test-setup may import only leaf modules from "@/lib". A reset for a module
 * that has app imports of its own goes through a zero-import seam the module
 * registers into as it loads, as person-prefs-reset.ts does.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC_DIR = fileURLToPath(new URL("./", import.meta.url))

/** Specifiers of the imports that survive type erasure. */
function runtimeImports(source: string): string[] {
  const out: string[] = []
  const re = /^import\s+((?:(?!^import)[\s\S])*?)from\s+["']([^"']+)["']/gm
  for (const m of source.matchAll(re)) {
    const clause = m[1].trim()
    if (clause.startsWith("type ")) continue
    const named = clause.match(/\{([\s\S]*)\}/)?.[1]
    if (named !== undefined) {
      const values = named
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "" && !s.startsWith("type "))
      const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim()
      if (values.length === 0 && outside === "") continue
    }
    out.push(m[2])
  }
  return out
}

function resolveAppImport(specifier: string): string {
  const base = join(SRC_DIR, specifier.slice("@/".length))
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`cannot resolve ${specifier} under src/`)
}

describe("src/test-setup.ts imports from @/lib", () => {
  const setup = readFileSync(join(SRC_DIR, "test-setup.ts"), "utf8")
  const libImports = runtimeImports(setup).filter((s) => s.startsWith("@/lib/"))

  it("reaches the app through at least one @/lib module, so the rule below checks something", () => {
    expect(libImports.length).toBeGreaterThan(0)
  })

  it.each(libImports)("%s is a leaf: no runtime import of its own from the app", (specifier) => {
    const source = readFileSync(resolveAppImport(specifier), "utf8")
    const appImports = runtimeImports(source).filter((s) => s.startsWith("@/") || s.startsWith("."))
    expect(
      appImports,
      `${specifier} imports ${appImports.join(", ")}, which test-setup would evaluate before ` +
        `a test file's vi.mock() calls. Reset it through a zero-import seam instead ` +
        `(see src/lib/prefs/person-prefs-reset.ts).`,
    ).toEqual([])
  })
})
