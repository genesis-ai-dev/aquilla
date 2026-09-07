// Safety gate for the public tree. Asserts ZERO matches for every forbidden
// pattern and ZERO existence for every forbidden path. Exits nonzero on any
// violation — publish.ts refuses to run unless this passes.
//
//   pnpm tsx scripts/public-release/verify-public-tree.ts --dir .public-build
//
// This is defense in depth on top of `git archive` (tracked-only) and the
// scrub. It does NOT replace `pnpm build` / `pnpm test` on the public tree —
// run those too before publishing.

import * as fs from "node:fs"
import * as path from "node:path"
import { FORBIDDEN_PATTERNS, FORBIDDEN_PATHS, ALLOWLIST } from "./config.ts"

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const dir = path.resolve(arg("dir", ".public-build")!)

function walk(root: string, rel = ""): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.name === ".git") continue
    if (e.isDirectory()) out.push(...walk(root, r))
    else out.push(r)
  }
  return out
}

function isText(abs: string): boolean {
  if (/\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|mp3|wav|mp4|pdf|wasm|bin|zip|gz|tar)$/i.test(abs)) return false
  try {
    return !fs.readFileSync(abs).subarray(0, 4096).includes(0)
  } catch {
    return false
  }
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ") // globstar placeholder
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
  return new RegExp(`^${re}(?:/.*)?$`)
}

const violations: string[] = []

// 1) Forbidden paths must not exist
const files = walk(dir)
for (const glob of FORBIDDEN_PATHS) {
  const re = globToRegExp(glob)
  for (const f of files) {
    if (re.test(f)) violations.push(`FORBIDDEN PATH  ${f}  (matches "${glob}")`)
  }
}

// 2) Forbidden patterns must not appear in any text file
for (const rel of files) {
  const abs = path.join(dir, rel)
  if (!isText(abs)) continue
  const allowedLabels = new Set(ALLOWLIST.filter((a) => a.file === rel).flatMap((a) => a.labels))
  const lines = fs.readFileSync(abs, "utf8").split("\n")
  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (allowedLabels.has(label)) continue
      if (pattern.test(lines[i])) {
        violations.push(`FORBIDDEN TEXT  ${rel}:${i + 1}  [${label}]  ${lines[i].trim().slice(0, 100)}`)
      }
    }
  }
}

if (violations.length) {
  console.error(`\n✗ SAFETY GATE FAILED — ${violations.length} violation(s):\n`)
  for (const v of violations.slice(0, 200)) console.error("  " + v)
  if (violations.length > 200) console.error(`  … and ${violations.length - 200} more`)
  console.error("\nPublish is blocked. Resolve every violation above.\n")
  process.exit(1)
}

console.log(`✓ safety gate passed — ${files.length} files scanned, 0 violations`)
