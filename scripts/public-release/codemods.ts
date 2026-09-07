// Codemods applied to the staged public tree. Each returns the number of edits
// it made so the build log is auditable. Keep these small and deterministic;
// the safety gate (verify-public-tree.ts) and `pnpm build` are the backstop.

import * as fs from "node:fs"
import * as path from "node:path"

type Codemod = (root: string) => number

/** Narrow the BrandId union in src/branding/types.ts to the public brands.
 *  Preserves the rest of types.ts (ThemeTokens/BrandData/Brand) exactly. */
const narrowBrandIdUnion: Codemod = (root) => {
  const file = path.join(root, "src/branding/types.ts")
  if (!fs.existsSync(file)) throw new Error("narrowBrandIdUnion: src/branding/types.ts not found")
  const src = fs.readFileSync(file, "utf8")
  const re = /export type BrandId = [^\n]*/
  if (!re.test(src)) throw new Error("narrowBrandIdUnion: BrandId union line not found — types.ts shape changed")
  const out = src.replace(re, 'export type BrandId = "aquilla" | "acme"')
  if (out === src) return 0
  fs.writeFileSync(file, out)
  return 1
}

const CODEMODS: Record<string, Codemod> = {
  narrowBrandIdUnion,
}

export function runCodemod(name: string, root: string): number {
  const fn = CODEMODS[name]
  if (!fn) throw new Error(`Unknown codemod: ${name}`)
  return fn(root)
}
