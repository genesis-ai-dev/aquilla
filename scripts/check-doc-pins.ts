/**
 * Doc-pin guard (AQU-2387).
 *
 * A *pin* is an inline code span in a Markdown doc that names a repo-root
 * relative file — `src/lib/import.ts` — optionally with an exported symbol
 * after `::` — `src/lib/import.ts::importFiles`. Pins never carry line
 * numbers, so they survive edits that move code around; this script proves
 * every pin still resolves, so a rename cannot quietly leave the docs lying.
 *
 * Scope, deliberately two-tier (see `docs/decisions/INDEX.md`):
 *
 *  - **strict** — every path-shaped span in a doc under `docs/decisions/`, or
 *    in any doc carrying the `<!-- doc-pins: strict -->` marker, is a pin and
 *    must resolve. New architecture claims live here.
 *  - **scoped** — in every other doc (every Markdown file under `docs/`, `CLAUDE.md`,
 *    `AGENTS.md`), only the `path::symbol` form is a pin. The repo's older
 *    docs quote plenty of paths that are deliberately stale (`CLAUDE.md` lists
 *    the abandoned layouts by name), so a flag day over the whole tree would
 *    only teach everyone to ignore this check.
 *
 * A doc opts out entirely with `<!-- doc-pins: off -->`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface DocPin {
  /** Repo-relative path of the doc the pin was read from. */
  readonly doc: string
  /** 1-based line number of the pin inside that doc. */
  readonly line: number
  /** The span as written, without its backticks. */
  readonly raw: string
  /** Repo-relative path the pin names. A trailing `/` means a directory. */
  readonly target: string
  /** Exported symbol the pin names, or `null` for a whole-file pin. */
  readonly symbol: string | null
}

export interface PinFailure {
  readonly pin: DocPin
  readonly reason: string
}

/** Extensions a path-shaped span must carry to be read as a pin. */
const PIN_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "sql",
  "md",
  "py",
  "rs",
  "sh",
  "yml",
  "yaml",
  "toml",
  "css",
  "html",
])

/** Extensions whose exported symbols this script can resolve. */
const SYMBOL_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "sql"])

const PIN_SPAN = /^([A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+\/?)(?:::([A-Za-z_$][A-Za-z0-9_$]*))?$/
const INLINE_SPAN = /`([^`\n]+)`/g
const OFF_MARKER = "<!-- doc-pins: off -->"
const STRICT_MARKER = "<!-- doc-pins: strict -->"
const STRICT_DIR = "docs/decisions/"

const extensionOf = (target: string): string => {
  const base = target.slice(target.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase()
}

/** Blank out fenced code blocks, keeping the line count so numbers stay true. */
export function stripFencedBlocks(markdown: string): string {
  let fence: string | null = null
  return markdown
    .split("\n")
    .map((line) => {
      const opener = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fence === null) {
        if (opener) {
          fence = opener[1].slice(0, 3)
          return ""
        }
        return line
      }
      if (opener && opener[1].startsWith(fence)) fence = null
      return ""
    })
    .join("\n")
}

/**
 * Read every pin out of one doc. `strict` decides whether a bare path span
 * counts as a pin, or only the `path::symbol` form does.
 */
export function extractPins(doc: string, markdown: string, strict: boolean): DocPin[] {
  const lines = stripFencedBlocks(markdown).split("\n")
  // A marker counts only as a line of its own, so a doc can quote one — this
  // folder's own INDEX.md documents both — without switching itself off.
  const declares = (marker: string): boolean => lines.some((line) => line.trim() === marker)
  if (declares(OFF_MARKER)) return []
  const effectiveStrict = strict || declares(STRICT_MARKER)
  const pins: DocPin[] = []
  lines.forEach((line, index) => {
    for (const match of line.matchAll(INLINE_SPAN)) {
      const raw = match[1]
      const parsed = PIN_SPAN.exec(raw)
      if (!parsed) continue
      const target = parsed[1]
      const symbol = parsed[2] ?? null
      if (!symbol && !effectiveStrict) continue
      const isDirectory = target.endsWith("/")
      if (isDirectory && (!effectiveStrict || symbol)) continue
      if (!isDirectory && !PIN_EXTENSIONS.has(extensionOf(target))) continue
      pins.push({ doc, line: index + 1, raw, target, symbol })
    }
  })
  return pins
}

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Does `source` export `symbol`? Declarations, export blocks and `export * as`. */
export function exportsSymbol(source: string, symbol: string, extension: string): boolean {
  const name = escapeForRegExp(symbol)
  if (extension === "sql") {
    const ddl = new RegExp(
      `create\\s+(?:or\\s+replace\\s+)?(?:materialized\\s+view|table|view|index|type|function|trigger)\\s+(?:if\\s+not\\s+exists\\s+)?"?(?:public\\.)?${name}"?\\b`,
      "i",
    )
    return ddl.test(source)
  }
  const declaration = new RegExp(
    `export\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|type|interface|enum|namespace)\\s+${name}\\b`,
  )
  if (declaration.test(source)) return true
  if (new RegExp(`export\\s+\\*\\s+as\\s+${name}\\b`).test(source)) return true
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}/g)) {
    for (const entry of block[1].split(",")) {
      const parts = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)
      const exported = parts[parts.length - 1]?.trim().replace(/^["']|["']$/g, "")
      if (exported === symbol) return true
    }
  }
  return false
}

/** Resolve one pin against the tree. Returns a reason on failure. */
export function resolvePin(root: string, pin: DocPin): string | null {
  // Stat without the trailing slash: a slashed path to a file raises ENOTDIR,
  // which would report a missing directory instead of the real mistake.
  const absolute = path.join(root, pin.target.replace(/\/$/, ""))
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(absolute)
  } catch {
    return pin.target.endsWith("/") ? "no such directory" : "no such file"
  }
  if (pin.target.endsWith("/")) {
    return stats.isDirectory() ? null : "pinned as a directory but is a file"
  }
  if (!stats.isFile()) return "not a file"
  if (!pin.symbol) return null
  const extension = extensionOf(pin.target)
  if (!SYMBOL_EXTENSIONS.has(extension)) {
    return `cannot resolve symbols in a .${extension} file — pin the file alone`
  }
  if (exportsSymbol(readFileSync(absolute, "utf8"), pin.symbol, extension)) return null
  return extension === "sql"
    ? `no such table, view or routine: ${pin.symbol}`
    : `file exports no \`${pin.symbol}\``
}

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"])

/** Every doc the guard reads: every Markdown file under `docs/`, plus `CLAUDE.md` and `AGENTS.md`. */
export function collectDocs(root: string): string[] {
  const docs: string[] = []
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        walk(path.posix.join(relativeDir, entry.name))
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        docs.push(path.posix.join(relativeDir, entry.name))
      }
    }
  }
  try {
    walk("docs")
  } catch {
    /* a tree without docs/ has nothing to check */
  }
  for (const top of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      if (statSync(path.join(root, top)).isFile()) docs.push(top)
    } catch {
      /* optional */
    }
  }
  return docs.sort()
}

export interface PinReport {
  readonly docs: number
  readonly pins: number
  readonly failures: readonly PinFailure[]
}

export function checkDocPins(root: string): PinReport {
  const docs = collectDocs(root)
  const failures: PinFailure[] = []
  let pinCount = 0
  for (const doc of docs) {
    const markdown = readFileSync(path.join(root, doc), "utf8")
    for (const pin of extractPins(doc, markdown, doc.startsWith(STRICT_DIR))) {
      pinCount += 1
      const reason = resolvePin(root, pin)
      if (reason) failures.push({ pin, reason })
    }
  }
  return { docs: docs.length, pins: pinCount, failures }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function main(): void {
  const report = checkDocPins(repoRoot)
  if (report.failures.length === 0) {
    console.log(`✓ ${report.pins} doc pins resolve across ${report.docs} docs`)
    return
  }
  for (const { pin, reason } of report.failures) {
    console.error(`✗ ${pin.doc}:${pin.line}  \`${pin.raw}\` — ${reason}`)
  }
  console.error(
    `\nFAIL — ${report.failures.length} of ${report.pins} doc pins no longer resolve.` +
      `\nUpdate the pin (or the doc's claim) — see docs/decisions/INDEX.md for the pin syntax.`,
  )
  process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
