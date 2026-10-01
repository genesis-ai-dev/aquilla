import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// tsconfig.node.json typechecks scripts/**/*.ts without allowJs, so a `.mjs`
// module is only typed through a sibling `.d.mts` (or `.mts`). Forgetting it
// fails `tsc -b`, which is the last step of scripts/ci-build.sh — the command
// behind the "Workers Builds: aquilla-web-preview" check — so dev goes red for
// every PR at once and the only signal is a TS7016 buried in a Cloudflare build
// log (AQU-1379 / AQU-1380). This names the missing file instead.
//
// A declaration that exists but has drifted from its `.mjs` breaks the same
// gate the same way, as a TS2305 on whichever test imports the new export
// (AQU-1398: `isReleaseBranch` was added to release-plan.mjs and imported by a
// test, but never declared). The second block compares the value exports of
// every `.mjs`/`.d.mts` pair so the drift is named at authoring time instead.

const SCRIPTS_DIR = import.meta.dirname
const MJS_IMPORT = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)\.mjs["']/g

function walk(dir: string, keep: (entry: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, keep))
    else if (keep(entry)) out.push(full)
  }
  return out.sort()
}

const typescriptSources = (dir: string) =>
  walk(dir, (entry) => /\.(?:ts|mts)$/.test(entry) && !entry.endsWith(".d.ts") && !entry.endsWith(".d.mts"))

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

/** Module paths (without extension) of every scripts/**\/*.d.mts. */
const declaredModules = () =>
  walk(SCRIPTS_DIR, (entry) => entry.endsWith(".d.mts")).map((file) => file.slice(0, -".d.mts".length))

const IDENT = "[A-Za-z_$][\\w$]*"
// `export function f`, `export async function f`, `export const X`, `export class C`
// — and, in a declaration file, the same behind `export declare`.
const NAMED_VALUE_EXPORT = new RegExp(
  `^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\s*\\*?|const|let|var|class|enum)\\s+(${IDENT})`,
  "gm",
)
// `export { a, b as c }`, including re-exports from another module; `type` specifiers are not values.
const BRACED_EXPORT = /^export\s*\{([^}]*)\}/gm
const DEFAULT_EXPORT = /^export\s+default\b/m
const STAR_EXPORT = /^export\s*\*/m

/** Names a `.mjs` exports at runtime, or that a `.d.mts` declares as values (types excluded). */
function valueExports(file: string): string[] {
  const source = readFileSync(file, "utf8")
  if (STAR_EXPORT.test(source)) {
    throw new Error(`${path.relative(SCRIPTS_DIR, file)} uses \`export *\`, which this scan cannot enumerate`)
  }
  const names = new Set<string>()
  for (const match of source.matchAll(NAMED_VALUE_EXPORT)) names.add(match[1])
  for (const match of source.matchAll(BRACED_EXPORT)) {
    for (const entry of match[1].split(",")) {
      const specifier = entry.trim()
      if (!specifier || specifier.startsWith("type ")) continue
      const parts = specifier.split(/\s+as\s+/)
      names.add(parts[parts.length - 1])
    }
  }
  if (DEFAULT_EXPORT.test(source)) names.add("default")
  return [...names].sort()
}

const relative = (file: string) => `scripts/${path.relative(SCRIPTS_DIR, file)}`

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

describe("scripts/*.d.mts declarations", () => {
  it("each describe a .mjs that still exists (a deleted script takes its declaration with it)", () => {
    const orphans = declaredModules()
      .filter((modulePath) => !existsSync(`${modulePath}.mjs`))
      .map((modulePath) => `${relative(modulePath)}.d.mts has no sibling .mjs`)
    expect(orphans).toEqual([])
  })

  it("declare exactly the value exports of their .mjs (an undeclared export is TS2305 for every importer, AQU-1398)", () => {
    const drift: string[] = []
    for (const modulePath of declaredModules()) {
      if (!existsSync(`${modulePath}.mjs`)) continue
      const runtime = valueExports(`${modulePath}.mjs`)
      const declared = valueExports(`${modulePath}.d.mts`)
      const name = relative(modulePath)
      for (const exported of runtime) {
        if (!declared.includes(exported)) drift.push(`${name}.mjs exports "${exported}" but ${name}.d.mts does not declare it`)
      }
      for (const exported of declared) {
        if (!runtime.includes(exported)) drift.push(`${name}.d.mts declares "${exported}" but ${name}.mjs does not export it`)
      }
    }
    expect(drift).toEqual([])
  })

  it("scan still sees the exports it exists to compare (a regex change must not turn this into a no-op)", () => {
    expect(valueExports(path.join(SCRIPTS_DIR, "release-plan.mjs"))).toContain("isReleaseBranch")
    expect(valueExports(path.join(SCRIPTS_DIR, "release-plan.d.mts"))).toContain("isReleaseBranch")
    // The braced re-export form (`export { X }`) must count too.
    expect(valueExports(path.join(SCRIPTS_DIR, "verify-worker-deployment.mjs"))).toContain("DEPLOYMENT_MANIFEST")
    expect(declaredModules().length).toBeGreaterThanOrEqual(10)
  })
})
