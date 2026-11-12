/**
 * Produce the open-source copy of this repo (AQU-1286).
 *
 * The public copy is an orphan snapshot of the *current state* — the full
 * history is ~1.7 GB and carries partner code in it, so it is deliberately not
 * exported. Everything under a folder named `partner-integrations` is left out,
 * which is the whole convention: see `docs/PARTNER-INTEGRATIONS.md`.
 *
 *   npx tsx scripts/make-public-copy.ts --out ../aquilla-public
 *
 * The copy is then scanned for partner copyright notices. Any hit fails the run
 * rather than being reported and ignored: shipping a publisher's copyright under
 * an open license is the exact outcome this script exists to prevent.
 */

import { cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

/** Folder name that marks partner-owned code, at any depth. */
export const PARTNER_DIRECTORY = "partner-integrations"

/**
 * Copyright notices belonging to a partner. These are the strings that must not
 * survive into the public copy; the partner's *name* on its own may legitimately
 * appear in neutral prose (a README saying which partners exist, a changelog).
 */
const COPYRIGHT_PATTERNS: readonly RegExp[] = [
  /copyright[^\n]{0,40}\bby\s+Biblica\b/i,
  /©[^\n]{0,40}\bBiblica\b/i,
  /\bBiblica,\s*Inc\b/i,
  /all rights reserved worldwide/i,
]

/** True when a repo-relative path sits inside any `partner-integrations` folder. */
export function isPartnerPath(repoRelativePath: string): boolean {
  return repoRelativePath.split(/[\\/]/).includes(PARTNER_DIRECTORY)
}

/** The tracked files that belong in the public copy. */
export function publicFiles(trackedPaths: readonly string[]): string[] {
  return trackedPaths.filter((path) => path.length > 0 && !isPartnerPath(path)).sort()
}

/** Partner copyright notices found in a file's text, deduplicated. */
export function findCopyrightNotices(text: string): string[] {
  const hits = new Set<string>()
  for (const pattern of COPYRIGHT_PATTERNS) {
    const match = pattern.exec(text)
    if (match) hits.add(match[0].trim())
  }
  return [...hits].sort()
}

function trackedFiles(repoRoot: string): string[] {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.split("\0").filter((path) => path.length > 0)
}

function isProbablyText(bytes: Buffer): boolean {
  // A NUL byte in the first few KB is the usual "this is a binary" tell, and
  // scanning a .idml or a .png for prose only produces noise.
  return !bytes.subarray(0, 8192).includes(0)
}

/**
 * This script and its test spell the notices out — as the patterns themselves and
 * as the fixtures proving they match — so scanning them would always "find" a
 * partner copyright. They are the detector, not a partner's code, so they are the
 * one thing the detector does not read. Nothing else is exempt.
 */
const SCANNER_SOURCES: ReadonlySet<string> = new Set([
  "scripts/make-public-copy.ts",
  "scripts/make-public-copy.test.ts",
])

export interface CopyrightHit {
  file: string
  notices: string[]
}

/** Scan an already-built copy for partner copyright notices. */
export function scanForCopyright(root: string, files: readonly string[]): CopyrightHit[] {
  const hits: CopyrightHit[] = []
  for (const file of files) {
    if (SCANNER_SOURCES.has(file)) continue
    const path = join(root, file)
    // A tracked symlink points at a directory in this repo; reading through it
    // would fail rather than tell us anything about the copy's contents.
    if (lstatSync(path).isSymbolicLink()) continue
    const bytes = readFileSync(path)
    if (!isProbablyText(bytes)) continue
    const notices = findCopyrightNotices(bytes.toString("utf8"))
    if (notices.length > 0) hits.push({ file, notices })
  }
  return hits
}

function build(repoRoot: string, outDir: string): { files: string[]; excluded: number } {
  const tracked = trackedFiles(repoRoot)
  const files = publicFiles(tracked)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const file of files) {
    const from = join(repoRoot, file)
    // A tracked path can be absent from the worktree mid-rebase; skip rather
    // than abort, and let the count in the summary show it.
    let stats
    try {
      stats = lstatSync(from)
    } catch {
      continue
    }
    const to = join(outDir, file)
    mkdirSync(dirname(to), { recursive: true })
    if (stats.isSymbolicLink()) {
      // Tracked symlinks (the `.claude/skills/*` links point at directories)
      // are reproduced as links. Copying through them would either fail with
      // EISDIR or inline whatever they happen to resolve to on this machine.
      symlinkSync(readlinkSync(from), to)
      continue
    }
    cpSync(from, to)
  }
  return { files, excluded: tracked.length - files.length }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf("--out")
  const outDir = resolve(
    process.cwd(),
    outIndex >= 0 ? args[outIndex + 1] ?? "" : `..${sep}aquilla-public`,
  )
  const repoRoot = resolve(import.meta.dirname, "..")

  const { files, excluded } = build(repoRoot, outDir)
  console.log(
    `[make-public-copy] ${files.length} files → ${outDir} `
    + `(${excluded} partner files excluded)`,
  )

  const hits = scanForCopyright(outDir, files)
  if (hits.length > 0) {
    for (const hit of hits) {
      console.error(`[make-public-copy] partner copyright in ${hit.file}: ${hit.notices.join(" | ")}`)
    }
    console.error(
      `[make-public-copy] FAILED — ${hits.length} file(s) carry a partner copyright notice. `
      + "Move the code into a partner-integrations folder before publishing.",
    )
    process.exitCode = 1
  } else {
    console.log("[make-public-copy] no partner copyright notices in the public copy")
  }
}
